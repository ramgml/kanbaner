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

import { PLUGIN_ID, PROJECT_COLLECTION, TASK_COLLECTION } from "../constants.ts";
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
  TaskSchema,
  deleteEventVersion,
  type DeletedTaskDescriptor,
  type Project,
  type Task,
  type TaskSort,
  type TaskStatus,
} from "../model.ts";
import { formatProjectRef, formatTaskRef } from "../resources.ts";
import type { ProjectSummary, ProjectSummaryTotals, TaskStatusCounts } from "../schemas/queries.ts";
import {
  TasksValidationError,
  assertStoredTask,
  normalizeTag,
  normalizeTags,
  resolveCompletedAt,
  taskPositionScopeKey,
  validateExpectedVersion,
  validatePagination,
  validatePosition,
  validateSubtaskParent,
} from "../validation.ts";
import {
  TasksNestedTransactionError,
  type CompleteTaskStoreInput,
  type CreateProjectStoreInput,
  type CreateTaskStoreInput,
  type DeleteProjectStoreInput,
  type DeleteStoreResult,
  type DeleteStoreSuccess,
  type DeleteTaskStoreInput,
  type MoveTaskStoreInput,
  type ProjectStoreQuery,
  type ProjectSummaryStorePage,
  type ProjectSummaryStoreQuery,
  type StorePage,
  type TasksIdFactory,
  type TasksStore,
  type TasksStoreTransaction,
  type TaskStoreQuery,
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

  if (task.id !== document.id || task.version !== document.version) {
    throw new TasksStoreValidationError(
      "Документ задачи и публичная версия не совпадают с сохранённой моделью",
    );
  }

  return task;
}

function taskIndexedFields(task: Task): JsonObject {
  return {
    projectId: task.projectId,
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

  async function loadScope(projectId: string, status: TaskStatus): Promise<TaskRecord[]> {
    const documentsInScope = await queryTaskDocuments({ projectId, status });

    return documentsInScope
      .map((document) => ({ task: parseTaskDocument(document), document }))
      .sort(compareTaskRecords);
  }

  async function loadProjectTasks(projectId: string): Promise<TaskRecord[]> {
    const projectTasks = await queryTaskDocuments({ projectId });

    return projectTasks.map((document) => ({ task: parseTaskDocument(document), document }));
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

    if (document.version !== task.version) {
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
    const scopes = new Map<string, { readonly projectId: string; readonly status: TaskStatus }>();

    for (const record of records) {
      scopes.set(taskPositionScopeKey(record.task.projectId, record.task.status), {
        projectId: record.task.projectId,
        status: record.task.status,
      });
    }

    for (const scope of scopes.values()) {
      const remaining = await loadScope(scope.projectId, scope.status);

      for (let index = 0; index < remaining.length; index += 1) {
        const record = remaining[index];

        if (record !== undefined) {
          await shiftRecord(record, index, updatedAt);
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
    targetStatus: TaskStatus,
    insertion: number | undefined,
    completedAt: UtcTimestamp | null,
    updatedAt: UtcTimestamp,
  ): Promise<Task> {
    const current = record.task;
    let index: number;

    if (targetStatus === current.status) {
      const others = (await loadScope(current.projectId, current.status)).filter(
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
      const sourceRemaining = (await loadScope(current.projectId, current.status)).filter(
        (candidate) => candidate.task.id !== current.id,
      );

      for (let position = 0; position < sourceRemaining.length; position += 1) {
        const candidate = sourceRemaining[position];

        if (candidate !== undefined) {
          await shiftRecord(candidate, position, updatedAt);
        }
      }

      const targetRecords = await loadScope(current.projectId, targetStatus);
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
      status: targetStatus,
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
      const result: DeleteStoreSuccess = {
        deleted: true,
        version: record.project.version,
        eventVersion: deleteEventVersion(record.project.version),
        deletedResourceRefs: [
          formatProjectRef(record.project.id),
          ...deletedTasks.map((descriptor) => descriptor.resourceRef),
        ],
        deletedTasks,
      };

      return result;
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
      const taskDocuments = await queryTaskDocuments(filter);
      const tasks = taskDocuments.map(parseTaskDocument);
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
      await requireProjectRecord(input.projectId);

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
      const status = input.status;
      const completedAt = resolveCompletedAt(status, null, createdAt);
      const records = await loadScope(input.projectId, status);
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

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const position = assertPosition(input.position);
      const completedAt = resolveCompletedAt(input.status, record.task.completedAt, updatedAt);

      return relocateRecord(record, input.status, position, completedAt, updatedAt);
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

      const updatedAt = resolveTimestamp(input.updatedAt, now, "updatedAt");
      const completedAt = resolveCompletedAt("done", record.task.completedAt, updatedAt);

      return relocateRecord(record, "done", input.position, completedAt, updatedAt);
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

    getTask: (id) => within((core) => core.getTask(id)),
    listTasks: (query) => within((core) => core.listTasks(query)),
    createTask: (input) => within((core) => core.createTask(input)),
    updateTask: (input) => within((core) => core.updateTask(input)),
    moveTask: (input) => within((core) => core.moveTask(input)),
    completeTask: (input) => within((core) => core.completeTask(input)),
    deleteTask: (input) => within((core) => core.deleteTask(input)),
  };
}
