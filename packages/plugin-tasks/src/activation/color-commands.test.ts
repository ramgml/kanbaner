// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  EventEnvelope,
  EventService,
  OperationResult,
  PluginSearchService,
  SearchDocumentInput,
  SearchHit,
  SearchIndexDocument,
  SearchRegistrar,
  StorageProvider,
} from "@kanbaner/plugin-sdk";
import {
  InMemoryStorageProvider,
  StorageMigrationRunner,
  bindPluginStorage,
  createOperationBus,
  type OperationBus,
} from "@kanbaner/kernel";
import {
  createCoreInfrastructureMigrations,
  createSqliteStorageProvider,
} from "@kanbaner/storage-sqlite";

import { activate, type TasksActivationContext } from "../activation.ts";
import {
  COLUMN_EVENT_TYPES,
  PLUGIN_ID,
  PROJECT_EVENT_TYPES,
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
} from "../constants.ts";
import type { ColumnMutationOutput } from "../schemas/column.ts";
import type { ProjectMutationOutput } from "../schemas/project.ts";

const NOOP_LOGGER = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

interface Harness {
  readonly events: EventEnvelope[];
  command<T = unknown>(operationId: string, input: unknown): Promise<OperationResult<T>>;
  query<T = unknown>(operationId: string, input: unknown): Promise<OperationResult<T>>;
}

interface Variant {
  readonly name: string;
  create(): Promise<{
    readonly provider: StorageProvider;
    readonly close: () => Promise<void>;
  }>;
}

function memoryVariant(): Variant {
  return {
    name: "in-memory",
    async create() {
      const provider = new InMemoryStorageProvider({ backendId: "color-memory" });
      await provider.open();

      return { provider, close: () => provider.close() };
    },
  };
}

function sqliteVariant(): Variant {
  return {
    name: "sqlite",
    async create() {
      const directory = mkdtempSync(join(tmpdir(), "kanbaner-color-commands-"));
      directories.push(directory);
      let provider: StorageProvider | null = null;

      try {
        provider = createSqliteStorageProvider({
          backendId: "color-sqlite",
          dataDirectory: directory,
        });
        await provider.open();
        await new StorageMigrationRunner(provider).run(createCoreInfrastructureMigrations());
      } catch (error) {
        await provider?.close();
        throw error;
      }

      const opened = provider;

      return { provider: opened, close: () => opened.close() };
    },
  };
}

function createSearchService(): PluginSearchService {
  return {
    async upsert(documents: readonly SearchDocumentInput[]): Promise<number> {
      return documents.length;
    },
    async delete(): Promise<boolean> {
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
    registerProvider(): void {
      // Provider не требуется в unit-тесте команд.
    },
    unregisterProviders(): void {
      // Provider не зарегистрирован.
    },
    async aggregate() {
      return { hits: [], hasMore: false, warnings: [] };
    },
    async listFacets() {
      return { kinds: [], facets: [], warnings: [] };
    },
  };
}

function createSearchRegistrar(): SearchRegistrar {
  return {
    async upsert(_pluginId, documents): Promise<number> {
      return documents.length;
    },
    async delete(): Promise<boolean> {
      return true;
    },
    async list(): Promise<readonly SearchIndexDocument[]> {
      return [];
    },
    async search(): Promise<readonly SearchHit[]> {
      return [];
    },
    async reindex(_pluginId, documents): Promise<number> {
      return documents.length;
    },
    registerProvider(): void {
      // Provider не требуется в unit-тесте шины.
    },
    unregisterProviders(): void {
      // Provider не зарегистрирован.
    },
    async aggregate() {
      return { hits: [], hasMore: false, warnings: [] };
    },
    async listFacets() {
      return { kinds: [], facets: [], warnings: [] };
    },
  };
}

function createEventService(events: EventEnvelope[]): EventService {
  return {
    subscribe() {
      return () => false;
    },
    async publishAfterCommit(envelope) {
      events.push(envelope);

      return {
        status: "accepted" as const,
        eventId: envelope.eventId,
        matchedSubscribers: 0,
        failedSubscribers: 0,
      };
    },
  };
}

async function startHarness(variant: Variant): Promise<Harness> {
  const resources = await variant.create();
  const events: EventEnvelope[] = [];
  const search = createSearchService();
  const bus: OperationBus = createOperationBus({
    storage: resources.provider,
    events: createEventService(events),
    search: createSearchRegistrar(),
    logger: NOOP_LOGGER,
    validateOutput: true,
  });

  const context = {
    pluginId: PLUGIN_ID,
    storage: bindPluginStorage(resources.provider, PLUGIN_ID),
    search,
    commands: {
      register(registration: Parameters<OperationBus["registerCommand"]>[0]): void {
        bus.registerCommand(registration);
      },
      unregister(): boolean {
        return false;
      },
    },
    queries: {
      register(registration: Parameters<OperationBus["registerQuery"]>[0]): void {
        bus.registerQuery(registration);
      },
      unregister(): boolean {
        return false;
      },
    },
    resourceTypes: {
      register(): void {},
      unregister(): void {},
    },
    resources: {},
    ui: {
      register(): void {},
      unregister(): void {},
    },
    logger: NOOP_LOGGER,
  } as unknown as TasksActivationContext;

  await activate(context);

  const harness: Harness = {
    events,
    command<T>(operationId: string, input: unknown): Promise<OperationResult<T>> {
      return bus.executeCommand<unknown, T>(operationId, input, {
        source: { type: "system", id: "color-commands-test" },
      });
    },
    query<T>(operationId: string, input: unknown): Promise<OperationResult<T>> {
      return bus.executeQuery<unknown, T>(operationId, input, {
        source: { type: "system", id: "color-commands-test" },
      });
    },
  };

  closers.push(resources.close);

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

function expectOk<Data>(result: OperationResult<Data>): Data {
  if (!result.ok) {
    throw new Error(`Операция упала: ${result.error.code} (${result.error.message})`);
  }

  return result.data;
}

function payloadOf(event: EventEnvelope): {
  readonly changed?: readonly string[];
  readonly version?: number;
} {
  return event.payload as { readonly changed?: readonly string[]; readonly version?: number };
}

async function createProject(harness: Harness, color?: string): Promise<ProjectMutationOutput> {
  return expectOk<ProjectMutationOutput>(
    await harness.command(TASKS_COMMAND_IDS.projectCreate, {
      title: "Проект",
      descriptionMarkdown: "Описание проекта",
      ...(color === undefined ? {} : { color }),
    }),
  );
}

async function createColumn(
  harness: Harness,
  projectId: string,
  color?: string,
): Promise<ColumnMutationOutput> {
  return expectOk<ColumnMutationOutput>(
    await harness.command(TASKS_COMMAND_IDS.columnCreate, {
      projectId,
      title: "Колонка",
      type: "open",
      ...(color === undefined ? {} : { color }),
    }),
  );
}

const variants: readonly Variant[] = [memoryVariant(), sqliteVariant()];

for (const variant of variants) {
  describe(`активация: цвет проекта и колонки (${variant.name})`, () => {
    it("project.create сохраняет цвет, а color-only update сохраняет title и публикует changed [color]", async () => {
      const harness = await startHarness(variant);
      const created = await createProject(harness, "blue");

      expect(created.project.color).toBe("blue");
      expect(created.project.title).toBe("Проект");
      expect(created.project.descriptionMarkdown).toBe("Описание проекта");
      expect(created.project.version).toBe(1);
      expect(harness.events.map((event) => event.type)).toEqual([PROJECT_EVENT_TYPES.created]);

      harness.events.length = 0;

      const updated = expectOk<ProjectMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.projectUpdate, {
          id: created.project.id,
          expectedVersion: created.project.version,
          color: "green",
        }),
      );

      expect(updated.project.color).toBe("green");
      expect(updated.project.title).toBe(created.project.title);
      expect(updated.project.descriptionMarkdown).toBe(created.project.descriptionMarkdown);
      expect(updated.project.version).toBe(created.project.version + 1);
      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]?.type).toBe(PROJECT_EVENT_TYPES.updated);
      expect(harness.events[0]?.resourceVersion).toBe(updated.project.version);
      expect(payloadOf(harness.events[0] as EventEnvelope)).toEqual({
        projectId: created.project.id,
        version: updated.project.version,
        changed: ["color"],
      });

      const reread = expectOk<{ readonly project: ProjectMutationOutput["project"] }>(
        await harness.query(TASKS_QUERY_IDS.projectGet, { id: created.project.id }),
      );

      expect(reread.project).toEqual(updated.project);
    });

    it("повтор того же цвета проекта не меняет version и updatedAt и не публикует событие", async () => {
      const harness = await startHarness(variant);
      const created = await createProject(harness, "blue");
      const recolored = expectOk<ProjectMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.projectUpdate, {
          id: created.project.id,
          expectedVersion: created.project.version,
          color: "green",
        }),
      );

      harness.events.length = 0;

      const repeated = expectOk<ProjectMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.projectUpdate, {
          id: recolored.project.id,
          expectedVersion: recolored.project.version,
          color: "green",
        }),
      );

      expect(repeated.project).toEqual(recolored.project);
      expect(repeated.project.color).toBe("green");
      expect(harness.events).toEqual([]);

      const reread = expectOk<{ readonly project: ProjectMutationOutput["project"] }>(
        await harness.query(TASKS_QUERY_IDS.projectGet, { id: recolored.project.id }),
      );

      expect(reread.project).toEqual(recolored.project);
    });

    it("устаревший expectedVersion при совпадающем цвете проекта даёт VERSION_CONFLICT", async () => {
      const harness = await startHarness(variant);
      const created = await createProject(harness, "blue");
      const recolored = expectOk<ProjectMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.projectUpdate, {
          id: created.project.id,
          expectedVersion: created.project.version,
          color: "green",
        }),
      );

      harness.events.length = 0;

      const result = await harness.command(TASKS_COMMAND_IDS.projectUpdate, {
        id: recolored.project.id,
        expectedVersion: created.project.version,
        color: "green",
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("VERSION_CONFLICT");
        expect(result.error.details).toEqual({
          expectedVersion: created.project.version,
          actualVersion: recolored.project.version,
        });
      }

      expect(harness.events).toEqual([]);

      const reread = expectOk<{ readonly project: ProjectMutationOutput["project"] }>(
        await harness.query(TASKS_QUERY_IDS.projectGet, { id: created.project.id }),
      );

      expect(reread.project).toEqual(recolored.project);
    });

    it("column.create сохраняет цвет, а color-only update сохраняет title и публикует changed [color]", async () => {
      const harness = await startHarness(variant);
      const project = await createProject(harness);

      harness.events.length = 0;

      const created = await createColumn(harness, project.project.id, "blue");

      expect(created.column.color).toBe("blue");
      expect(created.column.title).toBe("Колонка");
      expect(created.column.version).toBe(1);
      expect(harness.events.map((event) => event.type)).toEqual([COLUMN_EVENT_TYPES.created]);

      harness.events.length = 0;

      const updated = expectOk<ColumnMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.columnUpdate, {
          id: created.column.id,
          expectedVersion: created.column.version,
          color: "orange",
        }),
      );

      expect(updated.column.color).toBe("orange");
      expect(updated.column.title).toBe(created.column.title);
      expect(updated.column.version).toBe(created.column.version + 1);
      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]?.type).toBe(COLUMN_EVENT_TYPES.updated);
      expect(harness.events[0]?.resourceVersion).toBe(updated.column.version);
      expect(payloadOf(harness.events[0] as EventEnvelope)).toEqual({
        columnId: created.column.id,
        projectId: project.project.id,
        version: updated.column.version,
        position: updated.column.position,
        changed: ["color"],
      });

      const list = expectOk<{ readonly items: readonly ColumnMutationOutput["column"][] }>(
        await harness.query(TASKS_QUERY_IDS.columnList, {
          projectId: project.project.id,
          limit: 200,
          offset: 0,
        }),
      );
      const reread = list.items.find((column) => column.id === created.column.id);

      expect(reread).toEqual(updated.column);
    });

    it("повтор того же цвета колонки не меняет version и updatedAt и не публикует событие", async () => {
      const harness = await startHarness(variant);
      const project = await createProject(harness);
      const created = await createColumn(harness, project.project.id, "blue");
      const recolored = expectOk<ColumnMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.columnUpdate, {
          id: created.column.id,
          expectedVersion: created.column.version,
          color: "orange",
        }),
      );

      harness.events.length = 0;

      const repeated = expectOk<ColumnMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.columnUpdate, {
          id: recolored.column.id,
          expectedVersion: recolored.column.version,
          color: "orange",
        }),
      );

      expect(repeated.column).toEqual(recolored.column);
      expect(repeated.column.color).toBe("orange");
      expect(harness.events).toEqual([]);

      const list = expectOk<{ readonly items: readonly ColumnMutationOutput["column"][] }>(
        await harness.query(TASKS_QUERY_IDS.columnList, {
          projectId: project.project.id,
          limit: 200,
          offset: 0,
        }),
      );

      expect(list.items.find((column) => column.id === recolored.column.id)).toEqual(
        recolored.column,
      );
    });

    it("устаревший expectedVersion при совпадающем цвете колонки даёт VERSION_CONFLICT", async () => {
      const harness = await startHarness(variant);
      const project = await createProject(harness);
      const created = await createColumn(harness, project.project.id, "blue");
      const recolored = expectOk<ColumnMutationOutput>(
        await harness.command(TASKS_COMMAND_IDS.columnUpdate, {
          id: created.column.id,
          expectedVersion: created.column.version,
          color: "orange",
        }),
      );

      harness.events.length = 0;

      const result = await harness.command(TASKS_COMMAND_IDS.columnUpdate, {
        id: recolored.column.id,
        expectedVersion: created.column.version,
        color: "orange",
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("VERSION_CONFLICT");
        expect(result.error.details).toEqual({
          expectedVersion: created.column.version,
          actualVersion: recolored.column.version,
        });
      }

      expect(harness.events).toEqual([]);

      const list = expectOk<{ readonly items: readonly ColumnMutationOutput["column"][] }>(
        await harness.query(TASKS_QUERY_IDS.columnList, {
          projectId: project.project.id,
          limit: 200,
          offset: 0,
        }),
      );

      expect(list.items.find((column) => column.id === recolored.column.id)).toEqual(
        recolored.column,
      );
    });

    it("column.update без title и color отклоняется схемой до записи", async () => {
      const harness = await startHarness(variant);
      const project = await createProject(harness);
      const created = await createColumn(harness, project.project.id, "blue");

      harness.events.length = 0;

      const result = await harness.command(TASKS_COMMAND_IDS.columnUpdate, {
        id: created.column.id,
        expectedVersion: created.column.version,
      });

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }

      expect(harness.events).toEqual([]);
    });
  });
}
