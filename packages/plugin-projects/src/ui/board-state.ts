import type { Task, TaskColumn } from "@kanbaner/plugin-tasks/contract";

/** Размер страницы одной колонки. */
export const KANBAN_PAGE_SIZE = 10;

/** Данные одной фактической колонки проекта. */
export interface KanbanColumnData {
  readonly column: TaskColumn;
  readonly items: readonly Task[];
  readonly total: number;
  readonly nextOffset: number | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Колонки доски в фактическом порядке `column.list`.
 *
 * `order` хранит ID в порядке `position asc`, `id asc`; `byId` — данные
 * конкретной колонки. Фиксированного набора статусов здесь нет.
 */
export interface KanbanColumns {
  readonly order: readonly string[];
  readonly byId: Readonly<Record<string, KanbanColumnData>>;
}

export interface Placement {
  readonly columnId: string;
  /** Карточка, перед которой нужно вставить задачу; `null` — в конец. */
  readonly beforeId: string | null;
}

export function createEmptyColumns(): KanbanColumns {
  return { order: [], byId: {} };
}

export function createEmptyColumn(column: TaskColumn): KanbanColumnData {
  return { column, items: [], total: 0, nextOffset: null, loading: true, error: null };
}

/** Безопасный доступ к колонке: `noUncheckedIndexedAccess` не теряет тип. */
export function getColumn(columns: KanbanColumns, columnId: string): KanbanColumnData | null {
  return columns.byId[columnId] ?? null;
}

export function getColumns(columns: KanbanColumns): readonly KanbanColumnData[] {
  const result: KanbanColumnData[] = [];

  for (const columnId of columns.order) {
    const data = columns.byId[columnId];

    if (data !== undefined) {
      result.push(data);
    }
  }

  return result;
}

/**
 * Собирает доску из фактических колонок, сохраняя уже загруженные данные.
 *
 * Новые колонки получают пустую страницу в состоянии загрузки; исчезнувшие
 * удаляются из порядка и словаря.
 */
export function syncColumns(current: KanbanColumns, columns: readonly TaskColumn[]): KanbanColumns {
  const order = columns.map((column) => column.id);
  const byId: Record<string, KanbanColumnData> = {};

  for (const column of columns) {
    const existing = current.byId[column.id];

    byId[column.id] = existing === undefined ? createEmptyColumn(column) : { ...existing, column };
  }

  return { order, byId };
}

/** Оптимистично переставляет колонку на целевой индекс итогового порядка. */
export function reorderKanbanColumns(
  columns: KanbanColumns,
  columnId: string,
  targetIndex: number,
): KanbanColumns {
  const currentIndex = columns.order.indexOf(columnId);

  if (currentIndex === -1) {
    return columns;
  }

  const order = columns.order.filter((id) => id !== columnId);
  const index = Math.max(0, Math.min(targetIndex, order.length));

  order.splice(index, 0, columnId);

  return { order, byId: columns.byId };
}

/** Восстанавливает снимок порядка, сохраняя актуальный byId. */
export function restoreColumnOrder(
  columns: KanbanColumns,
  snapshot: readonly string[],
): KanbanColumns {
  const order: string[] = [];

  for (const id of snapshot) {
    if (columns.byId[id] !== undefined) {
      order.push(id);
    }
  }

  for (const id of columns.order) {
    if (!order.includes(id)) {
      order.push(id);
    }
  }

  return { order, byId: columns.byId };
}

/** Убирает колонку из отображения после успешного удаления. */
export function withoutColumn(columns: KanbanColumns, columnId: string): KanbanColumns {
  if (!columns.order.includes(columnId)) {
    return columns;
  }

  const byId = Object.fromEntries(
    Object.entries(columns.byId).filter(([id]) => id !== columnId),
  ) as KanbanColumns["byId"];

  return { order: columns.order.filter((id) => id !== columnId), byId };
}

function findTask(columns: KanbanColumns, taskId: string): Task | null {
  for (const column of getColumns(columns)) {
    const task = column.items.find((item) => item.id === taskId);

    if (task !== undefined) {
      return task;
    }
  }

  return null;
}

/** Колонка, в которой сейчас отображается задача. */
export function columnContainingTask(columns: KanbanColumns, taskId: string): string | null {
  for (const column of getColumns(columns)) {
    if (column.items.some((task) => task.id === taskId)) {
      return column.column.id;
    }
  }

  return null;
}

/**
 * Накладывает оптимистичные перемещения на серверные колонки.
 *
 * Серверные данные и версии не изменяются: перемещённые карточки только
 * переставляются в отображении, пока команда не завершится и доска не будет
 * перечитана. Поэтому одновременные мутации разных карточек не блокируют
 * друг друга.
 */
export function applyPlacements(
  columns: KanbanColumns,
  placements: ReadonlyMap<string, Placement>,
): KanbanColumns {
  if (placements.size === 0) {
    return columns;
  }

  const movedIds = new Set(placements.keys());
  const movedTasks = new Map<string, Task>();

  for (const taskId of movedIds) {
    const task = findTask(columns, taskId);

    if (task !== null) {
      movedTasks.set(taskId, task);
    }
  }

  const items: Record<string, Task[]> = {};
  const byId: Record<string, KanbanColumnData> = {};

  for (const columnId of columns.order) {
    const current = columns.byId[columnId];

    if (current === undefined) {
      continue;
    }

    const source = [...current.items];
    const removed = source.filter((task) => movedIds.has(task.id)).length;
    const remaining = source.filter((task) => !movedIds.has(task.id));

    items[columnId] = remaining;
    byId[columnId] = {
      ...current,
      items: remaining,
      total: Math.max(0, current.total - removed),
    };
  }

  for (const [taskId, placement] of placements) {
    const task = movedTasks.get(taskId);

    if (task === undefined) {
      continue;
    }

    const target = items[placement.columnId];

    if (target === undefined) {
      continue;
    }

    const foundIndex =
      placement.beforeId === null
        ? target.length
        : target.findIndex((candidate) => candidate.id === placement.beforeId);
    const insertion = foundIndex === -1 ? target.length : foundIndex;
    const targetData = byId[placement.columnId];

    if (targetData === undefined) {
      continue;
    }

    target.splice(insertion, 0, task);
    byId[placement.columnId] = {
      ...targetData,
      items: target,
      total: targetData.total + 1,
    };
  }

  return { order: columns.order, byId };
}

/**
 * Намерение перемещения, независимое от видимого (отфильтрованного или
 * постраничного) списка карточек.
 *
 * Позиция команды вычисляется по полному scope `(projectId, columnId)`,
 * поэтому скрытый фильтром сосед не сдвигает индекс.
 */
export type MoveIntent =
  | { readonly kind: "append" }
  | { readonly kind: "start" }
  | { readonly kind: "before"; readonly beforeId: string };

/**
 * Позиция для `task.move` по полному упорядоченному списку scope.
 *
 * `tasks` — все задачи целевой колонки без UI-фильтров и пагинации.
 * Перемещаемая карточка исключается: `append` равен реальной длине остальных,
 * `beforeId` — индексу в этом же полном списке.
 */
export function resolveMovePosition(
  tasks: readonly Task[],
  taskId: string,
  intent: MoveIntent,
): number {
  const others = tasks.filter((task) => task.id !== taskId);

  switch (intent.kind) {
    case "append":
      return others.length;
    case "start":
      return 0;
    case "before": {
      const index = others.findIndex((task) => task.id === intent.beforeId);

      return index === -1 ? others.length : index;
    }
  }
}

/**
 * Переводит optimistic placement в намерение для полного scope.
 *
 * Действия «Выше»/«Ниже» относятся к видимому порядку: после вставки берётся
 * следующая видимая карточка. Её ID становится anchor-ом для `before`, а
 * отсутствие следующей означает `append`.
 */
export function visibleMoveIntent(
  items: readonly Task[],
  taskId: string,
  placement: Placement,
): MoveIntent {
  const rest = items.filter((task) => task.id !== taskId);
  const insertion =
    placement.beforeId === null
      ? rest.length
      : rest.findIndex((task) => task.id === placement.beforeId);
  const next = insertion === -1 ? undefined : rest[insertion];

  return next === undefined ? { kind: "append" } : { kind: "before", beforeId: next.id };
}

/** Строит placement для целевого индекса внутри колонки. */
export function placementForIndex(
  columnId: string,
  items: readonly Task[],
  taskId: string,
  targetIndex: number,
): Placement {
  const rest = items.filter((task) => task.id !== taskId);
  const index = Math.max(0, Math.min(targetIndex, rest.length));

  return { columnId, beforeId: rest[index]?.id ?? null };
}

const STATUS_SLUGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-legacy-backlog$/u, "backlog"],
  [/-legacy-todo$/u, "todo"],
  [/-legacy-in_progress$/u, "in_progress"],
  [/-legacy-done$/u, "done"],
  [/-in-progress$/u, "in_progress"],
  [/-todo$/u, "todo"],
  [/-done$/u, "done"],
];

/**
 * Безопасный суффикс test ID для колонки.
 *
 * Канонические default/legacy-колонки сохраняют прежние статусные суффиксы
 * (`todo`, `in_progress`, `done`, `backlog`), а пользовательские колонки
 * получают суффикс из собственного ID. ID не попадает в CSS-селектор
 * дословно: небезопасные символы заменяются на `-`.
 */
export function columnTestSlug(column: Pick<TaskColumn, "id">): string {
  for (const [pattern, slug] of STATUS_SLUGS) {
    if (pattern.test(column.id)) {
      return slug;
    }
  }

  return `column-${column.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

/** Колонка по умолчанию для создания карточки: первая открытая. */
export function defaultCreateColumnId(columns: readonly TaskColumn[]): string | null {
  return columns.find((column) => column.status !== "done")?.id ?? columns[0]?.id ?? null;
}

/** Фактическая колонка задачи с учётом legacy-документов без `columnId`. */
export function effectiveColumnId(task: Task, columns: readonly TaskColumn[]): string | null {
  if (task.columnId !== undefined && columns.some((column) => column.id === task.columnId)) {
    return task.columnId;
  }

  return columns.find((column) => column.status === task.status)?.id ?? columns[0]?.id ?? null;
}

/** Колонка того же типа, что и указанная, либо первая другая. */
export function defaultDeleteTargetColumn(
  columns: readonly TaskColumn[],
  sourceId: string,
): string | null {
  const source = columns.find((column) => column.id === sourceId);

  if (source === undefined) {
    return null;
  }

  const sameType = columns.find(
    (column) => column.id !== sourceId && column.status === source.status,
  );

  return sameType?.id ?? columns.find((column) => column.id !== sourceId)?.id ?? null;
}

/** Осталась ли колонка последней открытой или последней Done в проекте. */
export function isLastColumnOfType(columns: readonly TaskColumn[], columnId: string): boolean {
  const source = columns.find((column) => column.id === columnId);

  if (source === undefined) {
    return false;
  }

  return !columns.some(
    (column) => column.id !== columnId && (column.status === "done") === (source.status === "done"),
  );
}
