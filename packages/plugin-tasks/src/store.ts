import {
  definePluginStore,
  type PluginDocumentStore,
  type ResourceRef,
  type StorageStoreContract,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, TASKS_CONTRACT_VERSION, TASKS_STORE_CONTRACT } from "./constants.ts";
import type {
  DeletedColumnDescriptor,
  DeletedTaskDescriptor,
  Project,
  Task,
  TaskColumn,
  TaskColumnType,
  TaskPriority,
  TaskSort,
  TaskStatus,
} from "./model.ts";
import type { ProjectSummary, ProjectSummaryTotals } from "./schemas/queries.ts";

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
 * Параметры сводки проектов.
 *
 * `projectId` ограничивает выборку одним проектом; его отсутствие возвращает
 * все проекты стабильными страницами. `totals` считается по всем подходящим
 * проектам, а не по текущей странице. Момент для overdue берётся из
 * `now`-источника Store.
 */
export interface ProjectSummaryStoreQuery {
  readonly projectId?: string;
  readonly limit: number;
  readonly offset: number;
}

/** Страница сводок с агрегатами по полному набору проектов. */
export interface ProjectSummaryStorePage extends StorePage<ProjectSummary> {
  readonly totals: ProjectSummaryTotals;
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
 * Позиции уникальны и упорядочены в области `(projectId, columnId)`;
 * `parentTaskId` на область не влияет, непрерывность `0…N-1` не требуется.
 * `columnId` фильтрует пользовательскую колонку. По умолчанию используется
 * `position asc`.
 */
export interface TaskStoreQuery {
  readonly projectId?: string;
  readonly columnId?: string;
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
 * `eventVersion` — значение `resourceVersion` delete-события корня
 * (`deleteEventVersion(version)`). Tombstone-версия не создаётся.
 * `deletedTasks[].version`/`eventVersion` содержат последнюю сохранённую
 * версию каждой задачи и её версию события.
 */
export interface DeleteStoreSuccess {
  readonly deleted: true;
  readonly version: number;
  readonly eventVersion: number;
  readonly deletedResourceRefs: readonly ResourceRef[];
  readonly deletedTasks: readonly DeletedTaskDescriptor[];
  readonly deletedColumns: readonly DeletedColumnDescriptor[];
}

/** Идемпотентный no-op: удаляемая сущность уже отсутствует. */
export interface DeleteStoreNoop {
  readonly deleted: false;
}

/** Результат каскадного удаления с дискриминатором `deleted`. */
export type DeleteStoreResult = DeleteStoreSuccess | DeleteStoreNoop;

/** Параметры списка колонок проекта. */
export interface ColumnStoreQuery {
  readonly projectId: string;
  readonly limit: number;
  readonly offset: number;
}

/** Вход создания пользовательской колонки. */
export interface CreateColumnStoreInput {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly type: TaskColumnType;
  readonly position?: number | undefined;
  readonly createdAt: UtcTimestamp;
  readonly expectedVersion: 0;
}

/** Вход переименования колонки. */
export interface UpdateColumnStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly title: string;
  readonly updatedAt: UtcTimestamp;
}

/** Вход транзакционного reorder колонки. */
export interface MoveColumnStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly position: number;
  readonly updatedAt: UtcTimestamp;
}

/**
 * Вход удаления колонки с переносом задач.
 *
 * `targetColumnId` обязателен, принадлежит тому же проекту и не совпадает с
 * удаляемой колонкой. Последняя колонка проекта не удаляется.
 */
export interface DeleteColumnStoreInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly targetColumnId: string;
  readonly updatedAt: UtcTimestamp;
}

/** Успешное удаление колонки с атомарным переносом задач. */
export interface ColumnDeleteStoreSuccess {
  readonly deleted: true;
  readonly column: TaskColumn;
  readonly version: number;
  readonly eventVersion: number;
  readonly targetColumnId: string;
  /** Задачи после переноса: новые `columnId`, `status`, `position`, версии. */
  readonly movedTasks: readonly Task[];
  /** Оставшиеся колонки, у которых изменились позиции/версии. */
  readonly updatedColumns: readonly TaskColumn[];
}

/** Идемпотентный no-op: колонка уже отсутствует. */
export interface ColumnDeleteStoreNoop {
  readonly deleted: false;
}

/** Результат `deleteColumn`. */
export type ColumnDeleteStoreResult = ColumnDeleteStoreSuccess | ColumnDeleteStoreNoop;

/**
 * Результат детерминированного backfill legacy-проектов.
 *
 * `createdColumns` — материализованные исходные колонки, `updatedTasks` —
 * задачи, которым технически проставлен `columnId`. Публичные версии и
 * `updatedAt` этих задач не меняются.
 */
export interface LegacyColumnBackfillResult {
  readonly createdColumns: readonly TaskColumn[];
  readonly updatedTasks: readonly Task[];
}

/**
 * Вход создания задачи; ID и время подготовлены доменом.
 *
 * `position === undefined` означает атомарный append в конец области
 * `(projectId, columnId)`. Явная позиция означает транзакционный сдвиг соседей
 * в той же области. Store вычисляет `completedAt` через
 * `resolveCompletedAt(status, null, createdAt)`: для `done` он равен
 * `createdAt`, иначе `null`.
 */
export interface CreateTaskStoreInput {
  readonly id: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
  /**
   * Целевая колонка. При отсутствии Store выбирает первую колонку проекта с
   * указанным `status` (legacy-совместимость). `status` обязан совпадать со
   * статусом колонки.
   */
  readonly columnId?: string | undefined;
  readonly title: string;
  readonly descriptionMarkdown: string;
  /** Legacy-статус; обязателен, если не задан `columnId`. */
  readonly status?: TaskStatus | undefined;
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
  readonly columnId?: string | undefined;
  /** Legacy-статус; обязателен, если не задан `columnId`. */
  readonly status?: TaskStatus | undefined;
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

  /**
   * Возвращает точные сводки проектов.
   *
   * Счётчики и overdue считаются по полному набору задач проекта, а не по
   * странице карточек. Явный отсутствующий `projectId` даёт `NOT_FOUND`.
   */
  summarizeProjects(query: ProjectSummaryStoreQuery): Promise<ProjectSummaryStorePage>;

  createProject(input: CreateProjectStoreInput): Promise<Project>;
  updateProject(input: UpdateProjectStoreInput): Promise<Project>;
  deleteProject(input: DeleteProjectStoreInput): Promise<DeleteStoreResult>;

  getColumn(id: string): Promise<TaskColumn | null>;
  listColumns(query: ColumnStoreQuery): Promise<StorePage<TaskColumn>>;
  createColumn(input: CreateColumnStoreInput): Promise<TaskColumn>;
  updateColumn(input: UpdateColumnStoreInput): Promise<TaskColumn>;
  moveColumn(input: MoveColumnStoreInput): Promise<TaskColumn>;
  deleteColumn(input: DeleteColumnStoreInput): Promise<ColumnDeleteStoreResult>;
  /**
   * Материализует legacy-колонки и `columnId` одного проекта.
   *
   * Root-метод открывает собственную транзакцию. Activation вызывает его
   * отдельно для каждого проекта, чтобы сбой одного проекта не откатывал
   * остальные.
   */
  backfillLegacyProject(projectId: string): Promise<LegacyColumnBackfillResult>;

  /**
   * Материализует исходные колонки и `task.columnId` для legacy-проектов без
   * колонок. Идемпотентен, не повышает версии/`updatedAt` существующих задач и
   * не публикует доменные события.
   */
  backfillLegacyColumns(): Promise<LegacyColumnBackfillResult>;

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
  nextColumnId(): string;
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
