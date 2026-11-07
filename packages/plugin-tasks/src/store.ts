import {
  definePluginStore,
  type StorageStoreContract,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, TASKS_CONTRACT_VERSION, TASKS_STORE_CONTRACT } from "./constants.ts";
import type { Project, Task, TaskPriority, TaskSort, TaskStatus } from "./model.ts";

/** Стабильная страница результата Store. */
export interface StorePage<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly nextOffset: number | null;
}

/** Параметры списка проектов. */
export interface ProjectStoreQuery {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Параметры списка задач.
 *
 * Фильтры backend-neutral и комбинируются по AND. `parentTaskId = null`
 * выбирает корневые задачи. Позиции уникальны и упорядочены в области
 * `(projectId, status)`; `parentTaskId` на область не влияет, непрерывность
 * `0…N-1` не требуется. Сортировка по умолчанию — `position asc`, затем
 * стабильный порядок по `id`.
 */
export interface TaskStoreQuery {
  readonly projectId?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly tag?: string;
  readonly parentTaskId?: string | null;
  readonly text?: string;
  readonly dueBefore?: UtcTimestamp;
  readonly dueAfter?: UtcTimestamp;
  readonly sort?: TaskSort;
  readonly limit: number;
  readonly offset: number;
}

/** Вход создания проекта; ID и время подготовлены доменом. */
export interface CreateProjectStoreInput {
  readonly id: string;
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly createdAt: UtcTimestamp;
  readonly expectedVersion: 0;
}

/** Вход изменения проекта. */
export interface UpdateProjectStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly descriptionMarkdown?: string;
  readonly updatedAt: UtcTimestamp;
}

/** Вход удаления проекта. */
export interface DeleteProjectStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
}

/** Результат каскадного удаления. */
export interface DeleteStoreResult {
  readonly deleted: boolean;
  readonly deletedTaskIds: readonly string[];
}

/** Вход создания задачи; ID и время подготовлены доменом. */
export interface CreateTaskStoreInput {
  readonly id: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueAt: UtcTimestamp | null;
  readonly position: number;
  readonly tags: readonly string[];
  readonly createdAt: UtcTimestamp;
  readonly expectedVersion: 0;
}

/** Вход изменения полей задачи. */
export interface UpdateTaskStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly descriptionMarkdown?: string;
  readonly priority?: TaskPriority;
  readonly dueAt?: UtcTimestamp | null;
  readonly tags?: readonly string[];
  readonly updatedAt: UtcTimestamp;
}

/** Вход перемещения задачи. */
export interface MoveTaskStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly status: TaskStatus;
  readonly position: number;
  readonly updatedAt: UtcTimestamp;
}

/** Вход завершения задачи. */
export interface CompleteTaskStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly completedAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

/** Вход удаления задачи. */
export interface DeleteTaskStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
}

/**
 * Доменный Store задач.
 *
 * Контракт асинхронный и backend-neutral: здесь нет SQL, имён таблиц,
 * драйвера БД и синхронных методов. Домен передаёт готовые ID и UTC-время,
 * а Store отвечает за версии и каскадное удаление.
 */
export interface TasksStore {
  getProject(id: string): Promise<Project | null>;
  listProjects(query: ProjectStoreQuery): Promise<StorePage<Project>>;
  createProject(input: CreateProjectStoreInput): Promise<Project>;
  updateProject(input: UpdateProjectStoreInput): Promise<Project>;
  deleteProject(input: DeleteProjectStoreInput): Promise<DeleteStoreResult>;

  getTask(id: string): Promise<Task | null>;
  listTasks(query: TaskStoreQuery): Promise<StorePage<Task>>;
  createTask(input: CreateTaskStoreInput): Promise<Task>;
  updateTask(input: UpdateTaskStoreInput): Promise<Task>;
  moveTask(input: MoveTaskStoreInput): Promise<Task>;
  completeTask(input: CompleteTaskStoreInput): Promise<Task>;
  deleteTask(input: DeleteTaskStoreInput): Promise<DeleteStoreResult>;
}

/** Генератор ID, который домен использует до вызова Store. */
export interface TasksIdFactory {
  nextProjectId(): string;
  nextTaskId(): string;
}

/** Источник UTC-времени, внедряемый в домен. */
export interface TasksClock {
  now(): UtcTimestamp;
}

/** Зависимости доменного слоя, которые не входят в задачи KAN-010. */
export interface TasksStoreDependencies {
  readonly idFactory: TasksIdFactory;
  readonly clock: TasksClock;
}

/** Типизированный идентификатор Store-контракта задач. */
export const TASKS_STORE_CONTRACT_DEFINITION: StorageStoreContract<TasksStore> =
  definePluginStore<TasksStore>(PLUGIN_ID, TASKS_STORE_CONTRACT, TASKS_CONTRACT_VERSION);
