import type { Task, TaskColumn } from "../model.ts";
import type { TasksStore } from "../store.ts";

const PAGE_SIZE = 200;

/**
 * Читает все задачи проекта в стабильном порядке.
 *
 * Вызывается только на transaction-scoped Store внутри `withTransaction`,
 * поэтому снимок согласован с доменной мутацией.
 */
export async function listAllProjectTasks(
  store: Pick<TasksStore, "listTasks">,
  projectId: string,
): Promise<readonly Task[]> {
  const tasks: Task[] = [];
  let offset = 0;

  for (;;) {
    const page = await store.listTasks({
      projectId,
      sort: { field: "createdAt", direction: "asc" },
      limit: PAGE_SIZE,
      offset,
    });

    tasks.push(...page.items);

    if (page.nextOffset === null) {
      return tasks;
    }

    offset = page.nextOffset;
  }
}

/** Читает все задачи домена без фильтра проекта. */
export async function listAllTasks(store: Pick<TasksStore, "listTasks">): Promise<readonly Task[]> {
  const tasks: Task[] = [];
  let offset = 0;

  for (;;) {
    const page = await store.listTasks({
      sort: { field: "createdAt", direction: "asc" },
      limit: PAGE_SIZE,
      offset,
    });

    tasks.push(...page.items);

    if (page.nextOffset === null) {
      return tasks;
    }

    offset = page.nextOffset;
  }
}

/** Читает все колонки проекта в стабильном порядке. */
export async function listAllProjectColumns(
  store: Pick<TasksStore, "listColumns">,
  projectId: string,
): Promise<readonly TaskColumn[]> {
  const columns: TaskColumn[] = [];
  let offset = 0;

  for (;;) {
    const page = await store.listColumns({ projectId, limit: PAGE_SIZE, offset });

    columns.push(...page.items);

    if (page.nextOffset === null) {
      return columns;
    }

    offset = page.nextOffset;
  }
}

/** Снимок колонок проекта по ID. */
export async function snapshotProjectColumns(
  store: Pick<TasksStore, "listColumns">,
  projectId: string,
): Promise<Map<string, TaskColumn>> {
  const columns = await listAllProjectColumns(store, projectId);

  return new Map(columns.map((column) => [column.id, column]));
}

/**
 * Колонки, которые фактически изменились между снимками, кроме основной
 * колонки операции.
 */
export function shiftedColumns(
  before: ReadonlyMap<string, TaskColumn>,
  after: ReadonlyMap<string, TaskColumn>,
  mainColumnId: string | null,
): readonly TaskColumn[] {
  const changed: TaskColumn[] = [];

  for (const [id, column] of after) {
    if (id === mainColumnId) {
      continue;
    }

    const previous = before.get(id);

    if (previous === undefined) {
      continue;
    }

    if (previous.position !== column.position || previous.version !== column.version) {
      changed.push(column);
    }
  }

  return changed;
}

/** Снимок задач проекта по ID. */
export async function snapshotProjectTasks(
  store: Pick<TasksStore, "listTasks">,
  projectId: string,
): Promise<Map<string, Task>> {
  const tasks = await listAllProjectTasks(store, projectId);

  return new Map(tasks.map((task) => [task.id, task]));
}

/**
 * Возвращает соседей, которые фактически изменились между снимками.
 *
 * Основная задача операции исключается, чтобы не дублировать её собственное
 * событие. Новые и удалённые задачи не являются «сдвинутыми соседями».
 */
export function shiftedNeighbors(
  before: ReadonlyMap<string, Task>,
  after: ReadonlyMap<string, Task>,
  mainTaskId: string | null,
): readonly Task[] {
  const changed: Task[] = [];

  for (const [id, task] of after) {
    if (id === mainTaskId) {
      continue;
    }

    const previous = before.get(id);

    if (previous === undefined) {
      continue;
    }

    if (
      previous.position !== task.position ||
      previous.version !== task.version ||
      previous.status !== task.status
    ) {
      changed.push(task);
    }
  }

  return changed;
}
