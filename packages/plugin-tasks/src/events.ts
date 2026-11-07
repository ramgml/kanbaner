import { TASKS_CONTRACT_VERSION, TASKS_EVENT_TYPES, type TasksEventType } from "./constants.ts";
import type { TaskStatus } from "./model.ts";

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

/** Payload `kanbaner.tasks.project.deleted`. */
export interface ProjectDeletedEventPayload {
  readonly projectId: string;
  readonly deletedTaskIds: readonly string[];
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
  readonly status: TaskStatus;
  readonly position: number;
}

/** Payload `kanbaner.tasks.task.updated`. */
export interface TaskUpdatedEventPayload extends TaskEventPayload {
  readonly changed: readonly string[];
}

/** Payload `kanbaner.tasks.task.moved`. */
export interface TaskMovedEventPayload extends TaskEventPayload {
  readonly fromStatus: TaskStatus;
  readonly toStatus: TaskStatus;
  readonly position: number;
}

/** Payload `kanbaner.tasks.task.completed`. */
export interface TaskCompletedEventPayload extends TaskEventPayload {
  readonly completedAt: string;
}

/** Payload `kanbaner.tasks.task.deleted`. */
export interface TaskDeletedEventPayload {
  readonly taskId: string;
  readonly projectId: string;
  readonly deletedTaskIds: readonly string[];
}

/** Проверяет, что значение — тип события домена задач. */
export function isTasksEventType(value: unknown): value is TasksEventType {
  return TASKS_EVENT_TYPES.some((eventType) => eventType === value);
}
