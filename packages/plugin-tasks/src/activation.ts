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
import { shiftedNeighbors, snapshotProjectTasks } from "./activation/snapshots.ts";
import type { DeletedTaskDescriptor, Project, Task } from "./model.ts";
import { TASKS_COMMAND_LIST, TASKS_QUERY_LIST } from "./operations.ts";
import type {
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectUpdateInput,
} from "./schemas/project.ts";
import type { DeleteOutput } from "./schemas/common.ts";
import type { ProjectListInput, ProjectSummaryInput, TaskListInput } from "./schemas/queries.ts";
import type {
  TaskCompleteInput,
  TaskCreateInput,
  TaskDeleteInput,
  TaskMoveInput,
  TaskUpdateInput,
} from "./schemas/task.ts";
import { formatProjectRef, formatTaskRef, tryParseTasksResourceRef } from "./resources.ts";
import { TasksNotFoundError, createTasksStore } from "./store/index.ts";
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

function changedProjectFields(before: Project, after: Project): readonly string[] {
  const changed: string[] = [];

  if (before.title !== after.title) {
    changed.push("title");
  }

  if (before.descriptionMarkdown !== after.descriptionMarkdown) {
    changed.push("descriptionMarkdown");
  }

  return changed;
}

function taskDeletedEvent(
  descriptor: DeletedTaskDescriptor,
  deletedTasks: readonly DeletedTaskDescriptor[],
) {
  return domainEvent({
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
      position: task.position,
      changed: ["position"],
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
      status: task.status,
      position: task.position,
    }),
  });
}

function taskMovedEvent(task: Task, fromStatus: Task["status"], eventId: string) {
  return domainEvent({
    eventId,
    type: TASK_EVENT_TYPES.moved,
    resource: formatTaskRef(task.id),
    resourceVersion: task.version,
    payload: eventPayload({
      taskId: task.id,
      projectId: task.projectId,
      version: task.version,
      fromStatus,
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

      const project = await transaction.updateProject({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.descriptionMarkdown === undefined
          ? {}
          : { descriptionMarkdown: data.descriptionMarkdown }),
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
          }),
        }),
        ...deletion.deletedTasks.map((descriptor) => taskDeletedEvent(descriptor, [descriptor])),
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

const taskCreate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as TaskCreateInput;
  const normalized = {
    projectId: data.projectId,
    parentTaskId: data.parentTaskId ?? null,
    title: data.title,
    descriptionMarkdown: data.descriptionMarkdown ?? "",
    status: data.status ?? "todo",
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
      const task = await transaction.createTask({
        id: dependencies.idFactory.nextTaskId(),
        projectId: normalized.projectId,
        parentTaskId: normalized.parentTaskId,
        title: normalized.title,
        descriptionMarkdown: normalized.descriptionMarkdown,
        status: normalized.status,
        priority: normalized.priority,
        dueAt: normalized.dueAt,
        tags: normalized.tags,
        createdAt: now,
        expectedVersion: normalized.expectedVersion,
        ...(normalized.position === undefined ? {} : { position: normalized.position }),
      });
      const after = await snapshotProjectTasks(transaction, normalized.projectId);
      const neighbors = shiftedNeighbors(before, after, task.id);
      const eventId = newEventId();

      return {
        result: { task, resource: formatTaskRef(task.id), eventId },
        effects: effects({
          events: [taskCreatedEvent(task, eventId), ...neighbors.map(neighborUpdatedEvent)],
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
    status: data.status,
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
      const task = await transaction.moveTask({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        status: normalized.status,
        position: normalized.position,
        updatedAt: now,
      });
      const after = await snapshotProjectTasks(transaction, current.projectId);
      const neighbors = shiftedNeighbors(before, after, task.id);
      const eventId = newEventId();

      return {
        result: { task, resource: formatTaskRef(task.id), eventId },
        effects: effects({
          events: [
            taskMovedEvent(task, current.status, eventId),
            ...neighbors.map(neighborUpdatedEvent),
          ],
          searchUpserts: [task, ...neighbors],
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

function withUiExposure<Metadata extends CommandMetadata | QueryMetadata>(
  metadata: Metadata,
): Metadata {
  return {
    ...metadata,
    exposure: { ui: true, http: false, mcp: false },
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
  [TASKS_COMMAND_IDS.taskCreate]: taskCreate,
  [TASKS_COMMAND_IDS.taskUpdate]: taskUpdate,
  [TASKS_COMMAND_IDS.taskMove]: taskMove,
  [TASKS_COMMAND_IDS.taskComplete]: taskComplete,
  [TASKS_COMMAND_IDS.taskDelete]: taskDelete,
});

const QUERY_HANDLERS: Readonly<Record<string, QueryFn>> = Object.freeze({
  [TASKS_QUERY_IDS.projectList]: projectList,
  [TASKS_QUERY_IDS.projectGet]: projectGet,
  [TASKS_QUERY_IDS.projectSummary]: projectSummary,
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
      metadata: withUiExposure(metadata),
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
      metadata: withUiExposure(metadata),
      handler: (input) => runMapped(() => handler(input, dependencies)),
    });
  }

  context.resourceTypes.register({
    resourceTypes: [PROJECT_RESOURCE_TYPE, TASK_RESOURCE_TYPE],
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

        const task = await store.getTask(parsed.id);

        return task === null ? null : taskDescriptor(task, ref);
      },
    },
  });

  // Полная переиндексация best-effort: не блокирует активацию, идемпотентна и
  // сериализуется с мутациями через очередь этой активации. Ошибка чтения не
  // влияет на регистрацию операций.
  void serialize(() => reindexAllTasks(store, context.search, logger)).catch((error: unknown) => {
    logger.warn("tasks.search_reindex_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  });
}
