import {
  type CommandMetadata,
  type EventEnvelope,
  type ExecutionContext,
  type JsonValue,
  type PluginActivationServices,
  type PluginId,
  type PluginLogger,
  type PluginSearchService,
  type QueryMetadata,
  type ResourceDescriptor,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import {
  COLUMN_EVENT_TYPES,
  COLUMN_RESOURCE_TYPE,
  DEFAULT_LIST_LIMIT,
  PLUGIN_ID,
  PROJECT_EVENT_TYPES,
  PROJECT_RESOURCE_TYPE,
  TASK_EVENT_TYPES,
  TASK_RESOURCE_TYPE,
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
} from "./constants.ts";
import { domainEvent, eventPayload, publishDomainEvents } from "./activation/events.ts";
import { deleteTasksInBulk, moveTasksInBulk } from "./activation/bulk.ts";
import {
  checkIdempotency,
  hashIdempotencyInput,
  saveIdempotency,
} from "./activation/idempotency.ts";
import { runMapped } from "./activation/errors.ts";
import { createSerialQueue } from "./activation/serial-queue.ts";
import {
  deleteSearchDocuments,
  reindexAllTasks,
  upsertTaskSearchDocuments,
} from "./activation/search-index.ts";
import {
  createdColumns,
  shiftedColumns,
  shiftedNeighbors,
  snapshotProjectColumns,
  snapshotProjectTasks,
} from "./activation/snapshots.ts";
import type {
  DeletedColumnDescriptor,
  DeletedTaskDescriptor,
  Project,
  Task,
  TaskColumn,
} from "./model.ts";
import { TASKS_COMMAND_LIST, TASKS_QUERY_LIST } from "./operations.ts";
import type {
  ColumnCreateInput,
  ColumnDeleteInput,
  ColumnDeleteOutput,
  ColumnMoveInput,
  ColumnUpdateInput,
} from "./schemas/column.ts";
import type {
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectUpdateInput,
} from "./schemas/project.ts";
import type { DeleteOutput } from "./schemas/common.ts";
import type { BoardColor } from "./schemas/board-color.ts";
import type {
  ColumnListInput,
  ProjectListInput,
  ProjectSummaryInput,
  TaskListInput,
} from "./schemas/queries.ts";
import type {
  TaskCompleteInput,
  TaskCreateInput,
  TaskDeleteManyInput,
  TaskDeleteManyOutput,
  TaskDeleteInput,
  TaskMoveInput,
  TaskMoveManyInput,
  TaskMoveManyOutput,
  TaskUpdateInput,
} from "./schemas/task.ts";
import {
  formatColumnRef,
  formatProjectRef,
  formatTaskRef,
  tryParseTasksResourceRef,
} from "./resources.ts";
import {
  TasksNotFoundError,
  TasksStoreValidationError,
  TasksVersionConflictError,
  createTasksStore,
} from "./store/index.ts";
import type { TasksIdFactory, TasksStore, TasksStoreTransaction } from "./store.ts";
import { normalizeTags } from "./validation.ts";

/** Структурный логгер runtime ядра без зависимости от его типа. */
interface RuntimeLoggerLike {
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ): void | Promise<void>;
}

/**
 * Публичный контекст активации.
 *
 * Runtime передаёт bound-сервисы `PluginActivationServices` и `pluginId`.
 * `logger` допускает как SDK `PluginLogger`, так и структурный runtime-логгер
 * ядра с методом `log`; активация приводит его к `PluginLogger`.
 */
export interface TasksActivationContext extends PluginActivationServices {
  readonly pluginId: PluginId;
  readonly logger?: PluginLogger | RuntimeLoggerLike;
}

/** Эффекты команды, применяемые только после успешного коммита. */
interface MutationEffects {
  readonly events: readonly ReturnType<typeof domainEvent>[];
  readonly searchUpserts: readonly Task[];
  readonly searchDeleteRefs: readonly ReturnType<typeof formatTaskRef>[];
}

interface MutationOutcome<Result> {
  readonly result: Result;
  readonly effects: MutationEffects;
}

/** Результат команды: данные для ответа и события после коммита. */
interface CommandExecution<Result = unknown> {
  readonly result: Result;
  readonly events: readonly EventEnvelope[];
}

type CommandFn = (
  input: unknown,
  executionContext: ExecutionContext,
  operationId: string,
  dependencies: ActivationDependencies,
) => Promise<CommandExecution>;

type QueryFn = (input: unknown, dependencies: ActivationDependencies) => Promise<unknown>;

interface ActivationDependencies {
  readonly store: TasksStore;
  readonly search: PluginSearchService;
  readonly now: () => UtcTimestamp;
  readonly idFactory: TasksIdFactory;
  readonly logger: PluginLogger;
}

const NOOP_LOGGER: PluginLogger = Object.freeze({
  debug(): void {
    // Намеренно пусто.
  },
  info(): void {
    // Намеренно пусто.
  },
  warn(): void {
    // Намеренно пусто.
  },
  error(): void {
    // Намеренно пусто.
  },
});

function isPluginLogger(logger: PluginLogger | RuntimeLoggerLike): logger is PluginLogger {
  const candidate = logger as Partial<PluginLogger>;

  return (
    typeof candidate.debug === "function" &&
    typeof candidate.info === "function" &&
    typeof candidate.warn === "function" &&
    typeof candidate.error === "function"
  );
}

/** Приводит SDK-логгер или структурный runtime-логгер к `PluginLogger`. */
function normalizeLogger(logger: PluginLogger | RuntimeLoggerLike | undefined): PluginLogger {
  if (logger === undefined) {
    return NOOP_LOGGER;
  }

  if (isPluginLogger(logger)) {
    return logger;
  }

  const runtime = logger;
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    try {
      void Promise.resolve(
        runtime.log(level, message, fields as Readonly<Record<string, JsonValue>> | undefined),
      ).catch(() => {
        // Ошибка логгера не влияет на результат операции.
      });
    } catch {
      // Ошибка логгера не влияет на результат операции.
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

function newEventId(): string {
  return globalThis.crypto.randomUUID();
}

function noEffects(): MutationEffects {
  return { events: [], searchUpserts: [], searchDeleteRefs: [] };
}

function effects(input: Partial<MutationEffects>): MutationEffects {
  return {
    events: input.events ?? [],
    searchUpserts: input.searchUpserts ?? [],
    searchDeleteRefs: input.searchDeleteRefs ?? [],
  };
}

function changedTaskFields(before: Task, after: Task): readonly string[] {
  const changed: string[] = [];

  if (before.title !== after.title) {
    changed.push("title");
  }

  if (before.descriptionMarkdown !== after.descriptionMarkdown) {
    changed.push("descriptionMarkdown");
  }

  if (before.priority !== after.priority) {
    changed.push("priority");
  }

  if (before.dueAt !== after.dueAt) {
    changed.push("dueAt");
  }

  if (before.tags.join("\u0000") !== after.tags.join("\u0000")) {
    changed.push("tags");
  }

  return changed;
}

/** Поля проекта, доступные `project.update`; порядок стабилен для события. */
export function changedProjectFields(before: Project, after: Project): readonly string[] {
  const changed: string[] = [];

  if (before.title !== after.title) {
    changed.push("title");
  }

  if (before.descriptionMarkdown !== after.descriptionMarkdown) {
    changed.push("descriptionMarkdown");
  }

  if (before.color !== after.color) {
    changed.push("color");
  }

  return changed;
}

/**
 * Идемпотентный color-only update: заголовок и (для проекта) описание не
 * переданы, а цвет совпадает с сохранённым. Такая команда не повышает версию и
 * не публикует событие. Title-only update сохраняет прежнюю семантику и
 * повышает версию даже при совпадающем заголовке.
 */
export function isSameColorOnlyPatch(
  patch: {
    readonly title?: string | undefined;
    readonly descriptionMarkdown?: string | undefined;
    readonly color?: BoardColor | undefined;
  },
  current: { readonly color?: BoardColor | undefined },
): boolean {
  return (
    patch.color !== undefined &&
    patch.title === undefined &&
    patch.descriptionMarkdown === undefined &&
    patch.color === current.color
  );
}

/** Поля колонки, доступные `column.update`; порядок стабилен для события. */
export function changedColumnFields(before: TaskColumn, after: TaskColumn): readonly string[] {
  const changed: string[] = [];

  if (before.title !== after.title) {
    changed.push("title");
  }

  if (before.color !== after.color) {
    changed.push("color");
  }

  return changed;
}

function taskDeletedEvent(
  descriptor: DeletedTaskDescriptor,
  deletedTasks: readonly DeletedTaskDescriptor[],
  eventId?: string,
) {
  return domainEvent({
    ...(eventId === undefined ? {} : { eventId }),
    type: TASK_EVENT_TYPES.deleted,
    resource: descriptor.resourceRef,
    resourceVersion: descriptor.eventVersion,
    payload: eventPayload({
      taskId: descriptor.id,
      projectId: descriptor.projectId,
      version: descriptor.version,
      eventVersion: descriptor.eventVersion,
      deletedTasks,
    }),
  });
}

/** Событие сдвинутого соседа: позиция и версия уже новые. */
function neighborUpdatedEvent(task: Task) {
  return domainEvent({
    type: TASK_EVENT_TYPES.updated,
    resource: formatTaskRef(task.id),
    resourceVersion: task.version,
    payload: eventPayload({
      taskId: task.id,
      projectId: task.projectId,
      version: task.version,
      ...(task.columnId === undefined ? {} : { columnId: task.columnId }),
      status: task.status,
      position: task.position,
      changed: ["position"],
    }),
  });
}

function columnCreatedEvent(column: TaskColumn, eventId: string) {
  return domainEvent({
    eventId,
    type: COLUMN_EVENT_TYPES.created,
    resource: formatColumnRef(column.id),
    resourceVersion: column.version,
    payload: eventPayload({
      columnId: column.id,
      projectId: column.projectId,
      version: column.version,
      title: column.title,
      type: column.status === "done" ? "done" : "open",
      status: column.status,
      position: column.position,
    }),
  });
}

function columnUpdatedEvent(column: TaskColumn, changed: readonly string[]) {
  return domainEvent({
    type: COLUMN_EVENT_TYPES.updated,
    resource: formatColumnRef(column.id),
    resourceVersion: column.version,
    payload: eventPayload({
      columnId: column.id,
      projectId: column.projectId,
      version: column.version,
      position: column.position,
      changed,
    }),
  });
}

function columnMovedEvent(column: TaskColumn, fromPosition: number, eventId: string) {
  return domainEvent({
    eventId,
    type: COLUMN_EVENT_TYPES.moved,
    resource: formatColumnRef(column.id),
    resourceVersion: column.version,
    payload: eventPayload({
      columnId: column.id,
      projectId: column.projectId,
      version: column.version,
      fromPosition,
      toPosition: column.position,
    }),
  });
}

function columnDeletedEvent(
  descriptor: DeletedColumnDescriptor,
  targetColumnId?: string,
  movedTaskIds?: readonly string[],
) {
  return domainEvent({
    type: COLUMN_EVENT_TYPES.deleted,
    resource: descriptor.resourceRef,
    resourceVersion: descriptor.eventVersion,
    payload: eventPayload({
      columnId: descriptor.id,
      projectId: descriptor.projectId,
      version: descriptor.version,
      eventVersion: descriptor.eventVersion,
      ...(targetColumnId === undefined ? {} : { targetColumnId }),
      ...(movedTaskIds === undefined ? {} : { movedTaskIds }),
    }),
  });
}

function taskCreatedEvent(task: Task, eventId: string) {
  return domainEvent({
    eventId,
    type: TASK_EVENT_TYPES.created,
    resource: formatTaskRef(task.id),
    resourceVersion: task.version,
    payload: eventPayload({
      taskId: task.id,
      projectId: task.projectId,
      version: task.version,
      parentTaskId: task.parentTaskId,
      ...(task.columnId === undefined ? {} : { columnId: task.columnId }),
      status: task.status,
      position: task.position,
    }),
  });
}

function taskMovedEvent(
  task: Task,
  from: { readonly status: Task["status"]; readonly columnId: string | undefined },
  eventId: string,
) {
  return domainEvent({
    eventId,
    type: TASK_EVENT_TYPES.moved,
    resource: formatTaskRef(task.id),
    resourceVersion: task.version,
    payload: eventPayload({
      taskId: task.id,
      projectId: task.projectId,
      version: task.version,
      ...(from.columnId === undefined ? {} : { fromColumnId: from.columnId }),
      ...(task.columnId === undefined ? {} : { toColumnId: task.columnId }),
      fromStatus: from.status,
      toStatus: task.status,
      position: task.position,
    }),
  });
}

function taskCompletedEvent(task: Task, completedAt: UtcTimestamp, eventId: string) {
  return domainEvent({
    eventId,
    type: TASK_EVENT_TYPES.completed,
    resource: formatTaskRef(task.id),
    resourceVersion: task.version,
    payload: eventPayload({
      taskId: task.id,
      projectId: task.projectId,
      version: task.version,
      ...(task.columnId === undefined ? {} : { columnId: task.columnId }),
      completedAt,
    }),
  });
}

/**
 * Выполняет команду с Idempotency-Key и отложенными эффектами.
 *
 * Проверка ключа, доменная мутация и запись успешного результата выполняются
 * в одной транзакции `TasksStore`. Поисковые эффекты применяются сразу после
 * коммита внутри вызывающей очереди, а события возвращаются вызывающей
 * стороне для публикации после выхода из очереди. Повтор с тем же ключом
 * возвращает сохранённый результат без мутации, событий и повторного
 * индексирования.
 */
async function executeMutation<Result>(
  dependencies: ActivationDependencies,
  executionContext: ExecutionContext,
  operationId: string,
  normalizedInput: unknown,
  work: (transaction: TasksStoreTransaction, now: UtcTimestamp) => Promise<MutationOutcome<Result>>,
): Promise<CommandExecution<Result>> {
  const idempotencyKey = executionContext.idempotencyKey;
  const inputHash = idempotencyKey === undefined ? null : hashIdempotencyInput(normalizedInput);
  const now = dependencies.now();

  const outcome = await dependencies.store.withTransaction(async (transaction) => {
    let expectedVersion = 0;

    if (idempotencyKey !== undefined && inputHash !== null) {
      const check = await checkIdempotency(transaction.documents, {
        operationId,
        idempotencyKey,
        inputHash,
        now,
      });

      if (check.status === "replay") {
        return { replay: true as const, result: check.result as Result };
      }

      expectedVersion = check.expectedVersion;
    }

    const executed = await work(transaction, now);

    if (idempotencyKey !== undefined && inputHash !== null) {
      await saveIdempotency(
        transaction.documents,
        {
          operationId,
          idempotencyKey,
          inputHash,
          result: executed.result as unknown as JsonValue,
          now,
        },
        expectedVersion,
      );
    }

    return { replay: false as const, executed };
  });

  if (outcome.replay) {
    return { result: outcome.result, events: [] };
  }

  await applySearchEffects(dependencies, outcome.executed.effects);

  return {
    result: outcome.executed.result,
    events: outcome.executed.effects.events,
  };
}

/**
 * Применяет поисковые эффекты после коммита в детерминированном порядке:
 * сначала upsert, затем delete. Вызывается внутри очереди активации, чтобы
 * соседняя мутация не перезаписала индекс устаревшим снимком.
 */
async function applySearchEffects(
  dependencies: ActivationDependencies,
  mutationEffects: MutationEffects,
): Promise<void> {
  await upsertTaskSearchDocuments(
    dependencies.search,
    mutationEffects.searchUpserts,
    dependencies.logger,
  );
  await deleteSearchDocuments(
    dependencies.search,
    mutationEffects.searchDeleteRefs,
    dependencies.logger,
  );
}

/* ------------------------------------------------------------------------- */
/* Команды                                                                    */
/* ------------------------------------------------------------------------- */

const projectCreate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as ProjectCreateInput;
  const normalized = {
    title: data.title,
    descriptionMarkdown: data.descriptionMarkdown ?? "",
    ...(data.color === undefined ? {} : { color: data.color }),
    expectedVersion: 0 as const,
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const project = await transaction.createProject({
        id: dependencies.idFactory.nextProjectId(),
        title: normalized.title,
        descriptionMarkdown: normalized.descriptionMarkdown,
        ...(normalized.color === undefined ? {} : { color: normalized.color }),
        createdAt: now,
        expectedVersion: normalized.expectedVersion,
      });
      const eventId = newEventId();
      const resource = formatProjectRef(project.id);
      const event = domainEvent({
        eventId,
        type: PROJECT_EVENT_TYPES.created,
        resource,
        resourceVersion: project.version,
        payload: eventPayload({
          projectId: project.id,
          version: project.version,
          title: project.title,
        }),
      });

      return {
        result: { project, resource, eventId },
        effects: effects({ events: [event] }),
      };
    },
  );
};

const projectUpdate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as ProjectUpdateInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.descriptionMarkdown === undefined
      ? {}
      : { descriptionMarkdown: data.descriptionMarkdown }),
    ...(data.color === undefined ? {} : { color: data.color }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await transaction.getProject(normalized.id);

      if (before === null) {
        throw new TasksNotFoundError("project", normalized.id);
      }

      if (isSameColorOnlyPatch(data, before)) {
        if (before.version !== normalized.expectedVersion) {
          throw new TasksVersionConflictError(normalized.expectedVersion, before.version);
        }

        // Событие не публикуется, но контракт выхода требует eventId.
        return {
          result: { project: before, resource: formatProjectRef(before.id), eventId: newEventId() },
          effects: noEffects(),
        };
      }

      const project = await transaction.updateProject({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.descriptionMarkdown === undefined
          ? {}
          : { descriptionMarkdown: data.descriptionMarkdown }),
        ...(data.color === undefined ? {} : { color: data.color }),
        updatedAt: now,
      });
      const eventId = newEventId();
      const resource = formatProjectRef(project.id);
      const event = domainEvent({
        eventId,
        type: PROJECT_EVENT_TYPES.updated,
        resource,
        resourceVersion: project.version,
        payload: eventPayload({
          projectId: project.id,
          version: project.version,
          changed: changedProjectFields(before, project),
        }),
      });

      return {
        result: { project, resource, eventId },
        effects: effects({ events: [event] }),
      };
    },
  );
};

const projectDelete: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as ProjectDeleteInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    confirm: true as const,
  };

  return executeMutation<DeleteOutput>(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction) => {
      const deletion = await transaction.deleteProject({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
      });

      if (!deletion.deleted) {
        return { result: { deleted: false as const }, effects: noEffects() };
      }

      const resource = formatProjectRef(normalized.id);
      const eventId = newEventId();
      const events = [
        domainEvent({
          eventId,
          type: PROJECT_EVENT_TYPES.deleted,
          resource,
          resourceVersion: deletion.eventVersion,
          payload: eventPayload({
            projectId: normalized.id,
            version: deletion.version,
            eventVersion: deletion.eventVersion,
            deletedTasks: deletion.deletedTasks,
            deletedColumns: deletion.deletedColumns,
          }),
        }),
        ...deletion.deletedTasks.map((descriptor) => taskDeletedEvent(descriptor, [descriptor])),
        ...deletion.deletedColumns.map((descriptor) => columnDeletedEvent(descriptor)),
      ];

      return {
        result: {
          deleted: true as const,
          resource,
          version: deletion.version,
          eventVersion: deletion.eventVersion,
          deletedResourceRefs: [...deletion.deletedResourceRefs],
          deletedTasks: [...deletion.deletedTasks],
          eventId,
        },
        effects: effects({
          events,
          searchDeleteRefs: deletion.deletedResourceRefs,
        }),
      };
    },
  );
};

const columnCreate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as ColumnCreateInput;
  const normalized = {
    projectId: data.projectId,
    title: data.title,
    type: data.type,
    ...(data.color === undefined ? {} : { color: data.color }),
    expectedVersion: 0 as const,
    ...(data.position === undefined ? {} : { position: data.position }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await snapshotProjectColumns(transaction, normalized.projectId);
      const column = await transaction.createColumn({
        id: dependencies.idFactory.nextColumnId(),
        projectId: normalized.projectId,
        title: normalized.title,
        type: normalized.type,
        ...(normalized.color === undefined ? {} : { color: normalized.color }),
        ...(normalized.position === undefined ? {} : { position: normalized.position }),
        createdAt: now,
        expectedVersion: normalized.expectedVersion,
      });
      const after = await snapshotProjectColumns(transaction, column.projectId);
      const neighbors = shiftedColumns(before, after, column.id);
      const eventId = newEventId();

      return {
        result: { column, resource: formatColumnRef(column.id), eventId },
        effects: effects({
          events: [
            columnCreatedEvent(column, eventId),
            ...neighbors.map((entry) => columnUpdatedEvent(entry, ["position"])),
          ],
        }),
      };
    },
  );
};

const columnUpdate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as ColumnUpdateInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.color === undefined ? {} : { color: data.color }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await transaction.getColumn(normalized.id);

      if (before === null) {
        throw new TasksNotFoundError("column", normalized.id);
      }

      if (isSameColorOnlyPatch(data, before)) {
        if (before.version !== normalized.expectedVersion) {
          throw new TasksVersionConflictError(normalized.expectedVersion, before.version);
        }

        // No-op без записи и события; eventId оставлен ради контракта выхода.
        return {
          result: { column: before, resource: formatColumnRef(before.id), eventId: newEventId() },
          effects: noEffects(),
        };
      }

      const column = await transaction.updateColumn({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.color === undefined ? {} : { color: data.color }),
        updatedAt: now,
      });
      const eventId = newEventId();

      return {
        result: { column, resource: formatColumnRef(column.id), eventId },
        effects: effects({
          events: [columnUpdatedEvent(column, changedColumnFields(before, column))],
        }),
      };
    },
  );
};

const columnMove: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as ColumnMoveInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    position: data.position,
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await transaction.getColumn(normalized.id);

      if (before === null) {
        throw new TasksNotFoundError("column", normalized.id);
      }

      const beforeColumns = await snapshotProjectColumns(transaction, before.projectId);
      const column = await transaction.moveColumn({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        position: normalized.position,
        updatedAt: now,
      });
      const afterColumns = await snapshotProjectColumns(transaction, column.projectId);
      const neighbors = shiftedColumns(beforeColumns, afterColumns, column.id);
      const eventId = newEventId();

      return {
        result: { column, resource: formatColumnRef(column.id), eventId },
        effects: effects({
          events: [
            columnMovedEvent(column, before.position, eventId),
            ...neighbors.map((entry) => columnUpdatedEvent(entry, ["position"])),
          ],
        }),
      };
    },
  );
};

const columnDelete: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as ColumnDeleteInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    targetColumnId: data.targetColumnId,
    confirm: true as const,
  };

  return executeMutation<ColumnDeleteOutput>(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await transaction.getColumn(normalized.id);
      const beforeTasks =
        before === null
          ? new Map<string, Task>()
          : await snapshotProjectTasks(transaction, before.projectId);
      const deletion = await transaction.deleteColumn({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        targetColumnId: normalized.targetColumnId,
        updatedAt: now,
      });

      if (!deletion.deleted) {
        return { result: { deleted: false as const }, effects: noEffects() };
      }

      if (before === null) {
        throw new TasksNotFoundError("column", normalized.id);
      }

      const descriptor: DeletedColumnDescriptor = {
        id: before.id,
        projectId: before.projectId,
        resourceRef: formatColumnRef(before.id),
        version: deletion.version,
        eventVersion: deletion.eventVersion,
      };
      const eventId = newEventId();
      const movedEvents = deletion.movedTasks.map((task) => {
        const previous = beforeTasks.get(task.id);

        if (previous === undefined || previous.columnId === task.columnId) {
          return neighborUpdatedEvent(task);
        }

        return taskMovedEvent(
          task,
          { status: previous.status, columnId: previous.columnId },
          newEventId(),
        );
      });
      const events = [
        columnDeletedEvent(
          descriptor,
          deletion.targetColumnId,
          deletion.movedTasks.map((task) => task.id),
        ),
        ...deletion.updatedColumns.map((column) => columnUpdatedEvent(column, ["position"])),
        ...movedEvents,
      ];

      return {
        result: {
          deleted: true as const,
          resource: descriptor.resourceRef,
          version: deletion.version,
          eventVersion: deletion.eventVersion,
          targetColumnId: deletion.targetColumnId,
          movedTasks: [...deletion.movedTasks],
          eventId,
        },
        effects: effects({
          events,
          searchUpserts: [...deletion.movedTasks],
        }),
      };
    },
  );
};

const taskCreate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskCreateInput;
  const normalized = {
    projectId: data.projectId,
    parentTaskId: data.parentTaskId ?? null,
    title: data.title,
    descriptionMarkdown: data.descriptionMarkdown ?? "",
    ...(data.columnId === undefined ? {} : { columnId: data.columnId }),
    ...(data.status === undefined
      ? data.columnId === undefined
        ? { status: "todo" as const }
        : {}
      : { status: data.status }),
    priority: data.priority ?? "medium",
    dueAt: data.dueAt ?? null,
    tags: normalizeTags(data.tags ?? []),
    expectedVersion: 0 as const,
    ...(data.position === undefined ? {} : { position: data.position }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await snapshotProjectTasks(transaction, normalized.projectId);
      const beforeColumns = await snapshotProjectColumns(transaction, normalized.projectId);
      const task = await transaction.createTask({
        id: dependencies.idFactory.nextTaskId(),
        projectId: normalized.projectId,
        parentTaskId: normalized.parentTaskId,
        ...(normalized.columnId === undefined ? {} : { columnId: normalized.columnId }),
        title: normalized.title,
        descriptionMarkdown: normalized.descriptionMarkdown,
        ...(normalized.status === undefined ? {} : { status: normalized.status }),
        priority: normalized.priority,
        dueAt: normalized.dueAt,
        tags: normalized.tags,
        createdAt: now,
        expectedVersion: normalized.expectedVersion,
        ...(normalized.position === undefined ? {} : { position: normalized.position }),
      });
      const after = await snapshotProjectTasks(transaction, normalized.projectId);
      const afterColumns = await snapshotProjectColumns(transaction, normalized.projectId);
      const neighbors = shiftedNeighbors(before, after, task.id);
      const materialized = createdColumns(beforeColumns, afterColumns);
      const shiftedColumnsByMaterialization = shiftedColumns(beforeColumns, afterColumns, null);
      const eventId = newEventId();

      return {
        result: { task, resource: formatTaskRef(task.id), eventId },
        effects: effects({
          events: [
            ...materialized.map((column) => columnCreatedEvent(column, newEventId())),
            ...shiftedColumnsByMaterialization.map((column) =>
              columnUpdatedEvent(column, ["position"]),
            ),
            taskCreatedEvent(task, eventId),
            ...neighbors.map(neighborUpdatedEvent),
          ],
          searchUpserts: [task, ...neighbors],
        }),
      };
    },
  );
};

const taskUpdate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskUpdateInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.descriptionMarkdown === undefined
      ? {}
      : { descriptionMarkdown: data.descriptionMarkdown }),
    ...(data.priority === undefined ? {} : { priority: data.priority }),
    ...(data.dueAt === undefined ? {} : { dueAt: data.dueAt }),
    ...(data.tags === undefined ? {} : { tags: normalizeTags(data.tags) }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await transaction.getTask(normalized.id);

      if (before === null) {
        throw new TasksNotFoundError("task", normalized.id);
      }

      const task = await transaction.updateTask({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.descriptionMarkdown === undefined
          ? {}
          : { descriptionMarkdown: data.descriptionMarkdown }),
        ...(data.priority === undefined ? {} : { priority: data.priority }),
        ...(data.dueAt === undefined ? {} : { dueAt: data.dueAt }),
        ...(normalized.tags === undefined ? {} : { tags: normalized.tags }),
        updatedAt: now,
      });
      const eventId = newEventId();
      const event = domainEvent({
        eventId,
        type: TASK_EVENT_TYPES.updated,
        resource: formatTaskRef(task.id),
        resourceVersion: task.version,
        payload: eventPayload({
          taskId: task.id,
          projectId: task.projectId,
          version: task.version,
          changed: changedTaskFields(before, task),
        }),
      });

      return {
        result: { task, resource: formatTaskRef(task.id), eventId },
        effects: effects({ events: [event], searchUpserts: [task] }),
      };
    },
  );
};

const taskMove: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskMoveInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    ...(data.columnId === undefined ? {} : { columnId: data.columnId }),
    ...(data.status === undefined ? {} : { status: data.status }),
    position: data.position,
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const current = await transaction.getTask(normalized.id);

      if (current === null) {
        throw new TasksNotFoundError("task", normalized.id);
      }

      const before = await snapshotProjectTasks(transaction, current.projectId);
      const beforeColumns = await snapshotProjectColumns(transaction, current.projectId);
      const task = await transaction.moveTask({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        ...(normalized.columnId === undefined ? {} : { columnId: normalized.columnId }),
        ...(normalized.status === undefined ? {} : { status: normalized.status }),
        position: normalized.position,
        updatedAt: now,
      });
      const after = await snapshotProjectTasks(transaction, current.projectId);
      const afterColumns = await snapshotProjectColumns(transaction, current.projectId);
      const neighbors = shiftedNeighbors(before, after, task.id);
      const materialized = createdColumns(beforeColumns, afterColumns);
      const shiftedColumnsByMaterialization = shiftedColumns(beforeColumns, afterColumns, null);
      const eventId = newEventId();

      return {
        result: { task, resource: formatTaskRef(task.id), eventId },
        effects: effects({
          events: [
            ...materialized.map((column) => columnCreatedEvent(column, newEventId())),
            ...shiftedColumnsByMaterialization.map((column) =>
              columnUpdatedEvent(column, ["position"]),
            ),
            taskMovedEvent(task, { status: current.status, columnId: current.columnId }, eventId),
            ...neighbors.map(neighborUpdatedEvent),
          ],
          searchUpserts: [task, ...neighbors],
        }),
      };
    },
  );
};

const taskMoveMany: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskMoveManyInput;
  const normalized = {
    items: data.items.map((item) => ({
      id: item.id,
      expectedVersion: item.expectedVersion,
    })),
    columnId: data.columnId,
  };

  return executeMutation<TaskMoveManyOutput>(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const execution = await moveTasksInBulk(
        transaction,
        normalized.items,
        normalized.columnId,
        now,
      );
      const events = [
        ...execution.moved.map(({ task, before }) =>
          taskMovedEvent(task, { status: before.status, columnId: before.columnId }, newEventId()),
        ),
        ...execution.neighbors.map(neighborUpdatedEvent),
      ];

      return {
        result: { tasks: [...execution.tasks] },
        effects: effects({
          events,
          searchUpserts: [...execution.tasks, ...execution.neighbors],
        }),
      };
    },
  );
};

const taskComplete: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskCompleteInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const current = await transaction.getTask(normalized.id);

      if (current === null) {
        throw new TasksNotFoundError("task", normalized.id);
      }

      const before = await snapshotProjectTasks(transaction, current.projectId);
      const task = await transaction.completeTask({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        updatedAt: now,
      });
      const after = await snapshotProjectTasks(transaction, current.projectId);
      const neighbors = shiftedNeighbors(before, after, task.id);
      const eventId = newEventId();

      return {
        result: { task, resource: formatTaskRef(task.id), eventId },
        effects: effects({
          events: [
            taskCompletedEvent(task, task.completedAt ?? now, eventId),
            ...neighbors.map(neighborUpdatedEvent),
          ],
          searchUpserts: [task, ...neighbors],
        }),
      };
    },
  );
};

const taskDelete: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskDeleteInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    confirm: true as const,
  };

  return executeMutation<DeleteOutput>(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction) => {
      const current = await transaction.getTask(normalized.id);
      const before =
        current === null ? null : await snapshotProjectTasks(transaction, current.projectId);
      const deletion = await transaction.deleteTask({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
      });

      if (!deletion.deleted) {
        return { result: { deleted: false as const }, effects: noEffects() };
      }

      const root = deletion.deletedTasks[0];

      if (root === undefined) {
        throw new TasksNotFoundError("task", normalized.id);
      }

      const after =
        current === null
          ? new Map<string, Task>()
          : await snapshotProjectTasks(transaction, current.projectId);
      const neighbors = before === null ? [] : shiftedNeighbors(before, after, null);
      const eventId = newEventId();
      const events = [
        taskDeletedEvent(root, deletion.deletedTasks),
        ...deletion.deletedTasks
          .slice(1)
          .map((descriptor) => taskDeletedEvent(descriptor, [descriptor])),
        ...neighbors.map(neighborUpdatedEvent),
      ];

      return {
        result: {
          deleted: true as const,
          resource: root.resourceRef,
          version: deletion.version,
          eventVersion: deletion.eventVersion,
          deletedResourceRefs: [...deletion.deletedResourceRefs],
          deletedTasks: [...deletion.deletedTasks],
          eventId,
        },
        effects: effects({
          events,
          searchDeleteRefs: deletion.deletedResourceRefs,
        }),
      };
    },
  );
};

const taskDeleteMany: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskDeleteManyInput;
  const normalized = {
    items: data.items.map((item) => ({
      id: item.id,
      expectedVersion: item.expectedVersion,
    })),
    confirm: true as const,
  };

  return executeMutation<TaskDeleteManyOutput>(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction) => {
      const execution = await deleteTasksInBulk(transaction, normalized.items);

      if (!execution.deleted) {
        return { result: { deleted: false as const }, effects: noEffects() };
      }

      const deletedTasks = execution.groups.flatMap((group) => group.descriptors);
      const deletedResourceRefs = [
        ...new Set(deletedTasks.map((descriptor) => descriptor.resourceRef)),
      ];
      let firstEventId: string | undefined;
      const events = [
        ...execution.groups.flatMap((group) => {
          const rootEventId = newEventId();

          if (firstEventId === undefined) {
            firstEventId = rootEventId;
          }

          return [
            taskDeletedEvent(group.root, group.descriptors, rootEventId),
            ...group.descriptors
              .slice(1)
              .map((descriptor) => taskDeletedEvent(descriptor, [descriptor])),
          ];
        }),
        ...execution.neighbors.map(neighborUpdatedEvent),
      ];

      if (firstEventId === undefined) {
        throw new TasksStoreValidationError("Массовое удаление не вернуло корневые дескрипторы");
      }

      return {
        result: {
          deleted: true as const,
          deletedResourceRefs,
          deletedTasks,
          eventId: firstEventId,
        },
        effects: effects({
          events,
          searchDeleteRefs: deletedResourceRefs,
        }),
      };
    },
  );
};

/* ------------------------------------------------------------------------- */
/* Запросы                                                                    */
/* ------------------------------------------------------------------------- */

const projectList: QueryFn = async (input, dependencies) => {
  const data = input as ProjectListInput;

  return dependencies.store.listProjects({
    limit: data.limit ?? DEFAULT_LIST_LIMIT,
    offset: data.offset ?? 0,
  });
};

const projectGet: QueryFn = async (input, dependencies) => {
  const data = input as { readonly id: string };
  const project = await dependencies.store.getProject(data.id);

  if (project === null) {
    throw new TasksNotFoundError("project", data.id);
  }

  return { project };
};

const projectSummary: QueryFn = async (input, dependencies) => {
  const data = input as ProjectSummaryInput;

  return dependencies.store.summarizeProjects({
    ...(data.projectId === undefined ? {} : { projectId: data.projectId }),
    limit: data.limit ?? DEFAULT_LIST_LIMIT,
    offset: data.offset ?? 0,
  });
};

const columnList: QueryFn = async (input, dependencies) => {
  const data = input as ColumnListInput;

  return dependencies.store.listColumns({
    projectId: data.projectId,
    limit: data.limit ?? DEFAULT_LIST_LIMIT,
    offset: data.offset ?? 0,
  });
};

const taskGet: QueryFn = async (input, dependencies) => {
  const data = input as { readonly id: string };
  const task = await dependencies.store.getTask(data.id);

  if (task === null) {
    throw new TasksNotFoundError("task", data.id);
  }

  return { task };
};

const taskList: QueryFn = async (input, dependencies) => {
  const data = input as TaskListInput;

  return dependencies.store.listTasks({
    ...(data.projectId === undefined ? {} : { projectId: data.projectId }),
    ...(data.columnId === undefined ? {} : { columnId: data.columnId }),
    ...(data.status === undefined ? {} : { status: data.status }),
    ...(data.priority === undefined ? {} : { priority: data.priority }),
    ...(data.tag === undefined ? {} : { tag: data.tag }),
    ...(data.parentTaskId === undefined ? {} : { parentTaskId: data.parentTaskId }),
    ...(data.text === undefined ? {} : { text: data.text }),
    ...(data.dueBefore === undefined ? {} : { dueBefore: data.dueBefore }),
    ...(data.dueAfter === undefined ? {} : { dueAfter: data.dueAfter }),
    ...(data.sort === undefined ? {} : { sort: data.sort }),
    limit: data.limit ?? DEFAULT_LIST_LIMIT,
    offset: data.offset ?? 0,
  });
};

/* ------------------------------------------------------------------------- */
/* Активация                                                                  */
/* ------------------------------------------------------------------------- */

function withTaskExposure<Metadata extends CommandMetadata | QueryMetadata>(
  metadata: Metadata,
): Metadata {
  return {
    ...metadata,
    exposure: { ui: true, http: true, mcp: false },
  };
}

function projectDescriptor(project: Project, ref: ResourceDescriptor["ref"]): ResourceDescriptor {
  return {
    ref,
    resourceType: PROJECT_RESOURCE_TYPE,
    title: project.title,
    state: "open",
    metadata: { version: project.version },
  };
}

function columnDescriptor(column: TaskColumn, ref: ResourceDescriptor["ref"]): ResourceDescriptor {
  return {
    ref,
    resourceType: COLUMN_RESOURCE_TYPE,
    title: column.title,
    state: column.status === "done" ? "closed" : "open",
    metadata: {
      version: column.version,
      projectId: column.projectId,
      status: column.status,
    },
  };
}

function taskDescriptor(task: Task, ref: ResourceDescriptor["ref"]): ResourceDescriptor {
  return {
    ref,
    resourceType: TASK_RESOURCE_TYPE,
    title: task.title,
    state: task.status === "done" ? "closed" : "open",
    metadata: {
      version: task.version,
      projectId: task.projectId,
      status: task.status,
    },
  };
}

const COMMAND_HANDLERS: Readonly<Record<string, CommandFn>> = Object.freeze({
  [TASKS_COMMAND_IDS.projectCreate]: projectCreate,
  [TASKS_COMMAND_IDS.projectUpdate]: projectUpdate,
  [TASKS_COMMAND_IDS.projectDelete]: projectDelete,
  [TASKS_COMMAND_IDS.columnCreate]: columnCreate,
  [TASKS_COMMAND_IDS.columnUpdate]: columnUpdate,
  [TASKS_COMMAND_IDS.columnMove]: columnMove,
  [TASKS_COMMAND_IDS.columnDelete]: columnDelete,
  [TASKS_COMMAND_IDS.taskCreate]: taskCreate,
  [TASKS_COMMAND_IDS.taskUpdate]: taskUpdate,
  [TASKS_COMMAND_IDS.taskMove]: taskMove,
  [TASKS_COMMAND_IDS.taskMoveMany]: taskMoveMany,
  [TASKS_COMMAND_IDS.taskComplete]: taskComplete,
  [TASKS_COMMAND_IDS.taskDelete]: taskDelete,
  [TASKS_COMMAND_IDS.taskDeleteMany]: taskDeleteMany,
});

const QUERY_HANDLERS: Readonly<Record<string, QueryFn>> = Object.freeze({
  [TASKS_QUERY_IDS.projectList]: projectList,
  [TASKS_QUERY_IDS.projectGet]: projectGet,
  [TASKS_QUERY_IDS.projectSummary]: projectSummary,
  [TASKS_QUERY_IDS.columnList]: columnList,
  [TASKS_QUERY_IDS.taskGet]: taskGet,
  [TASKS_QUERY_IDS.taskList]: taskList,
});

/**
 * Активирует headless-плагин задач.
 *
 * Использует только публичный контекст активации: bound registrars, storage,
 * search и events. Регистрирует все команды и запросы KAN-010, типы ресурсов
 * `project`/`task` и запускает best-effort переиндексацию задач. Мутации и
 * переиндексация сериализуются очередью этой активации.
 */
export async function activate(context: TasksActivationContext): Promise<void> {
  if (context.pluginId !== PLUGIN_ID) {
    throw new Error("Активация kanbaner.tasks получила другой Plugin ID");
  }

  const logger = normalizeLogger(context.logger);
  const now = (): UtcTimestamp => new Date().toISOString();
  const idFactory: TasksIdFactory = {
    nextProjectId: () => `project-${globalThis.crypto.randomUUID()}`,
    nextTaskId: () => `task-${globalThis.crypto.randomUUID()}`,
    nextColumnId: () => `column-${globalThis.crypto.randomUUID()}`,
  };
  const store = createTasksStore({ storage: context.storage, idFactory, now });
  const serialize = createSerialQueue();
  const dependencies: ActivationDependencies = {
    store,
    search: context.search,
    now,
    idFactory,
    logger,
  };

  for (const metadata of TASKS_COMMAND_LIST) {
    const handler = COMMAND_HANDLERS[metadata.id];

    if (handler === undefined) {
      throw new Error(`Нет обработчика команды ${metadata.id}`);
    }

    context.commands.register({
      metadata: withTaskExposure(metadata),
      handler: async (input, executionContext) => {
        // В очереди остаются только доменная транзакция и поисковые эффекты.
        // События публикуются после освобождения очереди, чтобы подписчик мог
        // вызвать следующую команду через общий OperationBus без deadlock.
        const execution = await serialize(() =>
          runMapped(() => handler(input, executionContext, metadata.id, dependencies)),
        );

        await publishDomainEvents(executionContext, execution.events, dependencies.logger);

        return execution.result;
      },
    });
  }

  for (const metadata of TASKS_QUERY_LIST) {
    const handler = QUERY_HANDLERS[metadata.id];

    if (handler === undefined) {
      throw new Error(`Нет обработчика запроса ${metadata.id}`);
    }

    context.queries.register({
      metadata: withTaskExposure(metadata),
      handler: (input) => runMapped(() => handler(input, dependencies)),
    });
  }

  context.resourceTypes.register({
    resourceTypes: [PROJECT_RESOURCE_TYPE, TASK_RESOURCE_TYPE, COLUMN_RESOURCE_TYPE],
    adapter: {
      async resolve(ref): Promise<ResourceDescriptor | null> {
        const parsed = tryParseTasksResourceRef(ref);

        if (parsed === null) {
          return null;
        }

        if (parsed.kind === PROJECT_RESOURCE_TYPE) {
          const project = await store.getProject(parsed.id);

          return project === null ? null : projectDescriptor(project, ref);
        }

        if (parsed.kind === COLUMN_RESOURCE_TYPE) {
          const column = await store.getColumn(parsed.id);

          return column === null ? null : columnDescriptor(column, ref);
        }

        const task = await store.getTask(parsed.id);

        return task === null ? null : taskDescriptor(task, ref);
      },
    },
  });

  // Материализация legacy-колонок awaited до завершения активации: query-пути
  // read-only и не делают read-repair. Каждый проект обрабатывается в
  // отдельной транзакции; сбой одного проекта логируется и не отменяет
  // остальные. Внутренний backfill не публикует доменные события: подписчики
  // восстанавливаются полной переиндексацией и чтением list после рестарта.
  await serialize(async () => {
    let offset = 0;

    for (;;) {
      const page = await store.listProjects({ limit: 200, offset });

      for (const project of page.items) {
        try {
          await store.backfillLegacyProject(project.id);
        } catch (error) {
          logger.warn("tasks.column_backfill_failed", {
            projectId: project.id,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }

      if (page.nextOffset === null) {
        return;
      }

      offset = page.nextOffset;
    }
  });

  // Переиндексация остаётся независимой best-effort: её ошибка не влияет ни
  // на активацию, ни на уже выполненный backfill.
  void serialize(() => reindexAllTasks(store, context.search, logger)).catch((error: unknown) => {
    logger.warn("tasks.search_reindex_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  });
}
