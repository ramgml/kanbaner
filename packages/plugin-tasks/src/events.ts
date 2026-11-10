import { TASKS_CONTRACT_VERSION, TASKS_EVENT_TYPES, type TasksEventType } from "./constants.ts";
import type {
  DeletedColumnDescriptor,
  DeletedTaskDescriptor,
  TaskColumnType,
  TaskStatus,
} from "./model.ts";

/** Версия контракта событий задач. */
export const TASKS_EVENT_CONTRACT_VERSION = TASKS_CONTRACT_VERSION;

/** Общие поля события проекта. */
export interface ProjectEventPayload {
  readonly projectId: string;
  readonly version: number;
}

/** Payload `kanbaner.tasks.project.created`. */
export interface ProjectCreatedEventPayload extends ProjectEventPayload {
  readonly title: string;
}

/** Payload `kanbaner.tasks.project.updated`. */
export interface ProjectUpdatedEventPayload extends ProjectEventPayload {
  readonly changed: readonly string[];
}

/**
 * Payload `kanbaner.tasks.project.deleted`.
 *
 * `version` — последняя сохранённая версия проекта; `eventVersion` — значение
 * `resourceVersion` envelope-а (`version + 1`). `deletedTasks` содержат
 * последние версии задач и их собственные `eventVersion`. Tombstone-версия не
 * создаётся.
 */
export interface ProjectDeletedEventPayload {
  readonly projectId: string;
  readonly version: number;
  readonly eventVersion: number;
  readonly deletedTasks: readonly DeletedTaskDescriptor[];
  readonly deletedColumns: readonly DeletedColumnDescriptor[];
}

/** Общие поля события пользовательской колонки. */
export interface ColumnEventPayload {
  readonly columnId: string;
  readonly projectId: string;
  readonly version: number;
}

/** Payload `kanbaner.tasks.column.created`. */
export interface ColumnCreatedEventPayload extends ColumnEventPayload {
  readonly title: string;
  readonly type: TaskColumnType;
  readonly status: TaskStatus;
  readonly position: number;
}

/** Payload `kanbaner.tasks.column.updated`. */
export interface ColumnUpdatedEventPayload extends ColumnEventPayload {
  readonly changed: readonly string[];
}

/** Payload `kanbaner.tasks.column.moved`. */
export interface ColumnMovedEventPayload extends ColumnEventPayload {
  readonly fromPosition: number;
  readonly toPosition: number;
}

/**
 * Payload `kanbaner.tasks.column.deleted`.
 *
 * `targetColumnId` и `movedTaskIds` заданы для `column.delete`, когда задачи
 * переносятся в выбранную колонку. При каскадном `project.delete` обе части
 * отсутствуют: целевой колонки нет.
 */
export interface ColumnDeletedEventPayload {
  readonly columnId: string;
  readonly projectId: string;
  readonly version: number;
  readonly eventVersion: number;
  readonly targetColumnId?: string;
  readonly movedTaskIds?: readonly string[];
}

/** Общие поля события задачи. */
export interface TaskEventPayload {
  readonly taskId: string;
  readonly projectId: string;
  readonly version: number;
}

/** Payload `kanbaner.tasks.task.created`. */
export interface TaskCreatedEventPayload extends TaskEventPayload {
  readonly parentTaskId: string | null;
  readonly columnId?: string;
  readonly status: TaskStatus;
  readonly position: number;
}

/** Payload `kanbaner.tasks.task.updated`. */
export interface TaskUpdatedEventPayload extends TaskEventPayload {
  readonly changed: readonly string[];
  readonly columnId?: string;
  readonly status?: TaskStatus;
}

/** Payload `kanbaner.tasks.task.moved`. */
export interface TaskMovedEventPayload extends TaskEventPayload {
  readonly fromColumnId?: string;
  readonly toColumnId?: string;
  readonly fromStatus: TaskStatus;
  readonly toStatus: TaskStatus;
  readonly position: number;
}

/** Payload `kanbaner.tasks.task.completed`. */
export interface TaskCompletedEventPayload extends TaskEventPayload {
  readonly completedAt: string;
  readonly columnId?: string;
}

/**
 * Payload `kanbaner.tasks.task.deleted`.
 *
 * `version` — последняя сохранённая версия корневой задачи; `eventVersion` —
 * значение `resourceVersion` envelope-а (`version + 1`). `deletedTasks`
 * включают корень и подзадачи с их последними версиями и собственными
 * `eventVersion`. Tombstone-версия не создаётся.
 */
export interface TaskDeletedEventPayload {
  readonly taskId: string;
  readonly projectId: string;
  readonly version: number;
  readonly eventVersion: number;
  readonly deletedTasks: readonly DeletedTaskDescriptor[];
}

/** Проверяет, что значение — тип события домена задач. */
export function isTasksEventType(value: unknown): value is TasksEventType {
  return TASKS_EVENT_TYPES.some((eventType) => eventType === value);
}
