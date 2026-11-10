import {
  isUtcTimestamp,
  validateWithSchema,
  type JsonObject,
  type JsonValue,
  type PluginDocument,
  type PluginDocumentStore,
  type PluginStorage,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import {
  COLUMN_COLLECTION,
  DEFAULT_COLUMN_TITLES,
  LEGACY_COLUMN_TITLES,
  LEGACY_STATUS_ORDER,
  PLUGIN_ID,
  PROJECT_COLLECTION,
  TASK_COLLECTION,
} from "../constants.ts";
import {
  compareCodePoints,
  compareProjects,
  compareTaskList,
  compareUtcTimestamps,
  matchesDueRange,
  matchesTaskText,
} from "../listing.ts";
import {
  ProjectSchema,
  SORT_DIRECTIONS,
  TASK_SORT_FIELDS,
  TaskColumnSchema,
  TaskSchema,
  columnStatusForType,
  deleteEventVersion,
  type DeletedColumnDescriptor,
  type DeletedTaskDescriptor,
  type Project,
  type Task,
  type TaskColumn,
  type TaskSort,
  type TaskStatus,
} from "../model.ts";
import { formatColumnRef, formatProjectRef, formatTaskRef } from "../resources.ts";
import type { ProjectSummary, ProjectSummaryTotals, TaskStatusCounts } from "../schemas/queries.ts";
import {
  TasksValidationError,
  assertStoredTask,
  normalizeTag,
  normalizeTags,
  resolveCompletedAt,
  resolveTaskColumn,
  resolveTaskColumnId,
  sortTaskColumns,
  validateExpectedVersion,
  validatePagination,
  validatePosition,
  validateSubtaskParent,
} from "../validation.ts";
import {
  TasksNestedTransactionError,
  type ColumnDeleteStoreResult,
  type ColumnDeleteStoreSuccess,
  type ColumnStoreQuery,
  type CompleteTaskStoreInput,
  type CreateColumnStoreInput,
  type CreateProjectStoreInput,
  type CreateTaskStoreInput,
  type DeleteColumnStoreInput,
  type DeleteProjectStoreInput,
  type DeleteStoreResult,
  type DeleteStoreSuccess,
  type DeleteTaskStoreInput,
  type LegacyColumnBackfillResult,
  type MoveColumnStoreInput,
  type MoveTaskStoreInput,
  type ProjectStoreQuery,
  type ProjectSummaryStorePage,
  type ProjectSummaryStoreQuery,
  type StorePage,
  type TasksIdFactory,
  type TasksStore,
  type TasksStoreTransaction,
  type TaskStoreQuery,
  type UpdateColumnStoreInput,
  type UpdateProjectStoreInput,
  type UpdateTaskStoreInput,
} from "../store.ts";
import {
  TasksNotFoundError,
  TasksStoreValidationError,
  TasksVersionConflictError,
} from "./errors.ts";

const DOCUMENT_PAGE_SIZE = 1_000;

/** Источник UTC-времени: функция или clock-объект доменного слоя. */
export type TasksNowSource =
  (() => UtcTimestamp | Date) | { readonly now: () => UtcTimestamp | Date };

/**
 * Зависимости реализации Store.
 *
 * `idFactory` и `now` применяются только как fallback, если вызывающая
 * сторона не передала ID/время в типизированном входе. Контракт KAN-010
 * требует готовые ID и UTC-время, поэтому в обычном потоке они не нужны.
 */
export interface CreateTasksStoreOptions {
  readonly storage: PluginStorage;
  readonly idFactory?: TasksIdFactory;
  readonly now?: TasksNowSource;
}

interface TaskRecord {
  readonly task: Task;
  readonly document: PluginDocument;
}

interface ProjectRecord {
  readonly project: Project;
  readonly document: PluginDocument;
}

interface ColumnRecord {
  readonly column: TaskColumn;
  readonly document: PluginDocument;
}

interface StoreDependencies {
  readonly documents: PluginDocumentStore;
  readonly idFactory: TasksIdFactory | undefined;
  readonly now: TasksNowSource | undefined;
}

/**
 * Core-методы одной транзакционной области.
 *
 * Здесь нет открытия транзакций: root-обёртка передаёт либо provider-bound
 * documents, либо documents текущей транзакции.
 */
interface CoreStore {
  getProject(id: string): Promise<Project | null>;
  listProjects(query: ProjectStoreQuery): Promise<StorePage<Project>>;
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
  backfillLegacyColumns(): Promise<LegacyColumnBackfillResult>;
  backfillLegacyProject(projectId: string): Promise<LegacyColumnBackfillResult>;

  getTask(id: string): Promise<Task | null>;
  listTasks(query: TaskStoreQuery): Promise<StorePage<Task>>;
  createTask(input: CreateTaskStoreInput): Promise<Task>;
  updateTask(input: UpdateTaskStoreInput): Promise<Task>;
  moveTask(input: MoveTaskStoreInput): Promise<Task>;
  completeTask(input: CompleteTaskStoreInput): Promise<Task>;
  deleteTask(input: DeleteTaskStoreInput): Promise<DeleteStoreResult>;
}

function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

function readNow(source: TasksNowSource | undefined): UtcTimestamp {
  if (source === undefined) {
    return new Date().toISOString();
  }

  const value = typeof source === "function" ? source() : source.now();

  if (isDate(value)) {
    return value.toISOString();
  }

  if (!isUtcTimestamp(value)) {
    throw new TasksStoreValidationError("Источник времени должен возвращать UTC timestamp");
  }

  return value;
}

function resolveTimestamp(
  value: UtcTimestamp | null | undefined,
  now: TasksNowSource | undefined,
  label: string,
): UtcTimestamp {
  const timestamp = value ?? readNow(now);

  if (!isUtcTimestamp(timestamp)) {
    throw new TasksStoreValidationError(`${label} должен быть UTC timestamp`);
  }

  return timestamp;
}

function resolveIdentifier(
  value: string | undefined,
  factory: (() => string) | undefined,
  label: string,
): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (factory !== undefined) {
    return factory();
  }

  throw new TasksStoreValidationError(`${label} должен быть создан до записи`);
}

function assertExpectedVersion(value: unknown, allowZero = false): number {
  const result = validateExpectedVersion(value, { allowZero });

  if (!result.ok) {
    throw new TasksValidationError(result.code, result.message);
  }

  return result.value;
}

function assertProjectVersion(project: Project, expectedVersion: number): void {
  if (project.version !== expectedVersion) {
    throw new TasksVersionConflictError(expectedVersion, project.version);
  }
}

function assertTaskVersion(task: Task, expectedVersion: number): void {
  if (task.version !== expectedVersion) {
    throw new TasksVersionConflictError(expectedVersion, task.version);
  }
}

function assertPosition(value: unknown): number {
  const result = validatePosition(value);

  if (!result.ok) {
    throw new TasksValidationError(result.code, result.message);
  }

  return result.value;
}

function resolvePagination(limit: number, offset: number): { limit: number; offset: number } {
  const result = validatePagination({ limit, offset });

  if (!result.ok) {
    throw new TasksValidationError(result.code, result.message);
  }

  return result.value;
}

function resolveTaskSort(sort: TaskSort | undefined): TaskSort {
  if (sort === undefined) {
    return { field: "position", direction: "asc" };
  }

  if (
    !(TASK_SORT_FIELDS as readonly string[]).includes(sort.field) ||
    !(SORT_DIRECTIONS as readonly string[]).includes(sort.direction)
  ) {
    throw new TasksStoreValidationError("Некорректная сортировка списка задач");
  }

  return sort;
}

function buildProject(value: unknown): Project {
  const result = validateWithSchema(ProjectSchema, value);

  if (!result.ok) {
    throw new TasksStoreValidationError("Проект не соответствует модели", {
      cause: result.errors,
    });
  }

  return result.value;
}

function buildTask(value: unknown): Task {
  const result = validateWithSchema(TaskSchema, value);

  if (!result.ok) {
    throw new TasksStoreValidationError("Задача не соответствует модели", {
      cause: result.errors,
    });
  }

  assertStoredTask(result.value);

  return result.value;
}

function parseProjectDocument(document: PluginDocument): Project {
  const project = buildProject(document.data);

  if (project.id !== document.id || project.version !== document.version) {
    throw new TasksStoreValidationError("Документ проекта не совпадает с сохранённой моделью");
  }

  return project;
}

function parseTaskDocument(document: PluginDocument): Task {
  const task = buildTask(document.data);

  // Ревизия документа может опережать публичную версию после технического
  // backfill legacy-колонок. Обратное расхождение запрещено: публичная версия
  // не может быть новее сохранённого документа.
  if (task.id !== document.id || task.version > document.version) {
    throw new TasksStoreValidationError(
      "Документ задачи и публичная версия не совпадают с сохранённой моделью",
    );
  }

  return task;
}

function buildColumn(value: unknown): TaskColumn {
  const result = validateWithSchema(TaskColumnSchema, value);

  if (!result.ok) {
    throw new TasksStoreValidationError("Колонка не соответствует модели", {
      cause: result.errors,
    });
  }

  return result.value;
}

function parseColumnDocument(document: PluginDocument): TaskColumn {
  const column = buildColumn(document.data);

  if (column.id !== document.id || column.version !== document.version) {
    throw new TasksStoreValidationError("Документ колонки не совпадает с сохранённой моделью");
  }

  return column;
}

function columnIndexedFields(column: TaskColumn): JsonObject {
  return {
    projectId: column.projectId,
    status: column.status,
  };
}

function columnDescriptor(column: TaskColumn): DeletedColumnDescriptor {
  return {
    id: column.id,
    projectId: column.projectId,
    resourceRef: formatColumnRef(column.id),
    version: column.version,
    eventVersion: deleteEventVersion(column.version),
  };
}

function defaultColumnId(projectId: string, slug: "todo" | "in-progress" | "done"): string {
  return `column-${projectId}-${slug}`;
}

function legacyColumnId(projectId: string, status: TaskStatus): string {
  return `column-${projectId}-legacy-${status}`;
}

function legacyTitleForStatus(status: TaskStatus): string {
  switch (status) {
    case "backlog":
      return LEGACY_COLUMN_TITLES.backlog;
    case "todo":
      return LEGACY_COLUMN_TITLES.todo;
    case "in_progress":
      return LEGACY_COLUMN_TITLES.inProgress;
    case "done":
      return LEGACY_COLUMN_TITLES.done;
  }
}

function taskIndexedFields(task: Task): JsonObject {
  return {
    projectId: task.projectId,
    ...(task.columnId === undefined ? {} : { columnId: task.columnId }),
    status: task.status,
    priority: task.priority,
    parentTaskId: task.parentTaskId,
  };
}

function taskDescriptor(task: Task): DeletedTaskDescriptor {
  return {
    id: task.id,
    projectId: task.projectId,
    resourceRef: formatTaskRef(task.id),
    version: task.version,
    eventVersion: deleteEventVersion(task.version),
  };
}

function pageOf<Item>(all: readonly Item[], offset: number, limit: number): StorePage<Item> {
  const items = all.slice(offset, offset + limit);
  const nextOffset = offset + items.length < all.length ? offset + items.length : null;

  return { items, total: all.length, nextOffset };
}

function compareTaskRecords(left: TaskRecord, right: TaskRecord): number {
  const positionOrder = left.task.position - right.task.position;

  return positionOrder === 0 ? compareCodePoints(left.task.id, right.task.id) : positionOrder;
}

function createCore(dependencies: StoreDependencies): CoreStore {
  const { documents, idFactory, now } = dependencies;

  async function queryTaskDocuments(filter: JsonObject | undefined): Promise<PluginDocument[]> {
    const result: PluginDocument[] = [];
    let offset = 0;

    for (;;) {
      const page = await documents.query({
        pluginId: PLUGIN_ID,
        collection: TASK_COLLECTION,
        ...(filter === undefined ? {} : { indexedFields: filter }),
        limit: DOCUMENT_PAGE_SIZE,
        offset,
      });

      result.push(...page);

      if (page.length < DOCUMENT_PAGE_SIZE) {
        return result;
      }

      offset += page.length;
    }
  }

  async function loadProjectRecord(id: string): Promise<ProjectRecord | null> {
    const document = await documents.get(PLUGIN_ID, PROJECT_COLLECTION, id);

    return document === null ? null : { project: parseProjectDocument(document), document };
  }

  async function requireProjectRecord(id: string): Promise<ProjectRecord> {
    const record = await loadProjectRecord(id);

    if (record === null) {
      throw new TasksNotFoundError("project", id);
    }

    return record;
  }

  async function loadTaskRecord(id: string): Promise<TaskRecord | null> {
    const document = await documents.get(PLUGIN_ID, TASK_COLLECTION, id);

    return document === null ? null : { task: parseTaskDocument(document), document };
  }

  async function requireTaskRecord(id: string): Promise<TaskRecord> {
    const record = await loadTaskRecord(id);

    if (record === null) {
      throw new TasksNotFoundError("task", id);
    }

    return record;
  }

  async function queryColumnDocuments(filter: JsonObject | undefined): Promise<PluginDocument[]> {
    const result: PluginDocument[] = [];
    let offset = 0;

    for (;;) {
      const page = await documents.query({
        pluginId: PLUGIN_ID,
        collection: COLUMN_COLLECTION,
        ...(filter === undefined ? {} : { indexedFields: filter }),
        limit: DOCUMENT_PAGE_SIZE,
        offset,
      });

      result.push(...page);

      if (page.length < DOCUMENT_PAGE_SIZE) {
        return result;
      }

      offset += page.length;
    }
  }

  async function loadColumnRecord(id: string): Promise<ColumnRecord | null> {
    const document = await documents.get(PLUGIN_ID, COLUMN_COLLECTION, id);

    return document === null ? null : { column: parseColumnDocument(document), document };
  }

  async function requireColumnRecord(id: string): Promise<ColumnRecord> {
    const record = await loadColumnRecord(id);

    if (record === null) {
      throw new TasksNotFoundError("column", id);
    }

    return record;
  }

  async function saveColumn(
    column: TaskColumn,
    expectedDocumentVersion: number,
  ): Promise<ColumnRecord> {
    const document = await documents.put({
      pluginId: PLUGIN_ID,
      collection: COLUMN_COLLECTION,
      id: column.id,
      data: column as unknown as JsonValue,
      indexedFields: columnIndexedFields(column),
      expectedVersion: expectedDocumentVersion,
    });

    if (document.version !== column.version) {
      throw new TasksStoreValidationError("Версия документа колонки не совпадает с моделью");
    }

    return { column, document };
  }

  async function loadProjectColumns(projectId: string): Promise<ColumnRecord[]> {
    const columnDocuments = await queryColumnDocuments({ projectId });

    return columnDocuments
      .map((document) => ({ column: parseColumnDocument(document), document }))
      .sort((left, right) => {
        const byPosition = left.column.position - right.column.position;

        return byPosition === 0 ? compareCodePoints(left.column.id, right.column.id) : byPosition;
      });
  }

  async function createColumns(
    project: Project,
    definitions: readonly {
      readonly id: string;
      readonly title: string;
      readonly status: TaskStatus;
      readonly position: number;
    }[],
  ): Promise<ColumnRecord[]> {
    const created: ColumnRecord[] = [];

    for (const definition of definitions) {
      const column = buildColumn({
        id: definition.id,
        projectId: project.id,
        title: definition.title,
        status: definition.status,
        position: definition.position,
        version: 1,
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
      });

      created.push(await saveColumn(column, 0));
    }

    return created;
  }

  async function createDefaultColumns(project: Project): Promise<ColumnRecord[]> {
    return createColumns(project, [
      {
        id: defaultColumnId(project.id, "todo"),
        title: DEFAULT_COLUMN_TITLES.todo,
        status: "todo",
        position: 0,
      },
      {
        id: defaultColumnId(project.id, "in-progress"),
        title: DEFAULT_COLUMN_TITLES.inProgress,
        status: "in_progress",
        position: 1,
      },
      {
        id: defaultColumnId(project.id, "done"),
        title: DEFAULT_COLUMN_TITLES.done,
        status: "done",
        position: 2,
      },
    ]);
  }

  async function createLegacyColumns(project: Project): Promise<ColumnRecord[]> {
    return createColumns(project, [
      {
        id: legacyColumnId(project.id, "backlog"),
        title: LEGACY_COLUMN_TITLES.backlog,
        status: "backlog",
        position: 0,
      },
      {
        id: legacyColumnId(project.id, "todo"),
        title: LEGACY_COLUMN_TITLES.todo,
        status: "todo",
        position: 1,
      },
      {
        id: legacyColumnId(project.id, "in_progress"),
        title: LEGACY_COLUMN_TITLES.inProgress,
        status: "in_progress",
        position: 2,
      },
      {
        id: legacyColumnId(project.id, "done"),
        title: LEGACY_COLUMN_TITLES.done,
        status: "done",
        position: 3,
      },
    ]);
  }

  /**
   * Возвращает колонки проекта, материализуя исходные четыре для legacy-проекта
   * без колонок. Используется мутациями и queries, которым нужна область
   * позиции; полный backfill задач выполняет `backfillLegacyColumns`.
   */
  async function ensureProjectColumns(project: Project): Promise<ColumnRecord[]> {
    const columns = await loadProjectColumns(project.id);

    if (columns.length > 0) {
      return columns;
    }

    return createLegacyColumns(project);
  }

  /**
   * Лениво материализует отсутствующую legacy-колонку для явного `status`.
   *
   * Новый проект остаётся с тремя default-колонками. Если старый клиент
   * создаёт или перемещает задачу со статусом `backlog` (или другим
   * отсутствующим legacy-статусом), недостающая колонка создаётся в той же
   * транзакции. Позиция детерминирована порядком legacy-статусов: Backlog
   * встаёт в начало, остальные — перед первой колонкой с более поздним
   * статусом. Сдвинутые соседи получают новую версию и `updatedAt`.
   */
  async function materializeLegacyStatusColumn(
    project: Project,
    columns: readonly ColumnRecord[],
    status: TaskStatus,
    timestamp: UtcTimestamp,
  ): Promise<{ readonly columns: ColumnRecord[]; readonly created: ColumnRecord | null }> {
    if (columns.some((record) => record.column.status === status)) {
      return { columns: [...columns], created: null };
    }

    const statusIndex = LEGACY_STATUS_ORDER.indexOf(status);
    const ordered = sortTaskColumns(columns.map((record) => record.column));
    const insertion =
      statusIndex === -1
        ? ordered.length
        : ordered.filter((column) => LEGACY_STATUS_ORDER.indexOf(column.status) < statusIndex)
            .length;

    for (const record of columns) {
      const column = record.column;
      const position = column.position < insertion ? column.position : column.position + 1;

      if (position === column.position) {
        continue;
      }

      const shifted = buildColumn({
        ...column,
        position,
        version: column.version + 1,
        updatedAt: timestamp,
      });

      await saveColumn(shifted, record.document.version);
    }

    const column = buildColumn({
      id: legacyColumnId(project.id, status),
      projectId: project.id,
      title: legacyTitleForStatus(status),
      status,
      position: insertion,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const saved = await saveColumn(column, 0);
    const next = await loadProjectColumns(project.id);

    return { columns: next, created: saved };
  }

  async function loadScope(
    projectId: string,
    columns: readonly ColumnRecord[],
    columnId: string,
  ): Promise<TaskRecord[]> {
    const projectTasks = await loadProjectTasks(projectId);
    const available = columns.map((record) => record.column);

    return projectTasks
      .filter((record) => resolveTaskColumnId(record.task, available) === columnId)
      .sort(compareTaskRecords);
  }

  async function loadProjectTasks(projectId: string): Promise<TaskRecord[]> {
    const projectTasks = await queryTaskDocuments({ projectId });

    return projectTasks.map((document) => ({ task: parseTaskDocument(document), document }));
  }

  async function backfillProject(project: Project): Promise<{
    readonly columns: ColumnRecord[];
    readonly createdColumns: ColumnRecord[];
    readonly updatedTasks: TaskRecord[];
  }> {
    const existing = await loadProjectColumns(project.id);
    const createdColumns = existing.length === 0 ? await createLegacyColumns(project) : [];
    const columns = existing.length === 0 ? createdColumns : existing;
    const available = columns.map((record) => record.column);
    const tasks = await loadProjectTasks(project.id);
    const updatedTasks: TaskRecord[] = [];

    for (const record of tasks) {
      const effective = resolveTaskColumnId(record.task, available);

      if (effective === null || record.task.columnId === effective) {
        continue;
      }

      // Технический backfill: публичные version/updatedAt не меняются.
      const updated = buildTask({ ...record.task, columnId: effective });
      const saved = await saveTask(updated, record.document.version);

      updatedTasks.push(saved);
    }

    return { columns, createdColumns, updatedTasks };
  }

  async function saveProject(project: Project, expectedVersion: number): Promise<ProjectRecord> {
    const document = await documents.put({
      pluginId: PLUGIN_ID,
      collection: PROJECT_COLLECTION,
      id: project.id,
      data: project as unknown as JsonValue,
      expectedVersion,
    });

    if (document.version !== project.version) {
      throw new TasksStoreValidationError("Версия документа проекта не совпадает с моделью");
    }

    return { project, document };
  }

  async function saveTask(task: Task, expectedDocumentVersion: number): Promise<TaskRecord> {
    assertStoredTask(task);

    const document = await documents.put({
      pluginId: PLUGIN_ID,
      collection: TASK_COLLECTION,
      id: task.id,
      data: task as unknown as JsonValue,
      indexedFields: taskIndexedFields(task),
      expectedVersion: expectedDocumentVersion,
    });

    if (document.version < task.version) {
      throw new TasksStoreValidationError("Версия документа задачи не совпадает с моделью");
    }

    return { task, document };
  }

  /**
   * Сдвигает соседа на новую позицию как обычное изменение сущности.
   *
   * Публичная `version` и `updatedAt` увеличиваются вместе с внутренней
   * ревизией документа, поэтому они остаются синхронными. Запись выполняется
   * через CAS с текущей версией документа: конкурентная операция не может
   * потерять или перезаписать сдвиг.
   *
   * Событие для такого сдвига Store не публикует; это обязанность KAN-012.
   */
  async function shiftRecord(
    record: TaskRecord,
    position: number,
    updatedAt: UtcTimestamp,
  ): Promise<TaskRecord> {
    if (record.task.position === position) {
      return record;
    }

    const shifted = buildTask({
      ...record.task,
      position,
      version: record.task.version + 1,
      updatedAt,
    });

    return saveTask(shifted, record.document.version);
  }

  async function reindexScopes(
    records: readonly TaskRecord[],
    updatedAt: UtcTimestamp,
  ): Promise<void> {
    const projects = new Map<
      string,
      { readonly projectId: string; readonly columnIds: Set<string> }
    >();

    for (const record of records) {
      const project = projects.get(record.task.projectId) ?? {
        projectId: record.task.projectId,
        columnIds: new Set<string>(),
      };

      if (record.task.columnId !== undefined) {
        project.columnIds.add(record.task.columnId);
      }

      projects.set(record.task.projectId, project);
    }

    for (const project of projects.values()) {
      const projectRecord = await requireProjectRecord(project.projectId);
      const columns = await ensureProjectColumns(projectRecord.project);
      const available = columns.map((record) => record.column);

      for (const record of records.filter(
        (candidate) => candidate.task.projectId === project.projectId,
      )) {
        const columnId = resolveTaskColumnId(record.task, available);

        if (columnId !== null) {
          project.columnIds.add(columnId);
        }
      }

      for (const columnId of project.columnIds) {
        const remaining = await loadScope(project.projectId, columns, columnId);

        for (let index = 0; index < remaining.length; index += 1) {
          const record = remaining[index];

          if (record !== undefined) {
            await shiftRecord(record, index, updatedAt);
          }
        }
      }
    }
  }

  function clampInsertion(index: number, length: number): number {
    if (index < 0) {
      return 0;
    }

    return index > length ? length : index;
  }

  async function relocateRecord(
    record: TaskRecord,
    columns: readonly ColumnRecord[],
    targetColumn: TaskColumn,
    insertion: number | undefined,
    completedAt: UtcTimestamp | null,
    updatedAt: UtcTimestamp,
  ): Promise<Task> {
    const current = record.task;
    const currentColumnId = resolveTaskColumnId(
      current,
      columns.map((column) => column.column),
    );
    let index: number;

    if (currentColumnId === targetColumn.id) {
      const others = (await loadScope(current.projectId, columns, targetColumn.id)).filter(
        (candidate) => candidate.task.id !== current.id,
      );
      index = insertion === undefined ? others.length : clampInsertion(insertion, others.length);

      for (let position = 0; position < others.length; position += 1) {
        const candidate = others[position];

        if (candidate !== undefined) {
          await shiftRecord(candidate, position < index ? position : position + 1, updatedAt);
        }
      }
    } else {
      if (currentColumnId !== null) {
        const sourceRemaining = (
          await loadScope(current.projectId, columns, currentColumnId)
        ).filter((candidate) => candidate.task.id !== current.id);

        for (let position = 0; position < sourceRemaining.length; position += 1) {
          const candidate = sourceRemaining[position];

          if (candidate !== undefined) {
            await shiftRecord(candidate, position, updatedAt);
          }
        }
      }

      const targetRecords = await loadScope(current.projectId, columns, targetColumn.id);
      index =
        insertion === undefined
          ? targetRecords.length
          : clampInsertion(insertion, targetRecords.length);

      for (let position = 0; position < targetRecords.length; position += 1) {
        const candidate = targetRecords[position];

        if (candidate !== undefined) {
          await shiftRecord(candidate, position < index ? position : position + 1, updatedAt);
        }
      }
    }

    const moved = buildTask({
      ...current,
      columnId: targetColumn.id,
      status: targetColumn.status,
      position: index,
      completedAt,
      updatedAt,
      version: current.version + 1,
    });
    const saved = await saveTask(moved, record.document.version);

    return saved.task;
  }

  return {
    async getProject(id) {
      return (await loadProjectRecord(id))?.project ?? null;
    },

    async listProjects(query) {
      const pagination = resolvePagination(query.limit, query.offset);
      const projectDocuments = await documents.list(PLUGIN_ID, PROJECT_COLLECTION);
      const projects = projectDocuments.map(parseProjectDocument).sort(compareProjects);

      return pageOf(projects, pagination.offset, pagination.limit);
    },

    async summarizeProjects(query) {
      const pagination = resolvePagination(query.limit, query.offset);
      const observedAt = readNow(now);
      const projectDocuments = await documents.list(PLUGIN_ID, PROJECT_COLLECTION);
      const projects = projectDocuments.map(parseProjectDocument).sort(compareProjects);
      const matching =
        query.projectId === undefined
          ? projects
          : projects.filter((project) => project.id === query.projectId);

      if (query.projectId !== undefined && matching.length === 0) {
        throw new TasksNotFoundError("project", query.projectId);
      }

      // Счётчики строятся по полному набору задач, а не по странице карточек.
      // При явном projectId читается только его scope, иначе — все задачи
      // одним проходом без запроса на каждый проект (никакого N+1).
      const taskDocuments = await queryTaskDocuments(
        query.projectId === undefined ? undefined : { projectId: query.projectId },
      );
      const summaries = new Map<string, ProjectSummary>(
        matching.map((project) => [
          project.id,
          {
            project,
            total: 0,
            counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
            overdueCount: 0,
          },
        ]),
      );

      for (const document of taskDocuments) {
        const task = parseTaskDocument(document);
        const current = summaries.get(task.projectId);

        if (current === undefined) {
          continue;
        }

        const counts: TaskStatusCounts = {
          backlog: current.counts.backlog + (task.status === "backlog" ? 1 : 0),
          todo: current.counts.todo + (task.status === "todo" ? 1 : 0),
          in_progress: current.counts.in_progress + (task.status === "in_progress" ? 1 : 0),
          done: current.counts.done + (task.status === "done" ? 1 : 0),
        };

        const overdue =
          task.status !== "done" &&
          task.dueAt !== null &&
          compareUtcTimestamps(task.dueAt, observedAt) < 0;

        summaries.set(task.projectId, {
          project: current.project,
          total: current.total + 1,
          counts,
          overdueCount: current.overdueCount + (overdue ? 1 : 0),
        });
      }

      const all = matching.map((project) => summaries.get(project.id) as ProjectSummary);
      const totals = all.reduce<ProjectSummaryTotals>(
        (aggregate, summary) => ({
          total: aggregate.total + summary.total,
          counts: {
            backlog: aggregate.counts.backlog + summary.counts.backlog,
            todo: aggregate.counts.todo + summary.counts.todo,
            in_progress: aggregate.counts.in_progress + summary.counts.in_progress,
            done: aggregate.counts.done + summary.counts.done,
          },
          overdueCount: aggregate.overdueCount + summary.overdueCount,
        }),
        {
          total: 0,
          counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
          overdueCount: 0,
        },
      );

      return { ...pageOf(all, pagination.offset, pagination.limit), totals };
    },

    async createProject(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion, true);

      if (expectedVersion !== 0) {
        throw new TasksStoreValidationError("Создание проекта требует expectedVersion = 0");
      }

      const id = resolveIdentifier(
        input.id,
        idFactory?.nextProjectId.bind(idFactory),
        "ID проекта",
      );
      const createdAt = resolveTimestamp(input.createdAt, now, "createdAt");
      const existing = await loadProjectRecord(id);

      if (existing !== null) {
        throw new TasksVersionConflictError(0, existing.project.version);
      }

      const project = buildProject({
        id,
        title: input.title,
        descriptionMarkdown: input.descriptionMarkdown,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      });
      const saved = await saveProject(project, 0);

      // Default-колонки создаются в той же транзакции, что и проект. Сбой
      // любой записи откатывает и проект, и колонки.
      await createDefaultColumns(saved.project);

      return saved.project;
    },

    async updateProject(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await requireProjectRecord(input.id);

      assertProjectVersion(record.project, expectedVersion);

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const project = buildProject({
        ...record.project,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.descriptionMarkdown === undefined
          ? {}
          : { descriptionMarkdown: input.descriptionMarkdown }),
        version: record.project.version + 1,
        updatedAt,
      });
      const saved = await saveProject(project, record.document.version);

      return saved.project;
    },

    async deleteProject(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await loadProjectRecord(input.id);

      if (record === null) {
        return { deleted: false };
      }

      assertProjectVersion(record.project, expectedVersion);

      const tasks = (await loadProjectTasks(record.project.id)).sort((left, right) =>
        compareCodePoints(left.task.id, right.task.id),
      );
      const columns = (await loadProjectColumns(record.project.id)).sort((left, right) =>
        compareCodePoints(left.column.id, right.column.id),
      );

      for (const task of tasks) {
        const removed = await documents.delete(PLUGIN_ID, TASK_COLLECTION, task.task.id, {
          expectedVersion: task.document.version,
        });

        if (!removed) {
          throw new TasksStoreValidationError(
            "Задача проекта исчезла во время каскадного удаления",
          );
        }
      }

      for (const column of columns) {
        const removed = await documents.delete(PLUGIN_ID, COLUMN_COLLECTION, column.column.id, {
          expectedVersion: column.document.version,
        });

        if (!removed) {
          throw new TasksStoreValidationError(
            "Колонка проекта исчезла во время каскадного удаления",
          );
        }
      }

      const removedProject = await documents.delete(
        PLUGIN_ID,
        PROJECT_COLLECTION,
        record.project.id,
        { expectedVersion: record.document.version },
      );

      if (!removedProject) {
        throw new TasksStoreValidationError("Проект исчез во время каскадного удаления");
      }

      const deletedTasks = tasks.map((task) => taskDescriptor(task.task));
      const deletedColumns = columns.map((column) => columnDescriptor(column.column));
      const result: DeleteStoreSuccess = {
        deleted: true,
        version: record.project.version,
        eventVersion: deleteEventVersion(record.project.version),
        deletedResourceRefs: [
          formatProjectRef(record.project.id),
          ...deletedTasks.map((descriptor) => descriptor.resourceRef),
          ...deletedColumns.map((descriptor) => descriptor.resourceRef),
        ],
        deletedTasks,
        deletedColumns,
      };

      return result;
    },

    async getColumn(id) {
      return (await loadColumnRecord(id))?.column ?? null;
    },

    async listColumns(query) {
      const pagination = resolvePagination(query.limit, query.offset);
      const projectRecord = await requireProjectRecord(query.projectId);
      // Default-колонки читаются только через `column.list`: для legacy-проекта
      // без документов колонок запрос материализует исходный набор, чтобы не
      // отдавать пустой список и не создавать окно total = 0.
      const columns = sortTaskColumns(
        (await ensureProjectColumns(projectRecord.project)).map((record) => record.column),
      );

      return pageOf(columns, pagination.offset, pagination.limit);
    },

    async createColumn(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion, true);

      if (expectedVersion !== 0) {
        throw new TasksStoreValidationError("Создание колонки требует expectedVersion = 0");
      }

      const projectRecord = await requireProjectRecord(input.projectId);
      const columns = await ensureProjectColumns(projectRecord.project);
      const id = resolveIdentifier(input.id, idFactory?.nextColumnId.bind(idFactory), "ID колонки");
      const existing = await loadColumnRecord(id);

      if (existing !== null) {
        throw new TasksVersionConflictError(0, existing.column.version);
      }

      const createdAt = resolveTimestamp(input.createdAt, now, "createdAt");
      const ordered = columns.map((record) => record.column);
      const index =
        input.position === undefined
          ? ordered.length
          : clampInsertion(assertPosition(input.position), ordered.length);

      for (let position = 0; position < ordered.length; position += 1) {
        const column = ordered[position];

        if (column !== undefined) {
          const record = columns.find((candidate) => candidate.column.id === column.id);

          if (
            record !== undefined &&
            column.position !== (position < index ? position : position + 1)
          ) {
            const shifted = buildColumn({
              ...column,
              position: position < index ? position : position + 1,
              version: column.version + 1,
              updatedAt: createdAt,
            });

            await saveColumn(shifted, record.document.version);
          }
        }
      }

      const column = buildColumn({
        id,
        projectId: input.projectId,
        title: input.title,
        status: columnStatusForType(input.type),
        position: index,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      });
      const saved = await saveColumn(column, 0);

      return saved.column;
    },

    async updateColumn(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await requireColumnRecord(input.id);

      if (record.column.version !== expectedVersion) {
        throw new TasksVersionConflictError(expectedVersion, record.column.version);
      }

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const column = buildColumn({
        ...record.column,
        title: input.title,
        version: record.column.version + 1,
        updatedAt,
      });
      const saved = await saveColumn(column, record.document.version);

      return saved.column;
    },

    async moveColumn(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await requireColumnRecord(input.id);

      if (record.column.version !== expectedVersion) {
        throw new TasksVersionConflictError(expectedVersion, record.column.version);
      }

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const position = assertPosition(input.position);
      const columns = await loadProjectColumns(record.column.projectId);
      const ordered = columns.map((candidate) => candidate.column);
      const others = ordered.filter((candidate) => candidate.id !== record.column.id);
      const index = clampInsertion(position, others.length);
      const finalOrder = [...others.slice(0, index), record.column, ...others.slice(index)];
      let moved: ColumnRecord = record;

      for (let target = 0; target < finalOrder.length; target += 1) {
        const column = finalOrder[target];

        if (column === undefined) {
          continue;
        }

        const source = columns.find((entry) => entry.column.id === column.id);

        if (source === undefined) {
          continue;
        }

        const isMoving = column.id === record.column.id;

        if (!isMoving && column.position === target) {
          continue;
        }

        const next = buildColumn({
          ...column,
          position: target,
          version: column.version + 1,
          updatedAt,
        });
        const saved = await saveColumn(next, source.document.version);

        if (isMoving) {
          moved = saved;
        }
      }

      return moved.column;
    },

    async deleteColumn(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await requireColumnRecord(input.id);

      if (record.column.version !== expectedVersion) {
        throw new TasksVersionConflictError(expectedVersion, record.column.version);
      }

      if (input.targetColumnId === record.column.id) {
        throw new TasksValidationError(
          "COLUMN_TARGET_SELF",
          "Целевая колонка должна отличаться от удаляемой",
        );
      }

      const projectRecord = await requireProjectRecord(record.column.projectId);
      const columns = await loadProjectColumns(record.column.projectId);
      const isDoneColumn = record.column.status === "done";
      const remainingSameType = columns.filter(
        (candidate) =>
          candidate.column.id !== record.column.id &&
          (candidate.column.status === "done") === isDoneColumn,
      );

      if (remainingSameType.length === 0) {
        if (isDoneColumn) {
          throw new TasksValidationError(
            "COLUMN_LAST_DONE",
            "Нельзя удалить последнюю Done-колонку проекта",
          );
        }

        throw new TasksValidationError(
          "COLUMN_LAST_OPEN",
          "Нельзя удалить последнюю открытую колонку проекта",
        );
      }

      const targetRecord = columns.find(
        (candidate) => candidate.column.id === input.targetColumnId,
      );

      if (targetRecord === undefined) {
        const foreign = await loadColumnRecord(input.targetColumnId);

        if (foreign !== null && foreign.column.projectId !== record.column.projectId) {
          throw new TasksValidationError(
            "COLUMN_TARGET_OTHER_PROJECT",
            "Целевая колонка принадлежит другому проекту",
          );
        }

        throw new TasksValidationError("COLUMN_NOT_FOUND", "Целевая колонка не найдена");
      }

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const available = columns.map((entry) => entry.column);
      const sourceTasks = await loadScope(projectRecord.project.id, columns, record.column.id);
      const targetTasks = await loadScope(
        projectRecord.project.id,
        columns,
        targetRecord.column.id,
      );
      // Append идёт за фактический максимум, а не за count: позиции могут быть
      // разреженными и содержать дыры после прошлых операций.
      const appendPosition =
        targetTasks.reduce((max, entry) => Math.max(max, entry.task.position), -1) + 1;
      const movedTasks: Task[] = [];

      for (const source of sourceTasks) {
        const moved = buildTask({
          ...source.task,
          columnId: targetRecord.column.id,
          status: targetRecord.column.status,
          position: appendPosition + movedTasks.length,
          completedAt: resolveCompletedAt(
            targetRecord.column.status,
            source.task.completedAt,
            updatedAt,
          ),
          version: source.task.version + 1,
          updatedAt,
        });
        const saved = await saveTask(moved, source.document.version);

        movedTasks.push(saved.task);
      }

      const remaining = sortTaskColumns(
        available.filter((column) => column.id !== record.column.id),
      );
      const updatedColumns: TaskColumn[] = [];

      for (let position = 0; position < remaining.length; position += 1) {
        const column = remaining[position];

        if (column === undefined || column.position === position) {
          continue;
        }

        const source = columns.find((entry) => entry.column.id === column.id);

        if (source === undefined) {
          continue;
        }

        const shifted = buildColumn({
          ...column,
          position,
          version: column.version + 1,
          updatedAt,
        });
        const saved = await saveColumn(shifted, source.document.version);

        updatedColumns.push(saved.column);
      }

      const removed = await documents.delete(PLUGIN_ID, COLUMN_COLLECTION, record.column.id, {
        expectedVersion: record.document.version,
      });

      if (!removed) {
        throw new TasksStoreValidationError("Колонка исчезла во время удаления");
      }

      const result: ColumnDeleteStoreSuccess = {
        deleted: true,
        column: record.column,
        version: record.column.version,
        eventVersion: deleteEventVersion(record.column.version),
        targetColumnId: targetRecord.column.id,
        movedTasks,
        updatedColumns,
      };

      return result;
    },

    async backfillLegacyColumns() {
      const projectDocuments = await documents.list(PLUGIN_ID, PROJECT_COLLECTION);
      const projects = projectDocuments.map(parseProjectDocument).sort(compareProjects);
      const createdColumns: TaskColumn[] = [];
      const updatedTasks: Task[] = [];

      for (const project of projects) {
        const result = await backfillProject(project);

        createdColumns.push(...result.createdColumns.map((record) => record.column));
        updatedTasks.push(...result.updatedTasks.map((record) => record.task));
      }

      return { createdColumns, updatedTasks };
    },

    async backfillLegacyProject(projectId) {
      const projectRecord = await requireProjectRecord(projectId);
      const result = await backfillProject(projectRecord.project);

      return {
        createdColumns: result.createdColumns.map((record) => record.column),
        updatedTasks: result.updatedTasks.map((record) => record.task),
      };
    },

    async getTask(id) {
      return (await loadTaskRecord(id))?.task ?? null;
    },

    async listTasks(query) {
      const pagination = resolvePagination(query.limit, query.offset);
      const sort = resolveTaskSort(query.sort);
      const tag = query.tag === undefined ? undefined : normalizeTag(query.tag);

      if (query.dueBefore !== undefined && !isUtcTimestamp(query.dueBefore)) {
        throw new TasksStoreValidationError("dueBefore должен быть UTC timestamp");
      }

      if (query.dueAfter !== undefined && !isUtcTimestamp(query.dueAfter)) {
        throw new TasksStoreValidationError("dueAfter должен быть UTC timestamp");
      }

      const indexed: Record<string, JsonValue> = {};

      if (query.projectId !== undefined) {
        indexed.projectId = query.projectId;
      }

      if (query.status !== undefined) {
        indexed.status = query.status;
      }

      if (query.priority !== undefined) {
        indexed.priority = query.priority;
      }

      if (query.parentTaskId !== undefined) {
        indexed.parentTaskId = query.parentTaskId;
      }

      const filter = Object.keys(indexed).length === 0 ? undefined : (indexed as JsonObject);
      let tasks: Task[];

      if (query.columnId === undefined) {
        tasks = (await queryTaskDocuments(filter)).map(parseTaskDocument);
      } else {
        const column = await requireColumnRecord(query.columnId);

        if (query.projectId !== undefined && query.projectId !== column.column.projectId) {
          throw new TasksValidationError(
            "COLUMN_TARGET_OTHER_PROJECT",
            "columnId принадлежит другому проекту",
          );
        }

        const projectRecord = await requireProjectRecord(column.column.projectId);
        const columns = await ensureProjectColumns(projectRecord.project);
        const available = columns.map((record) => record.column);
        const projectTasks = (await loadProjectTasks(projectRecord.project.id)).map(
          (record) => record.task,
        );

        tasks = projectTasks.filter(
          (task) =>
            resolveTaskColumnId(task, available) === column.column.id &&
            (query.status === undefined || task.status === query.status) &&
            (query.priority === undefined || task.priority === query.priority) &&
            (query.parentTaskId === undefined || task.parentTaskId === query.parentTaskId),
        );
      }

      const filtered = tasks.filter(
        (task) =>
          (tag === undefined || task.tags.includes(tag)) &&
          (query.text === undefined || matchesTaskText(task, query.text)) &&
          matchesDueRange(task.dueAt, query.dueBefore, query.dueAfter),
      );

      filtered.sort((left, right) => compareTaskList(left, right, sort));

      return pageOf(filtered, pagination.offset, pagination.limit);
    },

    async createTask(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion, true);

      if (expectedVersion !== 0) {
        throw new TasksStoreValidationError("Создание задачи требует expectedVersion = 0");
      }

      const id = resolveIdentifier(input.id, idFactory?.nextTaskId.bind(idFactory), "ID задачи");
      const projectRecord = await requireProjectRecord(input.projectId);
      let columns = await ensureProjectColumns(projectRecord.project);

      const existing = await loadTaskRecord(id);

      if (existing !== null) {
        throw new TasksVersionConflictError(0, existing.task.version);
      }

      let parentTaskId: string | null = input.parentTaskId ?? null;

      if (parentTaskId !== null) {
        const parent = await loadTaskRecord(parentTaskId);
        const parentValidation = validateSubtaskParent(
          input.projectId,
          parent === null
            ? null
            : {
                id: parent.task.id,
                projectId: parent.task.projectId,
                parentTaskId: parent.task.parentTaskId,
              },
        );

        if (!parentValidation.ok) {
          throw new TasksValidationError(parentValidation.code, parentValidation.message);
        }

        parentTaskId = parentValidation.value.parentTaskId;
      }

      const createdAt = resolveTimestamp(input.createdAt, now, "createdAt");
      let target = resolveTaskColumn(
        columns.map((record) => record.column),
        {
          columnId: input.columnId,
          status: input.status,
        },
      );

      // Явный legacy status без подходящей колонки: лениво материализуем её
      // в этой же транзакции, сохраняя три default-колонки нового проекта.
      if (
        !target.ok &&
        target.code === "COLUMN_NOT_FOUND" &&
        input.columnId === undefined &&
        input.status !== undefined
      ) {
        const materialized = await materializeLegacyStatusColumn(
          projectRecord.project,
          columns,
          input.status,
          createdAt,
        );

        if (materialized.created !== null) {
          columns = materialized.columns;
          target = resolveTaskColumn(
            columns.map((record) => record.column),
            { status: input.status },
          );
        }
      }

      if (!target.ok) {
        throw new TasksValidationError(target.code, target.message);
      }

      const targetColumn = target.value;
      const status = targetColumn.status;
      const completedAt = resolveCompletedAt(status, null, createdAt);
      const records = await loadScope(input.projectId, columns, targetColumn.id);
      const index =
        input.position === undefined
          ? records.length
          : clampInsertion(assertPosition(input.position), records.length);
      const tags = normalizeTags(input.tags);

      for (let position = 0; position < records.length; position += 1) {
        const record = records[position];

        if (record !== undefined) {
          await shiftRecord(record, position < index ? position : position + 1, createdAt);
        }
      }

      const task = buildTask({
        id,
        projectId: input.projectId,
        parentTaskId,
        columnId: targetColumn.id,
        title: input.title,
        descriptionMarkdown: input.descriptionMarkdown,
        status,
        priority: input.priority,
        dueAt: input.dueAt,
        position: index,
        tags,
        version: 1,
        createdAt,
        updatedAt: createdAt,
        completedAt,
      });
      const saved = await saveTask(task, 0);

      return saved.task;
    },

    async updateTask(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await requireTaskRecord(input.id);

      assertTaskVersion(record.task, expectedVersion);

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const task = buildTask({
        ...record.task,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.descriptionMarkdown === undefined
          ? {}
          : { descriptionMarkdown: input.descriptionMarkdown }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        tags: input.tags === undefined ? record.task.tags : normalizeTags(input.tags),
        version: record.task.version + 1,
        updatedAt,
      });
      const saved = await saveTask(task, record.document.version);

      return saved.task;
    },

    async moveTask(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await requireTaskRecord(input.id);

      assertTaskVersion(record.task, expectedVersion);

      const projectRecord = await requireProjectRecord(record.task.projectId);
      let columns = await ensureProjectColumns(projectRecord.project);
      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      let target = resolveTaskColumn(
        columns.map((entry) => entry.column),
        {
          columnId: input.columnId,
          status: input.status,
        },
      );

      // Старый клиент может перемещать задачу по legacy `status`, которого нет
      // среди default-колонок нового проекта. Материализуем её атомарно.
      if (
        !target.ok &&
        target.code === "COLUMN_NOT_FOUND" &&
        input.columnId === undefined &&
        input.status !== undefined
      ) {
        const materialized = await materializeLegacyStatusColumn(
          projectRecord.project,
          columns,
          input.status,
          updatedAt,
        );

        if (materialized.created !== null) {
          columns = materialized.columns;
          target = resolveTaskColumn(
            columns.map((entry) => entry.column),
            { status: input.status },
          );
        }
      }

      if (!target.ok) {
        throw new TasksValidationError(target.code, target.message);
      }

      const position = assertPosition(input.position);
      const completedAt = resolveCompletedAt(
        target.value.status,
        record.task.completedAt,
        updatedAt,
      );

      return relocateRecord(record, columns, target.value, position, completedAt, updatedAt);
    },

    async completeTask(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await requireTaskRecord(input.id);

      assertTaskVersion(record.task, expectedVersion);

      if (record.task.status === "done") {
        return record.task;
      }

      if (input.position !== undefined) {
        assertPosition(input.position);
      }

      const projectRecord = await requireProjectRecord(record.task.projectId);
      const columns = await ensureProjectColumns(projectRecord.project);
      const doneColumn = sortTaskColumns(
        columns.map((entry) => entry.column).filter((column) => column.status === "done"),
      )[0];

      if (doneColumn === undefined) {
        throw new TasksValidationError(
          "DONE_COLUMN_NOT_FOUND",
          "В проекте нет Done-колонки для завершения задачи",
        );
      }

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const completedAt = resolveCompletedAt("done", record.task.completedAt, updatedAt);

      return relocateRecord(record, columns, doneColumn, input.position, completedAt, updatedAt);
    },

    async deleteTask(input) {
      const expectedVersion = assertExpectedVersion(input.expectedVersion);
      const record = await loadTaskRecord(input.id);

      if (record === null) {
        return { deleted: false };
      }

      assertTaskVersion(record.task, expectedVersion);

      const childDocuments = await queryTaskDocuments({ parentTaskId: record.task.id });
      const children = childDocuments
        .map((document) => ({ task: parseTaskDocument(document), document }))
        .sort((left, right) => compareCodePoints(left.task.id, right.task.id));

      for (const child of children) {
        const removed = await documents.delete(PLUGIN_ID, TASK_COLLECTION, child.task.id, {
          expectedVersion: child.document.version,
        });

        if (!removed) {
          throw new TasksStoreValidationError("Подзадача исчезла во время каскадного удаления");
        }
      }

      const removedRoot = await documents.delete(PLUGIN_ID, TASK_COLLECTION, record.task.id, {
        expectedVersion: record.document.version,
      });

      if (!removedRoot) {
        throw new TasksStoreValidationError("Задача исчезла во время удаления");
      }

      const reindexedAt = resolveTimestamp(undefined, now, "updatedAt");

      await reindexScopes([record, ...children], reindexedAt);

      const deletedTasks = [
        taskDescriptor(record.task),
        ...children.map((child) => taskDescriptor(child.task)),
      ];
      const result: DeleteStoreSuccess = {
        deleted: true,
        version: record.task.version,
        eventVersion: deleteEventVersion(record.task.version),
        deletedResourceRefs: deletedTasks.map((descriptor) => descriptor.resourceRef),
        deletedTasks,
        deletedColumns: [],
      };

      return result;
    },
  };
}

/**
 * FIFO-очередь одной transaction-scoped области.
 *
 * Очередь создаётся на каждый `TasksStoreTransaction`, а не глобально:
 * параллельные транзакции разных вызовов по-прежнему сериализуются
 * провайдером. Внутри одной транзакции все scoped-методы, включая чтения,
 * выполняются по одному, поэтому составные read-modify-write операции не
 * перемешиваются.
 *
 * Core-методы вызываются напрямую и не проходят через эту обёртку повторно,
 * поэтому очередь не создаёт реентерабельный deadlock.
 */
class ScopedOperationQueue {
  #tail: Promise<void> = Promise.resolve();

  run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation);

    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}

function createScopedTransaction(
  documents: PluginDocumentStore,
  dependencies: {
    readonly idFactory: TasksIdFactory | undefined;
    readonly now: TasksNowSource | undefined;
  },
): TasksStoreTransaction {
  const core = createCore({
    documents,
    idFactory: dependencies.idFactory,
    now: dependencies.now,
  });
  const queue = new ScopedOperationQueue();

  return {
    documents,
    getProject: (id) => queue.run(() => core.getProject(id)),
    listProjects: (query) => queue.run(() => core.listProjects(query)),
    summarizeProjects: (query) => queue.run(() => core.summarizeProjects(query)),
    createProject: (input) => queue.run(() => core.createProject(input)),
    updateProject: (input) => queue.run(() => core.updateProject(input)),
    deleteProject: (input) => queue.run(() => core.deleteProject(input)),
    getColumn: (id) => queue.run(() => core.getColumn(id)),
    listColumns: (query) => queue.run(() => core.listColumns(query)),
    createColumn: (input) => queue.run(() => core.createColumn(input)),
    updateColumn: (input) => queue.run(() => core.updateColumn(input)),
    moveColumn: (input) => queue.run(() => core.moveColumn(input)),
    deleteColumn: (input) => queue.run(() => core.deleteColumn(input)),
    backfillLegacyColumns: () => queue.run(() => core.backfillLegacyColumns()),
    backfillLegacyProject: (projectId) => queue.run(() => core.backfillLegacyProject(projectId)),
    getTask: (id) => queue.run(() => core.getTask(id)),
    listTasks: (query) => queue.run(() => core.listTasks(query)),
    createTask: (input) => queue.run(() => core.createTask(input)),
    updateTask: (input) => queue.run(() => core.updateTask(input)),
    moveTask: (input) => queue.run(() => core.moveTask(input)),
    completeTask: (input) => queue.run(() => core.completeTask(input)),
    deleteTask: (input) => queue.run(() => core.deleteTask(input)),
    async withTransaction() {
      throw new TasksNestedTransactionError();
    },
  };
}

/**
 * Создаёт backend-neutral реализацию `TasksStore`.
 *
 * Root-методы открывают собственную транзакцию через `PluginStorage`.
 * `withTransaction` передаёт transaction-scoped Store с `documents` этой же
 * транзакции; scoped-методы не открывают вложенную транзакцию.
 *
 * Все scoped-методы одной транзакции, включая чтения, сериализуются локальной
 * FIFO-очередью. Сдвиг соседа по позиции увеличивает его `version` и
 * `updatedAt` и сохраняется через CAS; отдельные события для соседей Store не
 * публикует.
 *
 * Все коллекции принадлежат namespace `kanbaner.tasks`: `projects` и `tasks`.
 * SQL, имена таблиц и драйвер БД в реализации отсутствуют.
 */
export function createTasksStore(options: CreateTasksStoreOptions): TasksStore {
  const { storage, idFactory, now } = options;

  const within = <T>(operation: (core: CoreStore) => Promise<T>): Promise<T> =>
    storage.withTransaction(async (transaction) =>
      operation(createCore({ documents: transaction.documents, idFactory, now })),
    );

  return {
    withTransaction: (callback) =>
      storage.withTransaction(async (transaction) =>
        callback(createScopedTransaction(transaction.documents, { idFactory, now })),
      ),

    getProject: (id) => within((core) => core.getProject(id)),
    listProjects: (query) => within((core) => core.listProjects(query)),
    summarizeProjects: (query) => within((core) => core.summarizeProjects(query)),
    createProject: (input) => within((core) => core.createProject(input)),
    updateProject: (input) => within((core) => core.updateProject(input)),
    deleteProject: (input) => within((core) => core.deleteProject(input)),

    getColumn: (id) => within((core) => core.getColumn(id)),
    listColumns: (query) => within((core) => core.listColumns(query)),
    createColumn: (input) => within((core) => core.createColumn(input)),
    updateColumn: (input) => within((core) => core.updateColumn(input)),
    moveColumn: (input) => within((core) => core.moveColumn(input)),
    deleteColumn: (input) => within((core) => core.deleteColumn(input)),
    backfillLegacyColumns: () => within((core) => core.backfillLegacyColumns()),
    backfillLegacyProject: (projectId) => within((core) => core.backfillLegacyProject(projectId)),

    getTask: (id) => within((core) => core.getTask(id)),
    listTasks: (query) => within((core) => core.listTasks(query)),
    createTask: (input) => within((core) => core.createTask(input)),
    updateTask: (input) => within((core) => core.updateTask(input)),
    moveTask: (input) => within((core) => core.moveTask(input)),
    completeTask: (input) => within((core) => core.completeTask(input)),
    deleteTask: (input) => within((core) => core.deleteTask(input)),
  };
}
