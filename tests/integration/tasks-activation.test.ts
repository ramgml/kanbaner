// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntime, type PluginRuntime } from "@kanbaner/kernel";
import type {
  EventEnvelope,
  JsonValue,
  OperationResult,
  PluginLogger,
  StorageProvider,
} from "@kanbaner/plugin-sdk";
import {
  PLUGIN_ID,
  PROJECT_EVENT_TYPES,
  TASK_EVENT_TYPES,
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  formatProjectRef,
  formatTaskRef,
  type DeleteOutput,
  type ProjectMutationOutput,
  type TaskMutationOutput,
} from "../../packages/plugin-tasks/src/contract.ts";
import { createSqliteStorageProvider } from "@kanbaner/storage-sqlite";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "../../apps/web/src/server/application-composition.ts";
import {
  createApplicationStorage,
  type ApplicationStorageRuntime,
} from "../../apps/web/src/server/application-storage.ts";
import { migratePluginWithSqlite } from "../../apps/web/src/server/sqlite-plugin-migrations.ts";

const PLUGIN_DIRECTORIES = [path.resolve(import.meta.dirname, "../../packages")];

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

const directories: string[] = [];
const harnesses: TasksHarness[] = [];

interface ProviderDelays {
  readonly openMs: number;
  readonly healthCheckMs: number;
  readonly operationMs: number;
  readonly transactionMs: number;
}

interface HarnessOptions {
  readonly dataDirectory?: string;
  readonly delays?: ProviderDelays;
  readonly decorateProvider?: (provider: StorageProvider) => StorageProvider;
  readonly removeOnClose?: boolean;
}

interface CapturedLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

interface TasksHarness {
  readonly dataDirectory: string;
  readonly provider: StorageProvider;
  readonly storage: ApplicationStorageRuntime;
  readonly composition: ApplicationPluginComposition;
  readonly runtime: PluginRuntime;
  readonly events: EventEnvelope[];
  readonly logs: CapturedLog[];
  command<T = unknown>(
    operationId: string,
    input: unknown,
    options?: { readonly idempotencyKey?: string },
  ): Promise<OperationResult<T>>;
  query<T = unknown>(operationId: string, input: unknown): Promise<OperationResult<T>>;
  close(remove?: boolean): Promise<void>;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "kanbaner-tasks-activation-"));
  directories.push(directory);

  return directory;
}

async function startHarness(options: HarnessOptions = {}): Promise<TasksHarness> {
  const dataDirectory = options.dataDirectory ?? temporaryDirectory();
  const removeOnClose = options.removeOnClose ?? options.dataDirectory === undefined;
  const provider = createSqliteStorageProvider({
    backendId: `sqlite-tasks-activation-${globalThis.crypto.randomUUID()}`,
    dataDirectory,
    ...(options.delays === undefined ? {} : { delays: options.delays }),
  });
  const storage = await createApplicationStorage({ dataDirectory, provider });
  const busProvider =
    options.decorateProvider === undefined ? provider : options.decorateProvider(provider);
  const composition = createApplicationPluginComposition({
    storage: busProvider,
    logger: NOOP_LOGGER,
  });
  const events: EventEnvelope[] = [];
  const logs: CapturedLog[] = [];
  const runtime = createPluginRuntime({
    pluginDirectories: PLUGIN_DIRECTORIES,
    hooks: {
      migrate: async (context) => {
        await migratePluginWithSqlite(context, { provider, health: storage.health });
      },
    },
    services: composition.services,
    logger: {
      log(level, message, details) {
        logs.push(details === undefined ? { level, message } : { level, message, details });
      },
    },
  });

  const snapshot = await runtime.start();

  if (!snapshot.plugins.some((plugin) => plugin.pluginId === PLUGIN_ID && plugin.activated)) {
    throw new Error(`Плагин ${PLUGIN_ID} не активировался`);
  }

  composition.bindPlugins(
    snapshot.plugins
      .filter((plugin) => plugin.activated && plugin.pluginId !== null)
      .map((plugin) => plugin.pluginId as string),
  );

  const unsubscribe = composition.events.subscribe(
    "kanbaner.tasks.*",
    (envelope) => {
      events.push(envelope);
    },
    { pluginId: "kanbaner.test" },
  );

  let closed = false;

  const harness: TasksHarness = {
    dataDirectory,
    provider,
    storage,
    composition,
    runtime,
    events,
    logs,
    command<T = unknown>(
      operationId: string,
      input: unknown,
      invocationOptions: { readonly idempotencyKey?: string } = {},
    ) {
      return composition.operations.executeCommand<unknown, T>(
        operationId,
        input,
        invocationOptions.idempotencyKey === undefined
          ? { source: { type: "system", id: "tasks-activation-test" } }
          : {
              source: { type: "system", id: "tasks-activation-test" },
              idempotencyKey: invocationOptions.idempotencyKey,
            },
      );
    },
    query<T = unknown>(operationId: string, input: unknown) {
      return composition.operations.executeQuery<unknown, T>(operationId, input, {
        source: { type: "system", id: "tasks-activation-test" },
      });
    },
    async close(remove = removeOnClose) {
      if (closed) {
        return;
      }

      closed = true;
      unsubscribe();
      await runtime.stop();
      composition.dispose();
      await storage.registry.closeAll();

      if (remove) {
        rmSync(dataDirectory, { recursive: true, force: true });
      }
    },
  };

  harnesses.push(harness);

  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function expectOk<Data>(result: OperationResult<Data>): Data {
  if (!result.ok) {
    throw new Error(`Операция упала: ${result.error.code} (${result.error.message})`);
  }

  return result.data;
}

async function createProject(
  harness: TasksHarness,
  title = "Проект",
  options: { readonly idempotencyKey?: string } = {},
): Promise<ProjectMutationOutput> {
  return expectOk<ProjectMutationOutput>(
    await harness.command(
      TASKS_COMMAND_IDS.projectCreate,
      { title, descriptionMarkdown: "" },
      options,
    ),
  );
}

async function createTask(
  harness: TasksHarness,
  projectId: string,
  input: Record<string, unknown> = {},
  options: { readonly idempotencyKey?: string } = {},
): Promise<TaskMutationOutput> {
  return expectOk<TaskMutationOutput>(
    await harness.command(
      TASKS_COMMAND_IDS.taskCreate,
      { projectId, title: "Задача", descriptionMarkdown: "", ...input },
      options,
    ),
  );
}

async function listTasks(harness: TasksHarness, projectId?: string) {
  return expectOk<{
    items: readonly {
      id: string;
      position: number;
      version: number;
      status: string;
      title: string;
      completedAt: string | null;
      parentTaskId: string | null;
    }[];
    total: number;
    nextOffset: number | null;
  }>(await harness.query(TASKS_QUERY_IDS.taskList, projectId === undefined ? {} : { projectId }));
}

async function searchText(harness: TasksHarness, text: string) {
  return harness.composition.search.search(PLUGIN_ID, { text, limit: 20, offset: 0 });
}

async function waitFor<Value>(
  check: () => Promise<Value | null>,
  timeoutMs = 5_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await check();

    if (value !== null) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error("Не дождались ожидаемого состояния поиска");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("активация kanbaner.tasks", () => {
  it("регистрирует все команды и запросы с UI exposure и выключенными HTTP/MCP", async () => {
    const harness = await startHarness();

    const commands = harness.composition.operations.registry.commands
      .list()
      .filter((descriptor) => descriptor.pluginId === PLUGIN_ID);
    const queries = harness.composition.operations.registry.queries
      .list()
      .filter((descriptor) => descriptor.pluginId === PLUGIN_ID);
    const commandIds = commands.map((descriptor) => descriptor.id).sort();
    const queryIds = queries.map((descriptor) => descriptor.id).sort();

    expect(commandIds).toEqual(Object.values(TASKS_COMMAND_IDS).sort());
    expect(queryIds).toEqual(Object.values(TASKS_QUERY_IDS).sort());

    for (const descriptor of [...commands, ...queries]) {
      expect(descriptor.exposure).toEqual({ ui: true, http: false, mcp: false });
    }

    expect(
      harness.composition.operations.registry.get(TASKS_COMMAND_IDS.projectDelete)?.metadata.risk,
    ).toBe("destructive");
    expect(
      harness.composition.operations.registry.get(TASKS_COMMAND_IDS.taskDelete)?.metadata.risk,
    ).toBe("destructive");
    expect(
      harness.composition.operations.registry.get(TASKS_COMMAND_IDS.taskComplete)?.metadata.risk,
    ).toBe("write");
    expect(
      harness.composition.operations.registry.get(TASKS_QUERY_IDS.taskGet)?.metadata.risk,
    ).toBe("read");
  });

  it("проходит полный жизненный цикл проекта и задачи", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Релиз");
    const created = await createTask(harness, project.project.id, {
      title: "Подготовить релиз",
      priority: "high",
      tags: [" Релиз ", "release", "release"],
    });

    expect(project.project.version).toBe(1);
    expect(created.task.status).toBe("todo");
    expect(created.task.version).toBe(1);
    expect(created.task.tags).toEqual(["релиз", "release"]);

    const updated = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskUpdate, {
        id: created.task.id,
        expectedVersion: 1,
        title: "Подготовить релиз 2",
        descriptionMarkdown: "Кириллическое описание",
      }),
    );

    expect(updated.task.version).toBe(2);
    expect((await listTasks(harness, project.project.id)).total).toBe(1);
    expect(
      expectOk(await harness.query(TASKS_QUERY_IDS.taskGet, { id: created.task.id })),
    ).toMatchObject({ task: { id: created.task.id, version: 2 } });
    expect(
      expectOk(await harness.query(TASKS_QUERY_IDS.projectGet, { id: project.project.id })),
    ).toMatchObject({ project: { id: project.project.id } });
    expect((await listTasks(harness)).total).toBe(1);

    const deletion = expectOk<DeleteOutput>(
      await harness.command(TASKS_COMMAND_IDS.projectDelete, {
        id: project.project.id,
        expectedVersion: 1,
        confirm: true,
      }),
    );

    expect(deletion.deleted).toBe(true);
    expect((await listTasks(harness)).total).toBe(0);
    expect((await harness.query(TASKS_QUERY_IDS.projectList, {})).ok).toBe(true);
  });

  it("разрешает подзадачу первого уровня и запрещает второй уровень и чужой проект", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Проект A");
    const other = await createProject(harness, "Проект B");
    const parent = await createTask(harness, project.project.id, { title: "Родитель" });
    const child = await createTask(harness, project.project.id, {
      title: "Подзадача",
      parentTaskId: parent.task.id,
    });

    expect(child.task.parentTaskId).toBe(parent.task.id);

    const secondLevel = await harness.command(TASKS_COMMAND_IDS.taskCreate, {
      projectId: project.project.id,
      parentTaskId: child.task.id,
      title: "Второй уровень",
    });
    expect(secondLevel.ok).toBe(false);
    if (!secondLevel.ok) {
      expect(secondLevel.error.code).toBe("VALIDATION_ERROR");
    }

    const foreignParent = await harness.command(TASKS_COMMAND_IDS.taskCreate, {
      projectId: other.project.id,
      parentTaskId: parent.task.id,
      title: "Чужой родитель",
    });
    expect(foreignParent.ok).toBe(false);
    if (!foreignParent.ok) {
      expect(foreignParent.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("поддерживает четыре статуса и инвариант completedAt", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);

    const backlog = await createTask(harness, project.project.id, {
      title: "Backlog",
      status: "backlog",
    });
    const todo = await createTask(harness, project.project.id, { title: "Todo" });
    const inProgress = await createTask(harness, project.project.id, {
      title: "Progress",
      status: "in_progress",
    });
    const done = await createTask(harness, project.project.id, {
      title: "Done",
      status: "done",
    });

    expect([backlog.task.status, todo.task.status, inProgress.task.status]).toEqual([
      "backlog",
      "todo",
      "in_progress",
    ]);
    expect(backlog.task.completedAt).toBeNull();
    expect(done.task.completedAt).not.toBeNull();

    const completed = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskComplete, {
        id: todo.task.id,
        expectedVersion: todo.task.version,
      }),
    );

    expect(completed.task.status).toBe("done");
    expect(completed.task.completedAt).not.toBeNull();

    const repeated = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskComplete, {
        id: completed.task.id,
        expectedVersion: completed.task.version,
      }),
    );

    expect(repeated.task.version).toBe(completed.task.version);
    expect(repeated.task.completedAt).toBe(completed.task.completedAt);

    const reopened = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskMove, {
        id: completed.task.id,
        expectedVersion: completed.task.version,
        status: "todo",
        position: 0,
      }),
    );

    expect(reopened.task.completedAt).toBeNull();
  });

  it("возвращает VERSION_CONFLICT и не перезаписывает сущность", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Исходный");
    const task = await createTask(harness, project.project.id, { title: "Исходная" });

    const projectConflict = await harness.command(TASKS_COMMAND_IDS.projectUpdate, {
      id: project.project.id,
      expectedVersion: 99,
      title: "Чужое",
    });
    expect(projectConflict.ok).toBe(false);
    if (!projectConflict.ok) {
      expect(projectConflict.error.code).toBe("VERSION_CONFLICT");
    }

    const taskConflict = await harness.command(TASKS_COMMAND_IDS.taskUpdate, {
      id: task.task.id,
      expectedVersion: 99,
      title: "Чужое",
    });
    expect(taskConflict.ok).toBe(false);
    if (!taskConflict.ok) {
      expect(taskConflict.error.code).toBe("VERSION_CONFLICT");
      expect(taskConflict.error.details).toEqual({ expectedVersion: 99, actualVersion: 1 });
    }

    const currentProject = expectOk(
      await harness.query(TASKS_QUERY_IDS.projectGet, {
        id: project.project.id,
      }),
    );
    const currentTask = expectOk(
      await harness.query(TASKS_QUERY_IDS.taskGet, {
        id: task.task.id,
      }),
    );

    expect(currentProject).toMatchObject({ project: { title: "Исходный", version: 1 } });
    expect(currentTask).toMatchObject({ task: { title: "Исходная", version: 1 } });
  });

  it("повторяет результат по Idempotency-Key без новой мутации и события", async () => {
    const harness = await startHarness();
    const input = { title: "Идемпотентный проект", descriptionMarkdown: "" };

    const first = expectOk<ProjectMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.projectCreate, input, {
        idempotencyKey: "key-replay",
      }),
    );
    const eventsAfterFirst = harness.events.filter(
      (event) => event.type === PROJECT_EVENT_TYPES.created,
    ).length;

    const second = expectOk<ProjectMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.projectCreate, input, {
        idempotencyKey: "key-replay",
      }),
    );
    const eventsAfterSecond = harness.events.filter(
      (event) => event.type === PROJECT_EVENT_TYPES.created,
    ).length;

    expect(second).toEqual(first);
    expect(eventsAfterFirst).toBe(1);
    expect(eventsAfterSecond).toBe(1);
    expect(
      expectOk<{ total: number }>(await harness.query(TASKS_QUERY_IDS.projectList, {})).total,
    ).toBe(1);
  });

  it("считает нормализованные tags тем же вводом для Idempotency-Key", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Теги");

    const first = await createTask(
      harness,
      project.project.id,
      { title: "Теги", tags: [" Release ", "release"] },
      { idempotencyKey: "tags-key" },
    );

    expect(first.task.tags).toEqual(["release"]);

    const eventsAfterFirst = harness.events.length;

    const second = await createTask(
      harness,
      project.project.id,
      { title: "Теги", tags: ["release"] },
      { idempotencyKey: "tags-key" },
    );

    expect(second).toEqual(first);
    expect(harness.events.length).toBe(eventsAfterFirst);
    expect((await listTasks(harness, project.project.id)).total).toBe(1);

    await waitFor(async () => {
      const documents = await harness.composition.search.list(PLUGIN_ID);

      return documents.length === 1 ? documents : null;
    });
  });

  it("возвращает IDEMPOTENCY_CONFLICT для другого ввода или другой операции", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Проект", {
      idempotencyKey: "shared-key",
    });

    const otherInput = await harness.command(
      TASKS_COMMAND_IDS.projectCreate,
      { title: "Другой проект", descriptionMarkdown: "" },
      { idempotencyKey: "shared-key" },
    );
    expect(otherInput.ok).toBe(false);
    if (!otherInput.ok) {
      expect(otherInput.error.code).toBe("IDEMPOTENCY_CONFLICT");
    }

    const otherOperation = await harness.command(
      TASKS_COMMAND_IDS.taskCreate,
      { projectId: project.project.id, title: "Задача" },
      { idempotencyKey: "shared-key" },
    );
    expect(otherOperation.ok).toBe(false);
    if (!otherOperation.ok) {
      expect(otherOperation.error.code).toBe("IDEMPOTENCY_CONFLICT");
    }

    expect(
      expectOk<{ total: number }>(await harness.query(TASKS_QUERY_IDS.projectList, {})).total,
    ).toBe(1);
    expect((await listTasks(harness)).total).toBe(0);
  });

  it("не дедуплицирует команды без ключа", async () => {
    const harness = await startHarness();

    const first = await createProject(harness, "Одинаковый");
    const second = await createProject(harness, "Одинаковый");

    expect(first.project.id).not.toBe(second.project.id);
    expect(
      expectOk<{ total: number }>(await harness.query(TASKS_QUERY_IDS.projectList, {})).total,
    ).toBe(2);
  });

  it("откатывает мутацию, если запись idempotency не удалась", async () => {
    const harness = await startHarness({
      decorateProvider: (provider) => failIdempotencyWrites(provider),
    });

    const result = await harness.command(
      TASKS_COMMAND_IDS.projectCreate,
      { title: "Откат", descriptionMarkdown: "" },
      { idempotencyKey: "rollback-key" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
    }

    expect(
      expectOk<{ total: number }>(await harness.query(TASKS_QUERY_IDS.projectList, {})).total,
    ).toBe(0);
    expect(await harness.provider.documents.list(PLUGIN_ID, "idempotency")).toEqual([]);
  });

  it("наблюдает событие после коммита", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);
    const observations: { readonly found: boolean; readonly version: number | null }[] = [];

    const unsubscribe = harness.composition.events.subscribe(
      TASK_EVENT_TYPES.created,
      async (envelope) => {
        const taskId = (envelope.payload as { readonly taskId?: unknown }).taskId;
        const result = await harness.query<{ task: { version: number } }>(TASKS_QUERY_IDS.taskGet, {
          id: taskId,
        });

        observations.push({
          found: result.ok,
          version: result.ok ? result.data.task.version : null,
        });
      },
      { pluginId: "kanbaner.test" },
    );

    try {
      await createTask(harness, project.project.id, { title: "После коммита" });
    } finally {
      unsubscribe();
    }

    expect(observations).toEqual([{ found: true, version: 1 }]);
  });

  it("не блокируется, когда подписчик вызывает команду через общий OperationBus", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Deadlock");
    const nestedResults: TaskMutationOutput[] = [];
    let createdTaskId: string | null = null;

    const unsubscribe = harness.composition.events.subscribe(
      TASK_EVENT_TYPES.created,
      (envelope) => {
        const taskId = (envelope.payload as { readonly taskId: string }).taskId;

        return (async () => {
          const result = await harness.command<TaskMutationOutput>(TASKS_COMMAND_IDS.taskUpdate, {
            id: taskId,
            expectedVersion: 1,
            title: "Обновлено из события",
          });
          nestedResults.push(expectOk(result));
        })();
      },
      { pluginId: "kanbaner.test" },
    );

    try {
      const created = await createTask(harness, project.project.id, {
        title: "Создана до подписчика",
      });
      createdTaskId = created.task.id;

      expect(created.task.title).toBe("Создана до подписчика");
      expect(nestedResults).toHaveLength(1);
      expect(nestedResults[0]).toMatchObject({
        task: { title: "Обновлено из события", version: 2 },
      });
    } finally {
      unsubscribe();
    }

    if (createdTaskId === null) {
      throw new Error("Задача не была создана");
    }

    const current = expectOk<{ task: { title: string; version: number } }>(
      await harness.query(TASKS_QUERY_IDS.taskGet, { id: createdTaskId }),
    );

    expect(current.task).toMatchObject({ title: "Обновлено из события", version: 2 });
  });

  it("публикует task.updated для каждого сдвинутого соседа при move внутри статуса", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);
    const first = await createTask(harness, project.project.id, { title: "Первая" });
    const second = await createTask(harness, project.project.id, { title: "Вторая" });
    const third = await createTask(harness, project.project.id, { title: "Третья" });
    const fourth = await createTask(harness, project.project.id, { title: "Четвёртая" });

    harness.events.splice(0);
    const moved = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskMove, {
        id: fourth.task.id,
        expectedVersion: fourth.task.version,
        status: "todo",
        position: 1,
      }),
    );

    expect(moved.task.position).toBe(1);

    const updated = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.updated);

    expect(updated).toHaveLength(2);
    expect(updated.map((event) => event.resource).sort()).toEqual(
      [formatTaskRef(second.task.id), formatTaskRef(third.task.id)].sort(),
    );
    expect(
      updated.map((event) => ({
        position: (event.payload as { readonly position?: unknown }).position,
        version: event.resourceVersion,
      })),
    ).toEqual(
      expect.arrayContaining([
        { position: 2, version: 2 },
        { position: 3, version: 2 },
      ]),
    );
    expect(
      updated.some(
        (event) =>
          event.resource === formatTaskRef(first.task.id) ||
          event.resource === formatTaskRef(fourth.task.id),
      ),
    ).toBe(false);
  });

  it("публикует task.updated в источнике и цели при move между статусами", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);
    const first = await createTask(harness, project.project.id, { title: "Todo 0" });
    const second = await createTask(harness, project.project.id, { title: "Todo 1" });
    const third = await createTask(harness, project.project.id, { title: "Todo 2" });
    const targetFirst = await createTask(harness, project.project.id, {
      title: "Progress 0",
      status: "in_progress",
    });
    const targetSecond = await createTask(harness, project.project.id, {
      title: "Progress 1",
      status: "in_progress",
    });

    harness.events.splice(0);
    const moved = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskMove, {
        id: second.task.id,
        expectedVersion: second.task.version,
        status: "in_progress",
        position: 1,
      }),
    );

    expect(moved.task.status).toBe("in_progress");
    expect(moved.task.position).toBe(1);

    const movedEvents = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.moved);
    expect(movedEvents).toHaveLength(1);
    expect(movedEvents[0]?.resource).toBe(formatTaskRef(second.task.id));
    expect(movedEvents[0]?.payload).toMatchObject({
      fromStatus: "todo",
      toStatus: "in_progress",
      position: 1,
    });

    const updated = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.updated);
    expect(updated).toHaveLength(2);
    expect(updated.map((event) => event.resource).sort()).toEqual(
      [formatTaskRef(third.task.id), formatTaskRef(targetSecond.task.id)].sort(),
    );
    expect(
      updated.map((event) => ({
        resource: event.resource,
        position: (event.payload as { readonly position?: unknown }).position,
        version: event.resourceVersion,
      })),
    ).toEqual(
      expect.arrayContaining([
        { resource: formatTaskRef(third.task.id), position: 1, version: 2 },
        { resource: formatTaskRef(targetSecond.task.id), position: 2, version: 2 },
      ]),
    );
    expect(updated.some((event) => event.resource === formatTaskRef(first.task.id))).toBe(false);
    expect(updated.some((event) => event.resource === formatTaskRef(targetFirst.task.id))).toBe(
      false,
    );
    expect(updated.some((event) => event.resource === formatTaskRef(second.task.id))).toBe(false);
  });

  it("закрывает разрыв при complete и обновляет только сдвинутого соседа", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);
    const first = await createTask(harness, project.project.id, { title: "Первая" });
    const second = await createTask(harness, project.project.id, { title: "Вторая" });
    const third = await createTask(harness, project.project.id, { title: "Третья" });

    harness.events.splice(0);
    const completed = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskComplete, {
        id: second.task.id,
        expectedVersion: second.task.version,
      }),
    );

    expect(completed.task.status).toBe("done");

    const updated = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.updated);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.resource).toBe(formatTaskRef(third.task.id));
    expect(updated[0]?.resourceVersion).toBe(2);
    expect((updated[0]?.payload as { readonly position?: unknown }).position).toBe(1);
    expect(harness.events.some((event) => event.type === TASK_EVENT_TYPES.deleted)).toBe(false);
    expect(
      updated.some(
        (event) =>
          event.resource === formatTaskRef(first.task.id) ||
          event.resource === formatTaskRef(second.task.id),
      ),
    ).toBe(false);
  });

  it("публикует delete для корня и подзадачи и один update для выжившего соседа", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);
    const parent = await createTask(harness, project.project.id, { title: "Родитель" });
    const child = await createTask(harness, project.project.id, {
      title: "Подзадача",
      parentTaskId: parent.task.id,
    });
    const survivor = await createTask(harness, project.project.id, { title: "Выживший" });

    harness.events.splice(0);
    const deletion = expectOk<DeleteOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskDelete, {
        id: parent.task.id,
        expectedVersion: parent.task.version,
        confirm: true,
      }),
    );

    expect(deletion.deleted).toBe(true);
    if (!deletion.deleted) {
      return;
    }

    expect(deletion.deletedTasks).toHaveLength(2);

    const deleted = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.deleted);
    expect(deleted).toHaveLength(2);
    expect(deleted.map((event) => event.resource).sort()).toEqual(
      [formatTaskRef(parent.task.id), formatTaskRef(child.task.id)].sort(),
    );
    expect(deleted.some((event) => event.resource === formatTaskRef(survivor.task.id))).toBe(false);

    const updated = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.updated);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.resource).toBe(formatTaskRef(survivor.task.id));
    expect(updated[0]?.resourceVersion).toBe(2);
    expect((updated[0]?.payload as { readonly position?: unknown }).position).toBe(0);
    expect(
      updated.some(
        (event) =>
          event.resource === formatTaskRef(parent.task.id) ||
          event.resource === formatTaskRef(child.task.id),
      ),
    ).toBe(false);
  });

  it("остаётся успешной при сбое публикации события после коммита", async () => {
    const harness = await startHarness();
    failEventPublication(harness.composition);
    const project = await createProject(harness, "Событие не доставлено");

    expect(project.project.title).toBe("Событие не доставлено");
    expect(
      harness.logs.some(
        (entry) => entry.level === "warn" && entry.message === "tasks.event_publish_failed",
      ),
    ).toBe(true);
    expect(
      expectOk(await harness.query(TASKS_QUERY_IDS.projectGet, { id: project.project.id })),
    ).toMatchObject({ project: { id: project.project.id, title: "Событие не доставлено" } });
    expect(
      expectOk<{ total: number }>(await harness.query(TASKS_QUERY_IDS.projectList, {})).total,
    ).toBe(1);
  });

  it("остаётся успешной при сбое поиска после коммита", async () => {
    const harness = await startHarness({ decorateProvider: failSearchUpserts });
    const project = await createProject(harness, "Поиск не удался");
    const task = await createTask(harness, project.project.id, { title: "Сохранена" });

    expect(task.task.title).toBe("Сохранена");
    expect(
      harness.logs.some(
        (entry) => entry.level === "warn" && entry.message === "tasks.search_upsert_failed",
      ),
    ).toBe(true);
    expect(
      expectOk(await harness.query(TASKS_QUERY_IDS.taskGet, { id: task.task.id })),
    ).toMatchObject({ task: { id: task.task.id, title: "Сохранена" } });
  });

  it("публикует task.updated для каждого сдвинутого соседа с новой позицией и версией", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);
    const first = await createTask(harness, project.project.id, { title: "Первая" });
    const second = await createTask(harness, project.project.id, { title: "Вторая" });
    const third = await createTask(harness, project.project.id, { title: "Третья" });

    expect([first.task.position, second.task.position, third.task.position]).toEqual([0, 1, 2]);

    harness.events.splice(0);
    const inserted = await createTask(harness, project.project.id, {
      title: "Вставка",
      position: 1,
    });

    expect(inserted.task.position).toBe(1);

    const updated = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.updated);

    expect(updated).toHaveLength(2);
    expect(
      updated.map((event) => ({
        resource: event.resource,
        resourceVersion: event.resourceVersion,
        position: (event.payload as { readonly position?: unknown }).position,
      })),
    ).toEqual(
      expect.arrayContaining([
        { resource: formatTaskRef(second.task.id), resourceVersion: 2, position: 2 },
        { resource: formatTaskRef(third.task.id), resourceVersion: 2, position: 3 },
      ]),
    );
    expect(updated.some((event) => event.resource === formatTaskRef(first.task.id))).toBe(false);

    const current = await listTasks(harness, project.project.id);
    expect(current.items.map((task) => [task.title, task.position, task.version])).toEqual([
      ["Первая", 0, 1],
      ["Вставка", 1, 1],
      ["Вторая", 2, 2],
      ["Третья", 3, 2],
    ]);
  });

  it("использует eventVersion версии+1 для корня и каскада delete", async () => {
    const harness = await startHarness();
    const project = await createProject(harness);
    const parent = await createTask(harness, project.project.id, { title: "Родитель" });
    const child = await createTask(harness, project.project.id, {
      title: "Подзадача",
      parentTaskId: parent.task.id,
    });
    const updatedChild = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskUpdate, {
        id: child.task.id,
        expectedVersion: 1,
        title: "Подзадача 2",
      }),
    );

    expect(updatedChild.task.version).toBe(2);
    harness.events.splice(0);

    const deletion = expectOk<DeleteOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskDelete, {
        id: parent.task.id,
        expectedVersion: 1,
        confirm: true,
      }),
    );

    expect(deletion.deleted).toBe(true);
    if (!deletion.deleted) {
      return;
    }

    expect(deletion.version).toBe(1);
    expect(deletion.eventVersion).toBe(2);
    expect(deletion.deletedTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.task.id,
          version: 1,
          eventVersion: 2,
        }),
        expect.objectContaining({
          id: child.task.id,
          version: 2,
          eventVersion: 3,
        }),
      ]),
    );

    const deletedEvents = harness.events.filter((event) => event.type === TASK_EVENT_TYPES.deleted);

    expect(deletedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: formatTaskRef(parent.task.id),
          resourceVersion: 2,
        }),
        expect.objectContaining({
          resource: formatTaskRef(child.task.id),
          resourceVersion: 3,
        }),
      ]),
    );
    expect((await listTasks(harness)).total).toBe(0);
  });

  it("разрешает ResourceRef проекта и задачи через реестр", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Ресурс");
    const task = await createTask(harness, project.project.id, { title: "Задача" });

    const projectResolution = await harness.composition.resources.resolve(
      formatProjectRef(project.project.id),
    );
    const taskResolution = await harness.composition.resources.resolve(formatTaskRef(task.task.id));

    expect(projectResolution.ok).toBe(true);
    if (projectResolution.ok) {
      expect(projectResolution.data).toMatchObject({
        ref: formatProjectRef(project.project.id),
        resourceType: "project",
        title: "Ресурс",
      });
    }

    expect(taskResolution.ok).toBe(true);
    if (taskResolution.ok) {
      expect(taskResolution.data).toMatchObject({
        ref: formatTaskRef(task.task.id),
        resourceType: "task",
        title: "Задача",
        metadata: { projectId: project.project.id, status: "todo" },
      });
    }

    const missing = await harness.composition.resources.resolve(formatTaskRef("missing-task"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("NOT_FOUND");
    }
  });

  it("находит задачу по кириллице и очищает поиск при удалении проекта", async () => {
    const harness = await startHarness();
    const project = await createProject(harness, "Поиск");
    const first = await createTask(harness, project.project.id, {
      title: "Подготовить релиз",
      descriptionMarkdown: "Кириллический поиск по описанию",
    });
    const second = await createTask(harness, project.project.id, {
      title: "Проверить документы",
    });

    const hits = await searchText(harness, "подготовить");
    expect(hits.map((hit) => hit.ref)).toContain(formatTaskRef(first.task.id));

    const deletion = expectOk<DeleteOutput>(
      await harness.command(TASKS_COMMAND_IDS.projectDelete, {
        id: project.project.id,
        expectedVersion: 1,
        confirm: true,
      }),
    );
    expect(deletion.deleted).toBe(true);

    expect(await searchText(harness, "подготовить")).toEqual([]);
    expect(await searchText(harness, "документы")).toEqual([]);
    expect(await harness.composition.search.list(PLUGIN_ID)).toEqual([]);
    expect((await listTasks(harness)).total).toBe(0);
    expect(second.task.id).not.toBe(first.task.id);
  });

  it("не теряет задачу, созданную во время переиндексации второй активации", async () => {
    const gate = createReindexGate();
    const first = await startHarness();
    const dataDirectory = first.dataDirectory;
    const project = await createProject(first, "Reindex gate");
    await first.close(false);

    const second = await startHarness({
      dataDirectory,
      removeOnClose: false,
      decorateProvider: gate.decorate,
    });

    try {
      await gate.entered;

      const createPromise = createTask(second, project.project.id, {
        title: "Во время reindex",
      });
      let settled = false;
      void createPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(settled).toBe(false);

      gate.release();
      const created = await createPromise;

      await waitFor(async () => {
        const documents = await second.composition.search.list(PLUGIN_ID);

        return documents.length === 1 ? documents : null;
      });

      const documents = await second.composition.search.list(PLUGIN_ID);
      expect(documents).toHaveLength(1);
      expect(documents[0]?.ref).toBe(formatTaskRef(created.task.id));
      expect(documents[0]?.text).toContain("Во время reindex");
    } finally {
      gate.release();
    }
  });

  it("после перезапуска сохраняет данные и не дублирует поисковые документы", async () => {
    const first = await startHarness();
    const dataDirectory = first.dataDirectory;
    const project = await createProject(first, "Перезапуск");
    const task = await createTask(first, project.project.id, { title: "Сохранить" });

    await waitFor(async () => {
      const documents = await first.composition.search.list(PLUGIN_ID);

      return documents.length === 1 ? documents : null;
    });
    await first.close(false);

    const second = await startHarness({ dataDirectory, removeOnClose: false });
    const persisted = expectOk<{ task: { id: string; title: string } }>(
      await second.query(TASKS_QUERY_IDS.taskGet, { id: task.task.id }),
    );

    expect(persisted.task).toMatchObject({ id: task.task.id, title: "Сохранить" });

    await waitFor(async () => {
      const documents = await second.composition.search.list(PLUGIN_ID);

      return documents.length === 1 ? documents : null;
    });

    const extra = await createTask(second, project.project.id, { title: "Вторая" });
    await waitFor(async () => {
      const documents = await second.composition.search.list(PLUGIN_ID);

      return documents.length === 2 ? documents : null;
    });

    const refs = (await second.composition.search.list(PLUGIN_ID)).map((doc) => doc.ref);
    expect(new Set(refs).size).toBe(2);
    expect(refs).toEqual(
      expect.arrayContaining([formatTaskRef(task.task.id), formatTaskRef(extra.task.id)]),
    );
  });

  it("работает на delayed SQLite", async () => {
    const harness = await startHarness({
      delays: { openMs: 2, healthCheckMs: 2, operationMs: 2, transactionMs: 2 },
    });
    const project = await createProject(harness, "Delayed");
    const created = await createTask(harness, project.project.id, { title: "Delayed задача" });

    const moved = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskMove, {
        id: created.task.id,
        expectedVersion: created.task.version,
        status: "in_progress",
        position: 0,
      }),
    );
    const completed = expectOk<TaskMutationOutput>(
      await harness.command(TASKS_COMMAND_IDS.taskComplete, {
        id: moved.task.id,
        expectedVersion: moved.task.version,
      }),
    );

    expect(completed.task.status).toBe("done");
    expect(completed.task.completedAt).not.toBeNull();
    expect(await searchText(harness, "delayed")).toHaveLength(1);
  });
});

/**
 * Провайдер-обёртка, который падает на записи коллекции `idempotency`.
 *
 * Доменная мутация успевает выполниться внутри транзакции, но rejected
 * Promise откатывает её, а запись идемпотентности не остаётся.
 */
function failIdempotencyWrites(provider: StorageProvider): StorageProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === "withTransaction") {
        return async (callback: Parameters<StorageProvider["withTransaction"]>[0]) =>
          target.withTransaction(async (transaction) =>
            callback({
              ...transaction,
              documents: new Proxy(transaction.documents, {
                get(documents, documentProperty, documentsReceiver) {
                  if (documentProperty === "put") {
                    return async (input: Parameters<typeof transaction.documents.put>[0]) => {
                      if (input.collection === "idempotency") {
                        throw new Error("injected idempotency write failure");
                      }

                      return transaction.documents.put(input);
                    };
                  }

                  const value = Reflect.get(documents, documentProperty, documentsReceiver);

                  return typeof value === "function" ? value.bind(documents) : value;
                },
              }),
            }),
          );
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Ломает публикацию событий на уровне общего EventBus после коммита. */
function failEventPublication(composition: ApplicationPluginComposition): void {
  composition.events.publishAfterCommit = async () => {
    throw new Error("injected event publish failure");
  };
}

/** Провайдер с падающим search.upsert: команда не должна упасть. */
function failSearchUpserts(provider: StorageProvider): StorageProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === "searchIndex") {
        return new Proxy(target.searchIndex, {
          get(searchIndex, searchProperty, searchReceiver) {
            if (searchProperty === "upsert") {
              return async (): Promise<never> => {
                throw new Error("injected search upsert failure");
              };
            }

            const value = Reflect.get(searchIndex, searchProperty, searchReceiver);

            return typeof value === "function" ? value.bind(searchIndex) : value;
          },
        });
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface ReindexGate {
  readonly entered: Promise<void>;
  readonly decorate: (provider: StorageProvider) => StorageProvider;
  release(): void;
}

/**
 * Gate на `search.reindex` внутри provider-транзакции.
 *
 * Позволяет детерминированно удержать полную переиндексацию активации и
 * проверить, что конкурентная команда ждёт освобождения очереди.
 */
function createReindexGate(): ReindexGate {
  let enter: (() => void) | undefined;
  let releaseGate: (() => void) | undefined;
  let enteredOnce = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  return {
    entered,
    release() {
      releaseGate?.();
    },
    decorate(provider) {
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "withTransaction") {
            return async (callback: Parameters<StorageProvider["withTransaction"]>[0]) =>
              target.withTransaction(async (transaction) =>
                callback({
                  ...transaction,
                  searchIndex: new Proxy(transaction.searchIndex, {
                    get(searchIndex, searchProperty, searchReceiver) {
                      if (searchProperty === "reindex") {
                        return async (
                          input: Parameters<typeof transaction.searchIndex.reindex>[0],
                        ) => {
                          if (!enteredOnce) {
                            enteredOnce = true;
                            enter?.();
                          }

                          await released;

                          return transaction.searchIndex.reindex(input);
                        };
                      }

                      const value = Reflect.get(searchIndex, searchProperty, searchReceiver);

                      return typeof value === "function" ? value.bind(searchIndex) : value;
                    },
                  }),
                }),
              );
          }

          const value = Reflect.get(target, property, receiver);

          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}
