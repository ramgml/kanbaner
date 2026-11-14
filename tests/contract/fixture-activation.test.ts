// @vitest-environment node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { InMemoryStorageProvider } from "@kanbaner/kernel";
import type { OperationResult, PluginDocument, StorageProvider } from "@kanbaner/plugin-sdk";
import { SqliteStorageProvider } from "@kanbaner/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  FIXTURE_AUDIT_COLLECTION,
  FIXTURE_COMMAND_CREATE,
  FIXTURE_COMMAND_DELETE,
  FIXTURE_COMMAND_REINDEX,
  FIXTURE_EVENT_CREATED,
  FIXTURE_EVENT_DELETED,
  FIXTURE_ITEM_TYPE,
  FIXTURE_PLUGIN_ID,
  FIXTURE_QUERY_LIST,
  FIXTURE_QUERY_SEARCH,
} from "../../packages/plugin-fixture/src/index.ts";
import { heavyPluginSuite } from "../suite-timeouts.ts";
import {
  removeDirectory,
  startFixtureHarness,
  temporaryDirectory,
  type FixtureHarness,
} from "./fixture-harness.ts";

const harnesses: FixtureHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }

  for (const directory of directories.splice(0)) {
    removeDirectory(directory);
  }
});

function track(harness: FixtureHarness): FixtureHarness {
  harnesses.push(harness);

  return harness;
}

function dataOf(result: OperationResult<unknown>): Record<string, unknown> {
  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(`Операция завершилась ошибкой: ${result.error.code}`);
  }

  return result.data as Record<string, unknown>;
}

function itemsOf(result: OperationResult<unknown>): readonly Record<string, unknown>[] {
  const items = dataOf(result).items;

  expect(Array.isArray(items)).toBe(true);

  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

function hitsOf(result: OperationResult<unknown>): readonly Record<string, unknown>[] {
  const hits = dataOf(result).hits;

  expect(Array.isArray(hits)).toBe(true);

  return Array.isArray(hits) ? (hits as Record<string, unknown>[]) : [];
}

async function execute(
  harness: FixtureHarness,
  operationId: string,
  input: unknown,
): Promise<OperationResult<unknown>> {
  const descriptor = harness.composition.operations.registry.get(operationId);

  if (descriptor === undefined) {
    throw new Error(`Операция ${operationId} не зарегистрирована`);
  }

  const options = { source: { type: "system" as const, id: "contract-test" } };

  return descriptor.kind === "mutation"
    ? harness.composition.operations.executeCommand(operationId, input as never, options)
    : harness.composition.operations.executeQuery(operationId, input as never, options);
}

async function createItem(
  harness: FixtureHarness,
  title: string,
): Promise<Record<string, unknown>> {
  return dataOf(await execute(harness, FIXTURE_COMMAND_CREATE, { title }));
}

async function auditDocuments(harness: FixtureHarness): Promise<readonly PluginDocument[]> {
  return harness.provider.documents.list(FIXTURE_PLUGIN_ID, FIXTURE_AUDIT_COLLECTION);
}

function failingPutDocuments(
  documents: StorageProvider["documents"],
): StorageProvider["documents"] {
  return {
    get: documents.get.bind(documents),
    put: async (input: Parameters<StorageProvider["documents"]["put"]>[0]) => {
      if (input.collection === "items") {
        throw new Error("write failed for contract test");
      }

      return documents.put(input);
    },
    delete: documents.delete.bind(documents),
    query: documents.query.bind(documents),
    list: documents.list.bind(documents),
  };
}

function failingPutProvider(provider: StorageProvider): StorageProvider {
  const documents = failingPutDocuments(provider.documents);

  return {
    backendId: provider.backendId,
    capabilities: provider.capabilities,
    documents,
    links: provider.links,
    pluginStates: provider.pluginStates,
    migrations: provider.migrations,
    searchIndex: provider.searchIndex,
    open: provider.open.bind(provider),
    close: provider.close.bind(provider),
    healthCheck: provider.healthCheck.bind(provider),
    withTransaction: (callback) =>
      provider.withTransaction(async (transaction) =>
        callback({ ...transaction, documents: failingPutDocuments(transaction.documents) }),
      ),
    createStore: provider.createStore.bind(provider),
  };
}

function writeGuardPlugin(root: string): void {
  const directory = path.join(root, "guard-probe");

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "plugin.json"),
    JSON.stringify({
      id: "guard.probe",
      name: "Guard Probe",
      version: "1.0.0",
      hostApi: "^1.0.0",
      entrypoints: { server: "./server.mjs" },
      requires: {},
      consumes: [],
      provides: [],
      permissions: ["commands", "storage", "search", "events"],
    }),
  );
  writeFileSync(
    path.join(directory, "server.mjs"),
    `
const envelope = (source, type, resource) => ({
  eventId: crypto.randomUUID(),
  type,
  contractVersion: 1,
  source,
  occurredAt: new Date().toISOString(),
  resource,
  payload: {},
});

export async function activate(context) {
  const activationErrors = [];
  try {
    await context.events.publishAfterCommit(
      envelope("guard.probe", "guard.probe.item.created", "other.plugin:item:x"),
      { traceId: "guard-activation" },
    );
  } catch (error) {
    activationErrors.push(error.error?.code ?? error.code ?? "unknown");
  }

  context.commands.register({
    metadata: {
      id: "guard.probe.check",
      contract: "guard.probe.commands.v1",
      version: 1,
      kind: "mutation",
      risk: "write",
      idempotency: "none",
      exposure: { ui: true, http: false, mcp: false },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async handler(_input, execution) {
      const errors = [...activationErrors];
      const codeOf = async (operation) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error.error?.code ?? error.code ?? "unknown");
        }
      };

      await codeOf(() =>
        execution.storage.documents.get("other.plugin", "items", "x"),
      );
      await codeOf(() =>
        execution.storage.documents.put({
          pluginId: "other.plugin",
          collection: "items",
          id: "x",
          data: {},
        }),
      );
      await codeOf(() =>
        execution.storage.documents.query({ pluginId: "other.plugin" }),
      );
      await codeOf(() => execution.search.delete("other.plugin:item:x"));
      await codeOf(() =>
        execution.search.upsert([
          { ref: "other.plugin:item:x", title: "x", text: "x" },
        ]),
      );
      await codeOf(() =>
        execution.events.publishAfterCommit(
          envelope("other.plugin", "other.plugin.item.created", "other.plugin:item:x"),
          { traceId: "execution" },
        ),
      );
      await codeOf(() =>
        execution.events.publishAfterCommit(
          envelope("guard.probe", "guard.probe.item.created", "other.plugin:item:x"),
          { traceId: "execution" },
        ),
      );

      await execution.storage.withTransaction(async (transaction) => {
        await transaction.documents.put({
          pluginId: "guard.probe",
          collection: "items",
          id: "allowed",
          data: { ok: true },
        });
      });

      return {
        errors,
        hasOpen: typeof execution.storage.open,
        hasClose: typeof execution.storage.close,
        hasMigrations: "migrations" in execution.storage,
        hasLinks: "links" in execution.storage,
        hasCreateStore: typeof execution.storage.createStore,
        hasOwnDocuments: typeof execution.storage.documents.get,
        eventsSubscribe: typeof execution.events.subscribe,
      };
    },
  });
}
`,
  );
}

describe("fixture plugin: публичный lifecycle и общие шины", heavyPluginSuite, () => {
  it("активируется, регистрирует команды, запросы, ресурс, события и UI", async () => {
    const harness = track(await startFixtureHarness());

    const fixture = harness.snapshot.plugins.find(
      (plugin) => plugin.pluginId === FIXTURE_PLUGIN_ID,
    );

    expect(fixture?.status).toBe("active");

    for (const operationId of [
      FIXTURE_COMMAND_CREATE,
      FIXTURE_COMMAND_DELETE,
      FIXTURE_COMMAND_REINDEX,
      FIXTURE_QUERY_LIST,
      FIXTURE_QUERY_SEARCH,
    ]) {
      expect(harness.composition.operations.registry.has(operationId)).toBe(true);
    }

    expect(harness.composition.registry.owns(FIXTURE_PLUGIN_ID, FIXTURE_ITEM_TYPE)).toBe(true);
    // Discovery root — весь packages/, поэтому в composition попадают и
    // встроенные плагины. Проверка относится только к fixture.
    expect(
      harness.composition
        .listUiContributions()
        .filter((record) => record.pluginId === FIXTURE_PLUGIN_ID)
        .map((record) => record.contribution.slot),
    ).toEqual(["app.main", "app.main"]);
  });

  it("выставляет в UI только операции с явным exposure.ui", async () => {
    const harness = track(await startFixtureHarness());
    const uiOperations = new Set([FIXTURE_COMMAND_CREATE, FIXTURE_QUERY_LIST]);

    for (const operationId of [
      FIXTURE_COMMAND_CREATE,
      FIXTURE_COMMAND_DELETE,
      FIXTURE_COMMAND_REINDEX,
      FIXTURE_QUERY_LIST,
      FIXTURE_QUERY_SEARCH,
    ]) {
      expect(harness.composition.operations.registry.get(operationId)?.exposure).toEqual({
        ui: uiOperations.has(operationId),
        http: false,
        mcp: false,
      });
    }

    const created = await harness.composition.executeUiOperation(FIXTURE_COMMAND_CREATE, {
      title: "Через UI",
    });

    expect(created.ok).toBe(true);

    const denied = await harness.composition.executeUiOperation(FIXTURE_COMMAND_DELETE, {
      id: "ui-denied",
    });

    expect(denied.ok).toBe(false);

    if (!denied.ok) {
      expect(denied.error.code).toBe("PLUGIN_UNAVAILABLE");
    }
  });

  it("выполняет команду и запрос через общий OperationBus", async () => {
    const harness = track(await startFixtureHarness());
    const created = await createItem(harness, "Контрактная запись");
    const query = await execute(harness, FIXTURE_QUERY_LIST, {});

    expect(itemsOf(query)).toEqual([
      expect.objectContaining({
        id: created.id,
        title: "Контрактная запись",
      }),
    ]);
    expect(dataOf(query)).toMatchObject({ total: 1, nextOffset: null });
  });

  it("публикует событие только после коммита и не создаёт дубль audit-записи", async () => {
    const harness = track(await startFixtureHarness());

    const observed: { document: PluginDocument | null } = { document: null };

    harness.composition.events.subscribe(
      FIXTURE_EVENT_CREATED,
      async (envelope) => {
        observed.document = await harness.provider.documents.get(
          FIXTURE_PLUGIN_ID,
          "items",
          String((envelope.payload as { itemId: string }).itemId),
        );
      },
      { pluginId: "kanbaner.contract-test" },
    );

    const created = await createItem(harness, "После коммита");

    expect(observed.document).not.toBeNull();
    expect(observed.document?.id).toBe(created.id);
    expect(await auditDocuments(harness)).toHaveLength(1);

    const duplicate = await harness.composition.events.publishAfterCommit(
      {
        eventId: String(created.eventId),
        type: FIXTURE_EVENT_CREATED,
        contractVersion: 1,
        source: FIXTURE_PLUGIN_ID,
        occurredAt: "2026-11-07T00:00:00.000Z",
        resource: String(created.resource),
        resourceVersion: 1,
        payload: { itemId: String(created.id), title: "После коммита" },
      },
      { traceId: "trace-duplicate" },
    );

    expect(duplicate.status).toBe("duplicate");
    expect(await auditDocuments(harness)).toHaveLength(1);
  });

  it("разрешает ResourceRef через публичный ResourceService", async () => {
    const harness = track(await startFixtureHarness());
    const created = await createItem(harness, "Ресурс");
    const resolved = await harness.composition.resources.resolve(String(created.resource));

    expect(resolved.ok).toBe(true);
    expect(resolved.ok ? resolved.data : null).toMatchObject({
      ref: created.resource,
      resourceType: FIXTURE_ITEM_TYPE,
      title: "Ресурс",
      state: "open",
    });
  });

  it("очищает связи и поиск только у владельца удалённого ресурса", async () => {
    const harness = track(await startFixtureHarness());
    const first = await createItem(harness, "Первый");
    const second = await createItem(harness, "Второй");
    const relation = "kanbaner.fixture.references";

    await harness.composition.resources.link(
      String(first.resource),
      String(second.resource),
      relation,
    );

    const foreign = await harness.composition.events.publishAfterCommit(
      {
        eventId: globalThis.crypto.randomUUID(),
        type: "kanbaner.other.item.deleted",
        contractVersion: 1,
        source: "kanbaner.other",
        occurredAt: new Date().toISOString(),
        resource: String(first.resource),
        resourceVersion: 2,
        payload: {},
      },
      { traceId: "trace-foreign-delete" },
    );

    expect(foreign.status).toBe("accepted");
    expect(await harness.composition.resources.list(String(first.resource))).toHaveLength(1);

    const deleted = await execute(harness, FIXTURE_COMMAND_DELETE, { id: first.id });

    expect(dataOf(deleted)).toEqual({ deleted: true });
    expect(await harness.composition.resources.list(String(first.resource))).toEqual([]);
    expect(hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "Первый" }))).toEqual([]);
  });

  it("очищает поиск и связи по deleted из EventBus без команды delete, повтор идемпотентен", async () => {
    const harness = track(await startFixtureHarness());
    const first = await createItem(harness, "Удаляемый");
    const second = await createItem(harness, "Связанный");

    await harness.composition.resources.link(
      String(first.resource),
      String(second.resource),
      "kanbaner.fixture.references",
    );
    await harness.composition.search.upsert(FIXTURE_PLUGIN_ID, [
      {
        ref: String(first.resource),
        title: "Ручной поисковый документ",
        text: "ручноймаркер",
      },
    ]);

    expect(await harness.composition.resources.list(String(first.resource))).toHaveLength(1);
    expect(
      hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "ручноймаркер" })),
    ).toHaveLength(1);

    const publishDeleted = async (): Promise<string> => {
      const eventId = globalThis.crypto.randomUUID();
      const result = await harness.composition.events.publishAfterCommit(
        {
          eventId,
          type: FIXTURE_EVENT_DELETED,
          contractVersion: 1,
          source: FIXTURE_PLUGIN_ID,
          occurredAt: new Date().toISOString(),
          resource: String(first.resource),
          resourceVersion: 2,
          payload: { itemId: String(first.id) },
        },
        { traceId: `trace-direct-delete-${eventId}` },
      );

      expect(result.status).toBe("accepted");

      return eventId;
    };

    await publishDeleted();

    expect(await harness.composition.resources.list(String(first.resource))).toEqual([]);
    expect(hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "ручноймаркер" }))).toEqual(
      [],
    );

    await publishDeleted();

    expect(await harness.composition.resources.list(String(first.resource))).toEqual([]);
    expect(hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "ручноймаркер" }))).toEqual(
      [],
    );
    // Команда delete не вызывалась: документ плагина остаётся на месте.
    expect(
      await harness.provider.documents.get(FIXTURE_PLUGIN_ID, "items", String(first.id)),
    ).not.toBeNull();
  });

  it("создаёт документ поиска, находит его и переиндексирует namespace", async () => {
    const harness = track(await startFixtureHarness());
    const first = await createItem(harness, "Поисковый alpha");
    const second = await createItem(harness, "Поисковый beta");

    const found = hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "Поисковый" }));

    expect(found.map((hit) => hit.ref)).toEqual(
      expect.arrayContaining([first.resource, second.resource]),
    );

    expect(await harness.composition.search.delete(FIXTURE_PLUGIN_ID, String(first.resource))).toBe(
      true,
    );
    expect(
      await harness.composition.search.delete(FIXTURE_PLUGIN_ID, String(second.resource)),
    ).toBe(true);
    expect(hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "Поисковый" }))).toEqual([]);

    expect(dataOf(await execute(harness, FIXTURE_COMMAND_REINDEX, {}))).toEqual({ count: 2 });
    expect(
      hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "Поисковый" })),
    ).toHaveLength(2);
  });

  it("сериализует create с reindex и не теряет запись между чтением и заменой", async () => {
    const harness = track(await startFixtureHarness());

    await createItem(harness, "До reindex");

    const originalReindex = harness.composition.search.reindex.bind(harness.composition.search);
    let startReindex!: () => void;
    let releaseReindex!: () => void;
    const reindexStarted = new Promise<void>((resolve) => {
      startReindex = resolve;
    });
    const reindexGate = new Promise<void>((resolve) => {
      releaseReindex = resolve;
    });

    harness.composition.search.reindex = async (pluginId, documents) => {
      startReindex();
      await reindexGate;

      return originalReindex(pluginId, documents);
    };

    const reindex = execute(harness, FIXTURE_COMMAND_REINDEX, {});

    await reindexStarted;

    let createSettled = false;
    const create = execute(harness, FIXTURE_COMMAND_CREATE, {
      title: "Во время reindex",
    }).then((result) => {
      createSettled = true;

      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createSettled).toBe(false);

    releaseReindex();

    expect(dataOf(await reindex)).toEqual({ count: 1 });

    const created = dataOf(await create);

    expect(created.id).toBeTruthy();
    expect(
      hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "До reindex" })),
    ).toHaveLength(1);
    expect(
      hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "Во время reindex" })),
    ).toHaveLength(1);
  });

  it("отдаёт стабильные страницы с nextOffset", async () => {
    const harness = track(await startFixtureHarness());

    for (const title of ["Страница 1", "Страница 2", "Страница 3"]) {
      await createItem(harness, title);
    }

    const firstPage = dataOf(await execute(harness, FIXTURE_QUERY_LIST, { limit: 2 }));

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(3);
    expect(firstPage.nextOffset).toBe(2);

    const secondPage = dataOf(await execute(harness, FIXTURE_QUERY_LIST, { limit: 2, offset: 2 }));

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextOffset).toBeNull();

    const firstIds = (firstPage.items as readonly { id: string }[]).map((item) => item.id);
    const secondIds = (secondPage.items as readonly { id: string }[]).map((item) => item.id);

    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });

  it("снимает регистрации и подписки при stop и сохраняет данные", async () => {
    const harness = track(await startFixtureHarness());
    const created = await createItem(harness, "Сохраняется");

    expect(await auditDocuments(harness)).toHaveLength(1);

    await harness.stop();

    expect(harness.composition.operations.registry.has(FIXTURE_COMMAND_CREATE)).toBe(false);
    expect(harness.composition.operations.registry.has(FIXTURE_COMMAND_DELETE)).toBe(false);
    expect(harness.composition.operations.registry.has(FIXTURE_QUERY_SEARCH)).toBe(false);
    expect(harness.composition.registry.hasOwner(FIXTURE_PLUGIN_ID)).toBe(false);
    expect(harness.composition.listUiContributions()).toEqual([]);

    await harness.composition.events.publishAfterCommit(
      {
        eventId: globalThis.crypto.randomUUID(),
        type: FIXTURE_EVENT_CREATED,
        contractVersion: 1,
        source: FIXTURE_PLUGIN_ID,
        occurredAt: new Date().toISOString(),
        resource: String(created.resource),
        resourceVersion: 1,
        payload: { itemId: String(created.id), title: "После stop" },
      },
      { traceId: "trace-after-stop" },
    );

    expect(await auditDocuments(harness)).toHaveLength(1);
    expect(
      await harness.provider.documents.get(FIXTURE_PLUGIN_ID, "items", String(created.id)),
    ).not.toBeNull();
  });

  it("применяет миграцию ровно один раз на чистой базе и переживает повторный старт", async () => {
    const dataDirectory = temporaryDirectory("kanbaner-kan008-migration-");
    directories.push(dataDirectory);

    const first = track(await startFixtureHarness({ dataDirectory, removeOnClose: false }));
    const created = await createItem(first, "Живёт после рестарта");

    await first.stop();

    expect(
      (await first.provider.migrations.list("sqlite")).filter(
        (migration) => migration.pluginId === FIXTURE_PLUGIN_ID,
      ),
    ).toHaveLength(1);

    await first.close();

    const second = track(await startFixtureHarness({ dataDirectory, removeOnClose: false }));

    expect(
      (await second.provider.migrations.list("sqlite")).filter(
        (migration) => migration.pluginId === FIXTURE_PLUGIN_ID,
      ),
    ).toHaveLength(1);
    expect(itemsOf(await execute(second, FIXTURE_QUERY_LIST, {}))[0]?.id).toBe(created.id);
  });

  it("не дублирует audit при повторной доставке через новый EventBus и runtime", async () => {
    const dataDirectory = temporaryDirectory("kanbaner-kan008-idempotent-");
    directories.push(dataDirectory);

    const first = track(await startFixtureHarness({ dataDirectory, removeOnClose: false }));
    const created = await createItem(first, "Идемпотентность");

    expect(await auditDocuments(first)).toHaveLength(1);
    await first.stop();
    await first.close();

    const second = track(await startFixtureHarness({ dataDirectory, removeOnClose: false }));

    const replay = await second.composition.events.publishAfterCommit(
      {
        eventId: String(created.eventId),
        type: FIXTURE_EVENT_CREATED,
        contractVersion: 1,
        source: FIXTURE_PLUGIN_ID,
        occurredAt: new Date().toISOString(),
        resource: String(created.resource),
        resourceVersion: 1,
        payload: { itemId: String(created.id), title: "Идемпотентность" },
      },
      { traceId: "trace-replay" },
    );

    expect(replay.status).toBe("accepted");
    expect(await auditDocuments(second)).toHaveLength(1);
  });

  it("не содержит синхронных предположений: работает с delayed provider", async () => {
    const harness = track(
      await startFixtureHarness({
        provider: new InMemoryStorageProvider({
          backendId: `memory-delayed-${globalThis.crypto.randomUUID()}`,
          delays: { openMs: 2, healthCheckMs: 2, operationMs: 5, transactionMs: 2 },
        }),
        migrate: false,
      }),
    );

    const created = await createItem(harness, "Delayed");

    expect(created.id).toBeTruthy();
    expect(itemsOf(await execute(harness, FIXTURE_QUERY_LIST, {}))).toHaveLength(1);
    expect(hitsOf(await execute(harness, FIXTURE_QUERY_SEARCH, { text: "Delayed" }))).toHaveLength(
      1,
    );
  });

  it("публикует событие после коммита на delayed SQLite", async () => {
    const dataDirectory = temporaryDirectory("kanbaner-kan008-delayed-sqlite-");
    directories.push(dataDirectory);

    const provider = new SqliteStorageProvider({
      backendId: `sqlite-delayed-${globalThis.crypto.randomUUID()}`,
      dataDirectory,
      delays: { openMs: 2, healthCheckMs: 2, operationMs: 5, transactionMs: 2 },
    });

    const harness = track(await startFixtureHarness({ provider }));

    const observed: { document: PluginDocument | null } = { document: null };

    harness.composition.events.subscribe(
      FIXTURE_EVENT_CREATED,
      async (envelope) => {
        observed.document = await harness.provider.documents.get(
          FIXTURE_PLUGIN_ID,
          "items",
          String((envelope.payload as { itemId: string }).itemId),
        );
      },
      { pluginId: "kanbaner.contract-test" },
    );

    const created = await createItem(harness, "SQLite после коммита");

    expect(observed.document?.id).toBe(created.id);
  });

  it("не публикует событие при откате записи", async () => {
    const provider = failingPutProvider(
      new InMemoryStorageProvider({
        backendId: `memory-failing-${globalThis.crypto.randomUUID()}`,
      }),
    );
    const harness = track(await startFixtureHarness({ provider, migrate: false }));
    let events = 0;

    harness.composition.events.subscribe(
      FIXTURE_EVENT_CREATED,
      () => {
        events += 1;
      },
      { pluginId: "kanbaner.contract-test" },
    );

    const result = await execute(harness, FIXTURE_COMMAND_CREATE, { title: "Не запишется" });

    expect(result.ok).toBe(false);
    expect(events).toBe(0);
    expect(await harness.provider.documents.list(FIXTURE_PLUGIN_ID, "items")).toEqual([]);
  });

  it("ошибка best-effort публикации не маскирует успешную команду", async () => {
    const harness = track(await startFixtureHarness());
    const events = harness.composition.events as unknown as {
      publishAfterCommit: () => Promise<never>;
    };

    events.publishAfterCommit = async () => {
      throw new Error("event bus unavailable");
    };

    const created = await createItem(harness, "Коммит важнее события");

    expect(created.id).toBeTruthy();
    expect(itemsOf(await execute(harness, FIXTURE_QUERY_LIST, {}))).toHaveLength(1);
  });

  it("не выдаёт плагину raw storage, lifecycle и чужой поиск", async () => {
    const root = temporaryDirectory("kanbaner-kan008-guard-");
    directories.push(root);
    writeGuardPlugin(root);

    const harness = track(
      await startFixtureHarness({
        provider: new InMemoryStorageProvider({
          backendId: `memory-guard-${globalThis.crypto.randomUUID()}`,
        }),
        migrate: false,
        pluginDirectories: [root],
      }),
    );

    const result = dataOf(await execute(harness, "guard.probe.check", {}));

    expect(result).toMatchObject({
      hasOpen: "undefined",
      hasClose: "undefined",
      hasMigrations: false,
      hasLinks: false,
      hasCreateStore: "undefined",
      hasOwnDocuments: "function",
      eventsSubscribe: "undefined",
    });
    expect(result.errors).toEqual(Array(8).fill("PERMISSION_DENIED"));
    expect(await harness.provider.documents.get("guard.probe", "items", "allowed")).not.toBeNull();
  });
});
