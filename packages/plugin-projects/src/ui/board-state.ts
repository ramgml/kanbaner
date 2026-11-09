import type { Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";

/** Размер страницы одной колонки. */
export const KANBAN_PAGE_SIZE = 10;

export const KANBAN_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "done"];

export interface KanbanColumnData {
  readonly items: readonly Task[];
  readonly total: number;
  readonly nextOffset: number | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export type KanbanColumns = Readonly<Record<TaskStatus, KanbanColumnData>>;

export interface Placement {
  readonly status: TaskStatus;
  /** Карточка, перед которой нужно вставить задачу; `null` — в конец. */
  readonly beforeId: string | null;
}

export function createEmptyColumn(): KanbanColumnData {
  return { items: [], total: 0, nextOffset: null, loading: true, error: null };
}

export function createEmptyColumns(): KanbanColumns {
  return {
    backlog: createEmptyColumn(),
    todo: createEmptyColumn(),
    in_progress: createEmptyColumn(),
    done: createEmptyColumn(),
  };
}

/** Безопасный доступ к колонке: `noUncheckedIndexedAccess` не теряет тип. */
export function getColumn(columns: KanbanColumns, status: TaskStatus): KanbanColumnData {
  return columns[status] ?? createEmptyColumn();
}

const columnOf = getColumn;

function findTask(columns: KanbanColumns, taskId: string): Task | null {
  for (const status of KANBAN_STATUSES) {
    const task = columnOf(columns, status).items.find((item) => item.id === taskId);

    if (task !== undefined) {
      return task;
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

  const next: Record<TaskStatus, KanbanColumnData> = {
    backlog: columnOf(columns, "backlog"),
    todo: columnOf(columns, "todo"),
    in_progress: columnOf(columns, "in_progress"),
    done: columnOf(columns, "done"),
  };
  const items: Record<TaskStatus, Task[]> = {
    backlog: [...columnOf(columns, "backlog").items],
    todo: [...columnOf(columns, "todo").items],
    in_progress: [...columnOf(columns, "in_progress").items],
    done: [...columnOf(columns, "done").items],
  };

  for (const status of KANBAN_STATUSES) {
    const current = columnOf(columns, status);
    const source = items[status] ?? [];
    const removed = source.filter((task) => movedIds.has(task.id)).length;
    const remaining = source.filter((task) => !movedIds.has(task.id));

    items[status] = remaining;
    next[status] = {
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

    const target = items[placement.status] ?? [];
    const foundIndex =
      placement.beforeId === null
        ? target.length
        : target.findIndex((candidate) => candidate.id === placement.beforeId);
    const insertion = foundIndex === -1 ? target.length : foundIndex;

    target.splice(insertion, 0, task);
    items[placement.status] = target;
    next[placement.status] = {
      ...columnOf(next, placement.status),
      items: target,
      total: columnOf(next, placement.status).total + 1,
    };
  }

  return next;
}

/**
 * Намерение перемещения, независимое от видимого (отфильтрованного или
 * постраничного) списка карточек.
 *
 * Позиция команды вычисляется по полному scope `(projectId, status)`, поэтому
 * скрытый фильтром сосед не сдвигает индекс.
 */
export type MoveIntent =
  | { readonly kind: "append" }
  | { readonly kind: "start" }
  | { readonly kind: "before"; readonly beforeId: string };

/**
 * Позиция для `task.move` по полному упорядоченному списку scope.
 *
 * `tasks` — все задачи целевого `(projectId, status)` без UI-фильтров и
 * пагинации. Перемещаемая карточка исключается: `append` равен реальной длине
 * остальных, `beforeId` — индексу в этом же полном списке.
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
 * отсутствие следующей означает `append`. Полный scope используется только
 * для перевода anchor-а в позицию, поэтому скрытые соседи не сдвигают
 * направление.
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
  status: TaskStatus,
  items: readonly Task[],
  taskId: string,
  targetIndex: number,
): Placement {
  const rest = items.filter((task) => task.id !== taskId);
  const index = Math.max(0, Math.min(targetIndex, rest.length));

  return { status, beforeId: rest[index]?.id ?? null };
}
