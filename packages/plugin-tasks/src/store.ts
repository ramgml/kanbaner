import {
  definePluginStore,
  type PluginDocumentStore,
  type ResourceRef,
  type StorageStoreContract,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, TASKS_CONTRACT_VERSION, TASKS_STORE_CONTRACT } from "./constants.ts";
import type {
  DeletedTaskDescriptor,
  Project,
  Task,
  TaskPriority,
  TaskSort,
  TaskStatus,
} from "./model.ts";

/** Стабильная страница результата Store. */
export interface StorePage<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly nextOffset: number | null;
}

/**
 * Параметры списка проектов.
 *
 * Порядок фиксирован и не зависит от backend: `createdAt asc`, затем `id asc`.
 * Пагинация выполняется по этому порядку.
 */
export interface ProjectStoreQuery {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Параметры списка задач.
 *
 * Фильтры backend-neutral и комбинируются по AND.
 *
 * - `parentTaskId = null` выбирает корневые задачи; отсутствие поля не
 *   ограничивает вложенность.
 * - `tag` нормализуется тем же способом, что теги задачи: trim, нижний регистр,
 *   дедупликация и лимиты.
 * - `text` сравнивается без учёта регистра по NFKC-нормализованным
 *   `title`/`descriptionMarkdown` как подстрока.
 * - `dueBefore`/`dueAfter` включают границу; задача с `dueAt = null` не
 *   попадает в ограниченный диапазон.
 *
 * Сортировка и стабильный порядок:
 *
 * - `position` — по возрастанию/убыванию, затем `id asc`;
 * - `createdAt`/`updatedAt` — по UTC-timestamp, затем `id asc`;
 * - `dueAt` — `null` всегда последние независимо от направления, затем
 *   `id asc`;
 * - `title` — по code points Unicode, без `localeCompare`, затем `id asc`.
 *
 * Позиции уникальны и упорядочены в области `(projectId, status)`;
 * `parentTaskId` на область не влияет, непрерывность `0…N-1` не требуется.
 * По умолчанию используется `position asc`.
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

/**
 * Успешный результат каскадного удаления.
 *
 * `version` корневой сущности равен `expectedVersion` успешного вызова.
 * Tombstone-версия не создаётся: `deletedTasks[].version` — последняя
 * сохранённая версия задачи до удаления. События delete используют именно её.
 */
export interface DeleteStoreSuccess {
  readonly deleted: true;
  readonly version: number;
  readonly deletedResourceRefs: readonly ResourceRef[];
  readonly deletedTasks: readonly DeletedTaskDescriptor[];
}

/** Идемпотентный no-op: удаляемая сущность уже отсутствует. */
export interface DeleteStoreNoop {
  readonly deleted: false;
}

/** Результат каскадного удаления с дискриминатором `deleted`. */
export type DeleteStoreResult = DeleteStoreSuccess | DeleteStoreNoop;

/**
 * Вход создания задачи; ID и время подготовлены доменом.
 *
 * `position === undefined` означает атомарный append в конец области
 * `(projectId, status)`. Явная позиция означает транзакционный сдвиг соседей
 * в той же области. Store вычисляет `completedAt` через
 * `resolveCompletedAt(status, null, createdAt)`: для `done` он равен
 * `createdAt`, иначе `null`.
 */
export interface CreateTaskStoreInput {
  readonly id: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueAt: UtcTimestamp | null;
  readonly position?: number | undefined;
  readonly tags: readonly string[];
  readonly createdAt: UtcTimestamp;
  readonly expectedVersion: 0;
}

/** Вход изменения полей задачи; статус и позиция меняются только move. */
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

/**
 * Вход перемещения задачи.
 *
 * `completedAt` вычисляется Store через
 * `resolveCompletedAt(status, current.completedAt, updatedAt)`: переход в `done`
 * ставит `updatedAt`, выход из `done` очищает поле.
 */
export interface MoveTaskStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly status: TaskStatus;
  readonly position: number;
  readonly updatedAt: UtcTimestamp;
}

/**
 * Вход завершения задачи.
 *
 * `position === undefined` означает атомарный append в конец `(projectId,
 * "done")`; явная позиция означает транзакционный сдвиг в этой области.
 * `completedAt` не передаётся: Store вычисляет его сам. Если задача уже в
 * `done`, повторный `completeTask` возвращает текущую задачу без изменения
 * версии и сохраняет существующий `completedAt`.
 */
export interface CompleteTaskStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly position?: number | undefined;
  readonly updatedAt: UtcTimestamp;
}

/** Вход удаления задачи. */
export interface DeleteTaskStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
}

/** Код явной ошибки вложенной транзакции. */
export const TASKS_NESTED_TRANSACTION_CODE = "NESTED_TRANSACTION" as const;

/**
 * Вложенный `withTransaction` запрещён.
 *
 * Store не полагается на savepoints: реализация обязана бросить эту ошибку,
 * если `withTransaction` вызван на transaction-scoped интерфейсе.
 */
export class TasksNestedTransactionError extends Error {
  override readonly name = "TasksNestedTransactionError";
  readonly code = TASKS_NESTED_TRANSACTION_CODE;

  constructor(
    message = "Вложенный TasksStore.withTransaction запрещён: savepoints не поддерживаются",
  ) {
    super(message);
  }
}

/** Callback транзакции Store. */
export type TasksStoreTransactionCallback<T> = (transaction: TasksStoreTransaction) => Promise<T>;

/**
 * Доменный Store задач.
 *
 * Контракт асинхронный и backend-neutral: здесь нет SQL, имён таблиц,
 * драйвера БД и синхронных методов. Домен передаёт готовые ID и UTC-время,
 * а Store отвечает за версии, позиции, `completedAt` и каскадное удаление.
 *
 * Root-методы открывают собственную транзакцию провайдера. Те же методы на
 * `TasksStoreTransaction` используют уже открытую транзакцию и не открывают
 * вложенную. `withTransaction` на scoped-интерфейсе бросает
 * `TasksNestedTransactionError`; savepoints не требуются.
 */
export interface TasksStore {
  /**
   * Открывает транзакцию провайдера и передаёт transaction-scoped Store.
   *
   * Внутри callback доступен `documents`, привязанный к той же транзакции:
   * KAN-012 использует его для idempotency-записи в одной транзакции с
   * доменной мутацией.
   */
  withTransaction<T>(callback: TasksStoreTransactionCallback<T>): Promise<T>;

  getProject(id: string): Promise<Project | null>;
  listProjects(query: ProjectStoreQuery): Promise<StorePage<Project>>;
  createProject(input: CreateProjectStoreInput): Promise<Project>;
  updateProject(input: UpdateProjectStoreInput): Promise<Project>;
  deleteProject(input: DeleteProjectStoreInput): Promise<DeleteStoreResult>;

  getTask(id: string): Promise<Task | null>;
  listTasks(query: TaskStoreQuery): Promise<StorePage<Task>>;

  /** Создаёт задачу; при `position === undefined` делает атомарный append. */
  createTask(input: CreateTaskStoreInput): Promise<Task>;

  updateTask(input: UpdateTaskStoreInput): Promise<Task>;

  /** Перемещает задачу; `completedAt` следует инварианту `done ⇔ ≠ null`. */
  moveTask(input: MoveTaskStoreInput): Promise<Task>;

  /**
   * Завершает задачу. Повторный вызов для `done` возвращает текущую задачу
   * без изменения версии и сохраняет `completedAt`.
   */
  completeTask(input: CompleteTaskStoreInput): Promise<Task>;

  /** Удаляет задачу и подзадачи, возвращая дескрипторы последних версий. */
  deleteTask(input: DeleteTaskStoreInput): Promise<DeleteStoreResult>;
}

/**
 * Transaction-scoped Store.
 *
 * Все методы используют текущую транзакцию и не открывают новую. `documents`
 * — bound `PluginDocumentStore` этой же транзакции для idempotency-записи
 * KAN-012. Вложенный `withTransaction` бросает `TasksNestedTransactionError`.
 */
export interface TasksStoreTransaction extends TasksStore {
  readonly documents: PluginDocumentStore;

  /**
   * Вложенная транзакция запрещена: реализация бросает
   * `TasksNestedTransactionError`, а не открывает savepoint.
   */
  withTransaction<T>(callback: TasksStoreTransactionCallback<T>): Promise<T>;
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
