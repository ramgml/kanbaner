// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStorageProvider } from "@kanbaner/kernel";
import type { OperationResult, PluginDocument } from "@kanbaner/plugin-sdk";

import {
  FIXTURE_AUDIT_COLLECTION,
  FIXTURE_COMMAND_CREATE,
  FIXTURE_EVENT_CREATED,
  FIXTURE_ITEM_TYPE,
  FIXTURE_PLUGIN_ID,
  FIXTURE_QUERY_LIST,
} from "../../packages/plugin-fixture/src/index.ts";
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

async function createItem(
  harness: FixtureHarness,
  title: string,
): Promise<Record<string, unknown>> {
  const result = await harness.composition.executeUiOperation(FIXTURE_COMMAND_CREATE, {
    title,
  });

  return dataOf(result);
}

describe("fixture plugin: публичный lifecycle и общие шины", () => {
  it("активируется, регистрирует команду, запрос, ресурс, событие и UI", async () => {
    const harness = await startFixtureHarness();
    harnesses.push(harness);

    const fixture = harness.snapshot.plugins.find(
      (plugin) => plugin.pluginId === FIXTURE_PLUGIN_ID,
    );

    expect(fixture?.status).toBe("active");
    expect(harness.composition.operations.registry.has(FIXTURE_COMMAND_CREATE)).toBe(true);
    expect(harness.composition.operations.registry.has(FIXTURE_QUERY_LIST)).toBe(true);
    expect(harness.composition.registry.owns(FIXTURE_PLUGIN_ID, FIXTURE_ITEM_TYPE)).toBe(true);
    expect(
      harness.composition.listUiContributions().map((record) => record.contribution.slot),
    ).toEqual(["app.main", "app.main"]);
  });

  it("выполняет команду и запрос через общий OperationBus", async () => {
    const harness = await startFixtureHarness();
    harnesses.push(harness);

    const created = await createItem(harness, "Контрактная запись");
    const query = await harness.composition.executeUiOperation(FIXTURE_QUERY_LIST, {});

    expect(itemsOf(query)).toEqual([
      expect.objectContaining({
        id: created.id,
        title: "Контрактная запись",
      }),
    ]);
  });

  it("публикует событие только после коммита и не создаёт дубль audit-записи", async () => {
    const harness = await startFixtureHarness();
    harnesses.push(harness);

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

    const audits = await harness.provider.documents.list(
      FIXTURE_PLUGIN_ID,
      FIXTURE_AUDIT_COLLECTION,
    );

    expect(audits).toHaveLength(1);

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
    expect(
      await harness.provider.documents.list(FIXTURE_PLUGIN_ID, FIXTURE_AUDIT_COLLECTION),
    ).toHaveLength(1);
  });

  it("разрешает ResourceRef через публичный ResourceService", async () => {
    const harness = await startFixtureHarness();
    harnesses.push(harness);

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

  it("очищает связи удалённого ресурса по событию", async () => {
    const harness = await startFixtureHarness();
    harnesses.push(harness);

    const first = await createItem(harness, "Первый");
    const second = await createItem(harness, "Второй");
    const relation = "kanbaner.fixture.references";

    await harness.composition.resources.link(
      String(first.resource),
      String(second.resource),
      relation,
    );

    expect(await harness.composition.resources.list(String(first.resource))).toHaveLength(1);

    const publish = await harness.composition.events.publishAfterCommit(
      {
        eventId: globalThis.crypto.randomUUID(),
        type: "kanbaner.fixture.item.deleted",
        contractVersion: 1,
        source: FIXTURE_PLUGIN_ID,
        occurredAt: new Date().toISOString(),
        resource: String(first.resource),
        resourceVersion: 2,
        payload: {},
      },
      { traceId: "trace-delete" },
    );

    expect(publish.status).toBe("accepted");
    expect(await harness.composition.resources.list(String(first.resource))).toEqual([]);
    expect(await harness.composition.resources.list(String(second.resource))).toEqual([]);
  });

  it("снимает регистрации при stop и сохраняет данные", async () => {
    const harness = await startFixtureHarness();
    harnesses.push(harness);

    const created = await createItem(harness, "Сохраняется");
    await harness.stop();

    expect(harness.composition.operations.registry.has(FIXTURE_COMMAND_CREATE)).toBe(false);
    expect(harness.composition.operations.registry.has(FIXTURE_QUERY_LIST)).toBe(false);
    expect(harness.composition.registry.hasOwner(FIXTURE_PLUGIN_ID)).toBe(false);
    expect(harness.composition.listUiContributions()).toEqual([]);

    const document = await harness.provider.documents.get(
      FIXTURE_PLUGIN_ID,
      "items",
      String(created.id),
    );

    expect(document).not.toBeNull();
  });

  it("применяет миграцию ровно один раз на чистой базе и переживает повторный старт", async () => {
    const dataDirectory = temporaryDirectory("kanbaner-kan008-migration-");
    directories.push(dataDirectory);

    const first = await startFixtureHarness({
      dataDirectory,
      removeOnClose: false,
    });

    const created = await createItem(first, "Живёт после рестарта");

    await first.stop();
    const journalAfterFirst = (await first.provider.migrations.list("sqlite")).filter(
      (migration) => migration.pluginId === FIXTURE_PLUGIN_ID,
    );

    expect(journalAfterFirst).toHaveLength(1);
    await first.close();

    const second = await startFixtureHarness({
      dataDirectory,
      removeOnClose: false,
    });

    try {
      const journalAfterSecond = (await second.provider.migrations.list("sqlite")).filter(
        (migration) => migration.pluginId === FIXTURE_PLUGIN_ID,
      );

      expect(journalAfterSecond).toHaveLength(1);

      const query = await second.composition.executeUiOperation(FIXTURE_QUERY_LIST, {});

      expect(itemsOf(query)[0]?.id).toBe(created.id);
    } finally {
      await second.close();
    }
  });

  it("не содержит синхронных предположений: работает с delayed provider", async () => {
    const harness = await startFixtureHarness({
      provider: new InMemoryStorageProvider({
        backendId: `memory-delayed-${globalThis.crypto.randomUUID()}`,
        delays: { openMs: 2, healthCheckMs: 2, operationMs: 5, transactionMs: 2 },
      }),
      migrate: false,
    });

    harnesses.push(harness);

    const created = await createItem(harness, "Delayed");
    const query = await harness.composition.executeUiOperation(FIXTURE_QUERY_LIST, {});

    expect(created.id).toBeTruthy();
    expect(itemsOf(query)).toHaveLength(1);
  });
});
