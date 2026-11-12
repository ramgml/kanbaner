import { MAX_BULK_TASKS, MAX_POSITION } from "../constants.ts";
import type { DeletedTaskDescriptor, Task } from "../model.ts";
import type { TasksStoreTransaction } from "../store.ts";
import {
  TasksNotFoundError,
  TasksStoreValidationError,
  TasksVersionConflictError,
} from "../store/index.ts";
import { TasksValidationError, type TasksValidationCode } from "../validation.ts";
import { shiftedNeighbors, snapshotProjectTasks } from "./snapshots.ts";

/** Одна задача массовой операции с точной ожидаемой версией. */
export interface BulkTaskItem {
  readonly id: string;
  readonly expectedVersion: number;
}

/** Перемещённая задача и её состояние до операции. */
export interface BulkMovedTask {
  readonly task: Task;
  readonly before: Task;
}

/** Результат транзакционного `task.moveMany`. */
export interface BulkMoveResult {
  /** Задачи в порядке входного массива. */
  readonly tasks: readonly Task[];
  readonly moved: readonly BulkMovedTask[];
  /** Соседи, у которых изменились позиция/версия из-за операции. */
  readonly neighbors: readonly Task[];
}

/** Задачи, удалённые одним корневым вызовом `deleteTask`. */
export interface BulkDeleteGroup {
  readonly root: DeletedTaskDescriptor;
  readonly descriptors: readonly DeletedTaskDescriptor[];
}

/** Результат транзакционного `task.deleteMany`. */
export interface BulkDeleteResult {
  readonly deleted: boolean;
  readonly groups: readonly BulkDeleteGroup[];
  /** Соседи, у которых изменились позиция/версия из-за операции. */
  readonly neighbors: readonly Task[];
}

function invalid(code: TasksValidationCode, message: string): TasksValidationError {
  return new TasksValidationError(code, message);
}

/**
 * Проверяет размер и уникальность набора до чтения и записи.
 *
 * JSON Schema уже ограничивает 1…200, но чистая доменная проверка нужна и для
 * прямых вызовов, и для защиты от невалидированного ввода.
 */
export function assertBulkTaskItems(items: readonly BulkTaskItem[]): void {
  if (items.length < 1 || items.length > MAX_BULK_TASKS) {
    throw invalid(
      "INVALID_BULK_SIZE",
      `Массовая операция принимает от 1 до ${MAX_BULK_TASKS} задач`,
    );
  }

  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.id)) {
      throw invalid("DUPLICATE_TASK_ID", "Задачи в массовой операции не должны повторяться");
    }

    seen.add(item.id);
  }
}

/**
 * Читает и проверяет весь набор до первой записи.
 *
 * Возвращает задачи в порядке входного массива. Ошибка отсутствующей задачи,
 * чужого проекта или устаревшей версии не оставляет частичных изменений.
 */
async function loadBulkTasks(
  transaction: TasksStoreTransaction,
  items: readonly BulkTaskItem[],
): Promise<readonly Task[]> {
  const tasks: Task[] = [];
  let projectId: string | null = null;

  for (const item of items) {
    const task = await transaction.getTask(item.id);

    if (task === null) {
      throw new TasksNotFoundError("task", item.id);
    }

    if (projectId === null) {
      projectId = task.projectId;
    } else if (task.projectId !== projectId) {
      throw invalid("TASKS_OTHER_PROJECT", "Массовая операция принимает задачи одного проекта");
    }

    if (task.version !== item.expectedVersion) {
      throw new TasksVersionConflictError(item.expectedVersion, task.version);
    }

    tasks.push(task);
  }

  return tasks;
}

/**
 * Атомарно дописывает задачи в конец `columnId` в порядке входного массива.
 *
 * До первой записи проверяются размер, уникальность, существование, один
 * проект, точные версии и target того же проекта. Каждая задача дописывается в
 * конец актуального target: Store сам исключает текущую задачу при same-column
 * и берёт фактическую длину при cross-column, потому что `MAX_POSITION`
 * клампится к позиции append. Фактическая версия читается перед каждым move:
 * предыдущие перемещения этой же операции могли сдвинуть соседа и повысить его
 * версию. Результат и события строятся по финальному снимку после всех moves.
 */
export async function moveTasksInBulk(
  transaction: TasksStoreTransaction,
  items: readonly BulkTaskItem[],
  columnId: string,
  updatedAt: string,
): Promise<BulkMoveResult> {
  assertBulkTaskItems(items);

  const beforeTasks = await loadBulkTasks(transaction, items);
  const first = beforeTasks[0];

  if (first === undefined) {
    throw invalid("INVALID_BULK_SIZE", "Массовая операция не содержит задач");
  }

  const projectId = first.projectId;
  const target = await transaction.getColumn(columnId);

  if (target === null) {
    throw new TasksNotFoundError("column", columnId);
  }

  if (target.projectId !== projectId) {
    throw invalid("COLUMN_TARGET_OTHER_PROJECT", "Целевая колонка принадлежит другому проекту");
  }

  const beforeSnapshot = await snapshotProjectTasks(transaction, projectId);
  const beforeById = new Map(beforeTasks.map((task) => [task.id, task]));

  for (const item of items) {
    const current = await transaction.getTask(item.id);

    if (current === null) {
      throw new TasksNotFoundError("task", item.id);
    }

    await transaction.moveTask({
      id: item.id,
      expectedVersion: current.version,
      columnId,
      position: MAX_POSITION,
      updatedAt,
    });
  }

  const afterSnapshot = await snapshotProjectTasks(transaction, projectId);
  const moved: BulkMovedTask[] = items.map((item) => {
    const before = beforeById.get(item.id);
    const task = afterSnapshot.get(item.id);

    if (before === undefined) {
      throw new TasksNotFoundError("task", item.id);
    }

    if (task === undefined) {
      throw new TasksStoreValidationError("Задача исчезла во время массового перемещения");
    }

    return { task, before };
  });
  const movedIds = new Set(moved.map((entry) => entry.task.id));
  const neighbors = shiftedNeighbors(beforeSnapshot, afterSnapshot, null).filter(
    (task) => !movedIds.has(task.id),
  );

  return {
    tasks: moved.map((entry) => entry.task),
    moved,
    neighbors,
  };
}

/**
 * Атомарно удаляет набор задач вместе с подзадачами.
 *
 * Повторная задача, удалённая каскадом другого корня, не обрабатывается
 * второй раз, поэтому дескрипторы, события и поисковые ссылки не дублируются.
 * Полностью отсутствующий набор — идемпотентный no-op без записи и событий.
 */
export async function deleteTasksInBulk(
  transaction: TasksStoreTransaction,
  items: readonly BulkTaskItem[],
): Promise<BulkDeleteResult> {
  assertBulkTaskItems(items);

  const existing: Task[] = [];

  for (const item of items) {
    const task = await transaction.getTask(item.id);

    if (task !== null) {
      existing.push(task);
    }
  }

  if (existing.length === 0) {
    return { deleted: false, groups: [], neighbors: [] };
  }

  if (existing.length !== items.length) {
    const existingIds = new Set(existing.map((task) => task.id));
    const missing = items.find((item) => !existingIds.has(item.id));

    throw new TasksNotFoundError("task", missing?.id ?? "unknown");
  }

  const projectId = existing[0]?.projectId;

  if (projectId === undefined) {
    throw invalid("INVALID_BULK_SIZE", "Массовая операция не содержит задач");
  }

  for (const task of existing) {
    if (task.projectId !== projectId) {
      throw invalid("TASKS_OTHER_PROJECT", "Массовая операция принимает задачи одного проекта");
    }
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const task = existing[index];

    if (item === undefined || task === undefined) {
      throw new TasksNotFoundError("task", item?.id ?? "unknown");
    }

    if (task.version !== item.expectedVersion) {
      throw new TasksVersionConflictError(item.expectedVersion, task.version);
    }
  }

  const beforeSnapshot = await snapshotProjectTasks(transaction, projectId);
  const groups: BulkDeleteGroup[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const current = await transaction.getTask(item.id);

    if (current === null) {
      // Задача уже удалена каскадом предыдущего корня в этом же наборе.
      continue;
    }

    const deletion = await transaction.deleteTask({
      id: item.id,
      expectedVersion: current.version,
    });

    if (!deletion.deleted) {
      continue;
    }

    const descriptors = deletion.deletedTasks.filter((descriptor) => !seen.has(descriptor.id));

    if (descriptors.length === 0) {
      continue;
    }

    for (const descriptor of descriptors) {
      seen.add(descriptor.id);
    }

    const root = descriptors[0];

    if (root !== undefined) {
      groups.push({ root, descriptors });
    }
  }

  const afterSnapshot = await snapshotProjectTasks(transaction, projectId);
  const neighbors = shiftedNeighbors(beforeSnapshot, afterSnapshot, null);

  return { deleted: groups.length > 0, groups, neighbors };
}
