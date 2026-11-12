// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  EventEnvelope,
  ExecutionContext,
  PluginSearchService,
  SearchDocumentInput,
  SearchHit,
  SearchIndexDocument,
  PluginStorage,
  StorageProvider,
} from "@kanbaner/plugin-sdk";
import {
  InMemoryStorageProvider,
  StorageMigrationRunner,
  bindPluginStorage,
} from "@kanbaner/kernel";
import {
  createSqliteStorageProvider,
  createCoreInfrastructureMigrations,
} from "@kanbaner/storage-sqlite";

import { activate, type TasksActivationContext } from "../activation.ts";
import { PLUGIN_ID, TASKS_COMMAND_IDS } from "../constants.ts";
import type { ProjectMutationOutput } from "../schemas/project.ts";
import type {
  TaskDeleteManyOutput,
  TaskMutationOutput,
  TaskMoveManyOutput,
} from "../schemas/task.ts";
import { createTasksStore } from "../store/index.ts";
import type { TasksIdFactory, TasksStore } from "../store.ts";
import type { Task } from "../model.ts";

const NOOP_LOGGER = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

interface Harness {
  readonly store: TasksStore;
  readonly events: EventEnvelope[];
  readonly searchUpserts: string[];
  readonly searchDeletes: string[];
  command<T = unknown>(
    operationId: string,
    input: unknown,
    options?: { readonly idempotencyKey?: string },
  ): Promise<T>;
  close(): Promise<void>;
}

interface Variant {
  readonly name: string;
  create(): Promise<{ readonly storage: PluginStorage; readonly close: () => Promise<void> }>;
}

function fixedNow(): string {
  return "2026-01-01T00:00:00.000Z";
}

function createIdFactory(): TasksIdFactory {
  let sequence = 0;
  const next = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${String(sequence)}`;
  };

  return {
    nextProjectId: () => next("project"),
    nextTaskId: () => next("task"),
    nextColumnId: () => next("column"),
  };
}

function memoryVariant(): Variant {
  return {
    name: "in-memory",
    async create() {
      const provider = new InMemoryStorageProvider({ backendId: "bulk-memory" });
      await provider.open();

      return {
        storage: bindPluginStorage(provider, PLUGIN_ID),
        close: () => provider.close(),
      };
    },
  };
}

function sqliteVariant(): Variant {
  return {
    name: "sqlite",
    async create() {
      const directory = mkdtempSync(join(tmpdir(), "kanbaner-bulk-"));
      directories.push(directory);
      let provider: StorageProvider | null = null;

      try {
        provider = createSqliteStorageProvider({
          backendId: "bulk-sqlite",
          dataDirectory: directory,
        });
        await provider.open();
        await new StorageMigrationRunner(provider).run(createCoreInfrastructureMigrations());
      } catch (error) {
        await provider?.close();
        throw error;
      }

      const opened = provider;

      return {
        storage: bindPluginStorage(opened, PLUGIN_ID),
        close: () => opened.close(),
      };
    },
  };
}

async function startHarness(variant: Variant): Promise<Harness> {
  const resources = await variant.create();
  const store = createTasksStore({
    storage: resources.storage,
    idFactory: createIdFactory(),
    now: fixedNow,
  });
  const events: EventEnvelope[] = [];
  const searchUpserts: string[] = [];
  const searchDeletes: string[] = [];
  const handlers = new Map<
    string,
    (input: unknown, executionContext: ExecutionContext) => Promise<unknown>
  >();

  const search: PluginSearchService = {
    async upsert(documents: readonly SearchDocumentInput[]): Promise<number> {
      searchUpserts.push(...documents.map((document) => document.ref));
      return documents.length;
    },
    async delete(ref): Promise<boolean> {
      searchDeletes.push(ref);
      return true;
    },
    async list(): Promise<readonly SearchIndexDocument[]> {
      return [];
    },
    async search(): Promise<readonly SearchHit[]> {
      return [];
    },
    async reindex(): Promise<number> {
      return 0;
    },
  };

  const commands = {
    register(registration: {
      readonly metadata: { readonly id: string };
      readonly handler: (input: unknown, executionContext: ExecutionContext) => Promise<unknown>;
    }): void {
      handlers.set(registration.metadata.id, registration.handler);
    },
    unregister(): boolean {
      return true;
    },
  };

  const queries = {
    register(): void {},
    unregister(): boolean {
      return true;
    },
  };

  const resourceTypes = {
    register(): void {},
    unregister(): void {},
  };

  const context = {
    pluginId: PLUGIN_ID,
    storage: resources.storage,
    search,
    commands,
    queries,
    resourceTypes,
    logger: NOOP_LOGGER,
  } as unknown as TasksActivationContext;

  await activate(context);

  const harness: Harness = {
    store,
    events,
    searchUpserts,
    searchDeletes,
    async command<T = unknown>(
      operationId: string,
      input: unknown,
      options: { readonly idempotencyKey?: string } = {},
    ): Promise<T> {
      const handler = handlers.get(operationId);

      if (handler === undefined) {
        throw new Error(`Нет обработчика ${operationId}`);
      }

      const executionContext = {
        requestId: "request-1",
        traceId: "trace-1",
        source: { type: "system", id: "bulk-test" },
        signal: new AbortController().signal,
        logger: NOOP_LOGGER,
        search,
        storage: resources.storage,
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        events: {
          async publishAfterCommit(envelope: EventEnvelope) {
            events.push(envelope);
            return { status: "published" as const };
          },
        },
      } as unknown as ExecutionContext;

      return handler(input, executionContext) as Promise<T>;
    },
    close: resources.close,
  };

  closers.push(harness.close);

  return harness;
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function createProject(harness: Harness, title = "Проект"): Promise<string> {
  const result = await harness.command<ProjectMutationOutput>(TASKS_COMMAND_IDS.projectCreate, {
    title,
    descriptionMarkdown: "",
  });

  return result.project.id;
}

async function createTask(
  harness: Harness,
  projectId: string,
  columnId: string,
  title: string,
  parentTaskId: string | null = null,
): Promise<Task> {
  const result = await harness.command<TaskMutationOutput>(TASKS_COMMAND_IDS.taskCreate, {
    projectId,
    parentTaskId,
    columnId,
    title,
    descriptionMarkdown: "",
  });

  return result.task;
}

async function columns(harness: Harness, projectId: string) {
  return harness.store.listColumns({ projectId, limit: 200, offset: 0 });
}

async function columnId(harness: Harness, projectId: string, status: string): Promise<string> {
  const page = await columns(harness, projectId);
  const column = page.items.find((candidate) => candidate.status === status);

  if (column === undefined) {
    throw new Error(`Нет колонки ${status}`);
  }

  return column.id;
}

async function projectTasks(harness: Harness, projectId: string): Promise<readonly Task[]> {
  return (
    await harness.store.listTasks({
      projectId,
      sort: { field: "position", direction: "asc" },
      limit: 200,
      offset: 0,
    })
  ).items;
}

async function columnTasks(
  harness: Harness,
  projectId: string,
  targetColumnId: string,
): Promise<readonly Task[]> {
  return (
    await harness.store.listTasks({
      projectId,
      columnId: targetColumnId,
      sort: { field: "position", direction: "asc" },
      limit: 200,
      offset: 0,
    })
  ).items;
}

function item(task: Task) {
  return { id: task.id, expectedVersion: task.version };
}

function clearEffects(harness: Harness): void {
  harness.events.length = 0;
  harness.searchUpserts.length = 0;
  harness.searchDeletes.length = 0;
}

function operationError(
  error: unknown,
): { code?: string; details?: Record<string, unknown> } | null {
  if (typeof error !== "object" || error === null || !("error" in error)) {
    return null;
  }

  const envelope = (error as { readonly error?: unknown }).error;

  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }

  return envelope as { code?: string; details?: Record<string, unknown> };
}

function errorCode(error: unknown): string | undefined {
  return operationError(error)?.code;
}

function errorReason(error: unknown): string | undefined {
  const details = operationError(error)?.details;

  return typeof details?.reason === "string" ? details.reason : undefined;
}

const variants: readonly Variant[] = [memoryVariant(), sqliteVariant()];

for (const variant of variants) {
  describe(`массовые операции задач (${variant.name})`, () => {
    it("moveMany дописывает задачи в порядке входа и корректно обрабатывает source=target", async () => {
      const harness = await startHarness(variant);
      const projectId = await createProject(harness);
      const todo = await columnId(harness, projectId, "todo");
      const progress = await columnId(harness, projectId, "in_progress");

      const todoFirst = await createTask(harness, projectId, todo, "todo-1");
      const todoSecond = await createTask(harness, projectId, todo, "todo-2");
      const todoThird = await createTask(harness, projectId, todo, "todo-3");
      const progressFirst = await createTask(harness, projectId, progress, "progress-1");
      const progressSecond = await createTask(harness, projectId, progress, "progress-2");

      const result = await harness.command<TaskMoveManyOutput>(TASKS_COMMAND_IDS.taskMoveMany, {
        items: [item(progressSecond), item(todoSecond), item(todoFirst), item(progressFirst)],
        columnId: progress,
      });

      expect(result.tasks.map((task) => task.id)).toEqual([
        progressSecond.id,
        todoSecond.id,
        todoFirst.id,
        progressFirst.id,
      ]);

      const target = await columnTasks(harness, projectId, progress);
      expect(target.map((task) => task.id)).toEqual([
        progressSecond.id,
        todoSecond.id,
        todoFirst.id,
        progressFirst.id,
      ]);
      expect(new Set(target.map((task) => task.position)).size).toBe(target.length);
      expect(target.map((task) => task.position)).toEqual([0, 1, 2, 3]);

      const source = await columnTasks(harness, projectId, todo);
      expect(source.map((task) => task.id)).toEqual([todoThird.id]);

      expect(
        harness.events.filter((event) => event.type === "kanbaner.tasks.task.moved"),
      ).toHaveLength(4);
      expect(
        harness.events
          .filter((event) => event.type === "kanbaner.tasks.task.updated")
          .map((event) => event.payload["taskId"]),
      ).toContain(todoThird.id);
      expect(harness.searchUpserts).toEqual(
        expect.arrayContaining([
          `kanbaner.tasks:task:${progressSecond.id}`,
          `kanbaner.tasks:task:${todoSecond.id}`,
          `kanbaner.tasks:task:${todoFirst.id}`,
          `kanbaner.tasks:task:${progressFirst.id}`,
          `kanbaner.tasks:task:${todoThird.id}`,
        ]),
      );
    });

    it("moveMany с одной устаревшей версией откатывает весь набор", async () => {
      const harness = await startHarness(variant);
      const projectId = await createProject(harness);
      const todo = await columnId(harness, projectId, "todo");
      const progress = await columnId(harness, projectId, "in_progress");
      const first = await createTask(harness, projectId, todo, "first");
      const second = await createTask(harness, projectId, todo, "second");
      const before = await projectTasks(harness, projectId);
      clearEffects(harness);

      const error = await harness
        .command(TASKS_COMMAND_IDS.taskMoveMany, {
          items: [item(first), { id: second.id, expectedVersion: second.version + 1 }],
          columnId: progress,
        })
        .catch((caught: unknown) => caught);

      expect(errorCode(error)).toBe("VERSION_CONFLICT");
      const after = await projectTasks(harness, projectId);
      expect(after.map(({ id, position, version }) => ({ id, position, version }))).toEqual(
        before.map(({ id, position, version }) => ({ id, position, version })),
      );
      expect(harness.events).toEqual([]);
      expect(harness.searchUpserts).toEqual([]);
    });

    it("moveMany отклоняет дубликаты, отсутствующую задачу, чужой проект и чужой target", async () => {
      const harness = await startHarness(variant);
      const projectId = await createProject(harness, "A");
      const otherProjectId = await createProject(harness, "B");
      const todo = await columnId(harness, projectId, "todo");
      const progress = await columnId(harness, projectId, "in_progress");
      const foreignColumn = await columnId(harness, otherProjectId, "todo");
      const first = await createTask(harness, projectId, todo, "first");
      const second = await createTask(harness, projectId, todo, "second");
      const foreign = await createTask(harness, otherProjectId, foreignColumn, "foreign");
      const before = await projectTasks(harness, projectId);
      clearEffects(harness);

      const duplicate = await harness
        .command(TASKS_COMMAND_IDS.taskMoveMany, {
          items: [item(first), item(first)],
          columnId: progress,
        })
        .catch((caught: unknown) => caught);
      expect(errorReason(duplicate)).toBe("DUPLICATE_TASK_ID");

      const missing = await harness
        .command(TASKS_COMMAND_IDS.taskMoveMany, {
          items: [item(first), { id: "missing-task", expectedVersion: 1 }],
          columnId: progress,
        })
        .catch((caught: unknown) => caught);
      expect(errorCode(missing)).toBe("NOT_FOUND");

      const foreignTask = await harness
        .command(TASKS_COMMAND_IDS.taskMoveMany, {
          items: [item(first), item(foreign)],
          columnId: progress,
        })
        .catch((caught: unknown) => caught);
      expect(errorReason(foreignTask)).toBe("TASKS_OTHER_PROJECT");

      const foreignTarget = await harness
        .command(TASKS_COMMAND_IDS.taskMoveMany, {
          items: [item(second)],
          columnId: foreignColumn,
        })
        .catch((caught: unknown) => caught);
      expect(errorReason(foreignTarget)).toBe("COLUMN_TARGET_OTHER_PROJECT");

      const after = await projectTasks(harness, projectId);
      expect(after.map(({ id, position, version }) => ({ id, position, version }))).toEqual(
        before.map(({ id, position, version }) => ({ id, position, version })),
      );
      expect(harness.events).toEqual([]);
    });

    it("deleteMany удаляет parent+child без дублей дескрипторов, событий и поисковых ссылок", async () => {
      const harness = await startHarness(variant);
      const projectId = await createProject(harness);
      const todo = await columnId(harness, projectId, "todo");
      const parent = await createTask(harness, projectId, todo, "parent");
      const child = await createTask(harness, projectId, todo, "child", parent.id);
      const sibling = await createTask(harness, projectId, todo, "sibling");
      const survivor = await createTask(harness, projectId, todo, "survivor");
      clearEffects(harness);

      const result = await harness.command<TaskDeleteManyOutput>(TASKS_COMMAND_IDS.taskDeleteMany, {
        items: [item(parent), item(child), item(sibling)],
        confirm: true,
      });

      expect(result.deleted).toBe(true);

      if (!result.deleted) {
        throw new Error("Ожидалось успешное удаление");
      }

      const deletedIds = result.deletedTasks.map((descriptor) => descriptor.id);

      expect(deletedIds).toEqual([parent.id, child.id, sibling.id]);
      expect(new Set(deletedIds).size).toBe(deletedIds.length);
      expect(new Set(result.deletedResourceRefs).size).toBe(result.deletedResourceRefs.length);
      expect(
        harness.events.filter((event) => event.type === "kanbaner.tasks.task.deleted"),
      ).toHaveLength(3);
      expect(harness.searchDeletes).toHaveLength(3);
      expect(new Set(harness.searchDeletes).size).toBe(3);
      expect(
        harness.events
          .filter((event) => event.type === "kanbaner.tasks.task.updated")
          .map((event) => event.payload["taskId"]),
      ).toEqual([survivor.id]);
      expect((await projectTasks(harness, projectId)).map((task) => task.id)).toEqual([
        survivor.id,
      ]);
    });

    it("deleteMany откатывает набор при устаревшей версии, отсутствии и чужом проекте", async () => {
      const harness = await startHarness(variant);
      const projectId = await createProject(harness, "A");
      const otherProjectId = await createProject(harness, "B");
      const todo = await columnId(harness, projectId, "todo");
      const foreignColumn = await columnId(harness, otherProjectId, "todo");
      const first = await createTask(harness, projectId, todo, "first");
      const second = await createTask(harness, projectId, todo, "second");
      const foreign = await createTask(harness, otherProjectId, foreignColumn, "foreign");
      const before = await projectTasks(harness, projectId);
      clearEffects(harness);

      const stale = await harness
        .command(TASKS_COMMAND_IDS.taskDeleteMany, {
          items: [item(first), { id: second.id, expectedVersion: second.version + 1 }],
          confirm: true,
        })
        .catch((caught: unknown) => caught);
      expect(errorCode(stale)).toBe("VERSION_CONFLICT");

      const missing = await harness
        .command(TASKS_COMMAND_IDS.taskDeleteMany, {
          items: [item(first), { id: "missing-task", expectedVersion: 1 }],
          confirm: true,
        })
        .catch((caught: unknown) => caught);
      expect(errorCode(missing)).toBe("NOT_FOUND");

      const foreignTask = await harness
        .command(TASKS_COMMAND_IDS.taskDeleteMany, {
          items: [item(first), item(foreign)],
          confirm: true,
        })
        .catch((caught: unknown) => caught);
      expect(errorReason(foreignTask)).toBe("TASKS_OTHER_PROJECT");

      const after = await projectTasks(harness, projectId);
      expect(after.map(({ id, position, version }) => ({ id, position, version }))).toEqual(
        before.map(({ id, position, version }) => ({ id, position, version })),
      );
      expect(harness.events).toEqual([]);
      expect(harness.searchDeletes).toEqual([]);
    });

    it("deleteMany полностью отсутствующего набора — no-op без событий", async () => {
      const harness = await startHarness(variant);
      await createProject(harness);
      clearEffects(harness);

      const result = await harness.command<TaskDeleteManyOutput>(TASKS_COMMAND_IDS.taskDeleteMany, {
        items: [
          { id: "missing-1", expectedVersion: 1 },
          { id: "missing-2", expectedVersion: 3 },
        ],
        confirm: true,
      });

      expect(result).toEqual({ deleted: false });
      expect(harness.events).toEqual([]);
      expect(harness.searchDeletes).toEqual([]);
    });

    it("moveMany и deleteMany повторяются по Idempotency-Key без событий и индексации", async () => {
      const harness = await startHarness(variant);
      const projectId = await createProject(harness);
      const todo = await columnId(harness, projectId, "todo");
      const progress = await columnId(harness, projectId, "in_progress");
      const first = await createTask(harness, projectId, todo, "first");
      const second = await createTask(harness, projectId, todo, "second");
      const input = {
        items: [item(first), item(second)],
        columnId: progress,
      };

      const moved = await harness.command<TaskMoveManyOutput>(
        TASKS_COMMAND_IDS.taskMoveMany,
        input,
        { idempotencyKey: "move-key" },
      );
      const eventsAfterMove = harness.events.length;
      const upsertsAfterMove = harness.searchUpserts.length;

      const movedAgain = await harness.command<TaskMoveManyOutput>(
        TASKS_COMMAND_IDS.taskMoveMany,
        input,
        { idempotencyKey: "move-key" },
      );

      expect(movedAgain).toEqual(moved);
      expect(harness.events).toHaveLength(eventsAfterMove);
      expect(harness.searchUpserts).toHaveLength(upsertsAfterMove);

      const current = await columnTasks(harness, projectId, progress);
      const deleteInput = {
        items: current.map(item),
        confirm: true,
      };
      const deleted = await harness.command<TaskDeleteManyOutput>(
        TASKS_COMMAND_IDS.taskDeleteMany,
        deleteInput,
        { idempotencyKey: "delete-key" },
      );
      const eventsAfterDelete = harness.events.length;
      const deletesAfterDelete = harness.searchDeletes.length;

      const deletedAgain = await harness.command<TaskDeleteManyOutput>(
        TASKS_COMMAND_IDS.taskDeleteMany,
        deleteInput,
        { idempotencyKey: "delete-key" },
      );

      expect(deletedAgain).toEqual(deleted);
      expect(harness.events).toHaveLength(eventsAfterDelete);
      expect(harness.searchDeletes).toHaveLength(deletesAfterDelete);
    });
  });
}
