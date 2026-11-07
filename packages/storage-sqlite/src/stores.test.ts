// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StorageMigrationRunner, computeMigrationChecksum } from "@kanbaner/kernel";
import type { StorageMigration } from "@kanbaner/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createCoreInfrastructureMigrations } from "./infrastructure-migrations.ts";
import {
  buildSearchExcerpt,
  normalizeSearchQuery,
  normalizeSearchText,
  tokenizeSearchText,
} from "./normalizer.ts";
import { createSqliteStorageProvider, type SqliteStorageProvider } from "./provider.ts";

const PLUGIN = "acme.widgets";
const OTHER_PLUGIN = "acme.gadgets";
const COLLECTION = "widgets";
const OTHER_COLLECTION = "gadgets";
const SOURCE = "acme.widgets:widget:01JWIDGET0000000000000001";
const TARGET = "acme.gadgets:gadget:01JGADGET0000000000000001";
const OTHER = "acme.gadgets:gadget:01JGADGET0000000000000002";
const RELATION = "acme.links.relates";
const OTHER_RELATION = "acme.links.mentions";

const directories: string[] = [];
const providers: SqliteStorageProvider[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kanbaner-sqlite-stores-"));
  directories.push(directory);

  return directory;
}

async function createProvider(
  options: Parameters<typeof createSqliteStorageProvider>[0] = {},
): Promise<SqliteStorageProvider> {
  const provider = createSqliteStorageProvider({
    dataDirectory: temporaryDirectory(),
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    ...options,
  });

  providers.push(provider);
  await provider.open();

  return provider;
}

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    try {
      await provider.close();
    } catch {
      // Тест мог уже закрыть provider.
    }
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function documentInput(id: string, expectedVersion?: number) {
  return {
    pluginId: PLUGIN,
    collection: COLLECTION,
    id,
    data: { title: `Widget ${id}` },
    indexedFields: { status: "open" },
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

describe("PluginDocumentStore: версии и CAS", () => {
  it("создаёт, конфликтует и обновляет документ по expectedVersion", async () => {
    const provider = await createProvider();

    const created = await provider.documents.put(documentInput("01JDOC00000000000000000001", 0));

    expect(created.version).toBe(1);

    await expect(
      provider.documents.put(documentInput("01JDOC00000000000000000001", 0)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    await expect(
      provider.documents.put(documentInput("01JDOC00000000000000000001", 2)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const updated = await provider.documents.put(documentInput("01JDOC00000000000000000001", 1));

    expect(updated.version).toBe(2);
    expect(updated.data).toEqual({ title: "Widget 01JDOC00000000000000000001" });
  });

  it("требует expectedVersion для обновления существующего документа", async () => {
    const provider = await createProvider();
    const input = documentInput("01JDOC00000000000000000002", 0);

    await provider.documents.put(input);

    await expect(
      provider.documents.put(documentInput("01JDOC00000000000000000002")),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("отклоняет создание с ненулевым expectedVersion и не создаёт документ", async () => {
    const provider = await createProvider();

    await expect(
      provider.documents.put(documentInput("01JDOC00000000000000000003", 5)),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    expect(
      await provider.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000003"),
    ).toBeNull();
  });

  it("удаляет документ с проверкой версии и не считает отсутствие ошибкой", async () => {
    const provider = await createProvider();
    const id = "01JDOC00000000000000000004";

    await provider.documents.put(documentInput(id, 0));

    await expect(
      provider.documents.delete(PLUGIN, COLLECTION, id, { expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    expect(await provider.documents.delete(PLUGIN, COLLECTION, id, { expectedVersion: 1 })).toBe(
      true,
    );
    expect(await provider.documents.delete(PLUGIN, COLLECTION, id)).toBe(false);
    expect(await provider.documents.get(PLUGIN, COLLECTION, id)).toBeNull();
  });

  it("изолирует копии JSON на границе Store", async () => {
    const provider = await createProvider();
    const input = {
      ...documentInput("01JDOC00000000000000000005", 0),
      data: { title: "Original", nested: { value: 1 } },
    };

    const created = await provider.documents.put(input);

    input.data.nested.value = 2;

    const stored = await provider.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000005");

    expect(stored?.data).toEqual({ title: "Original", nested: { value: 1 } });
    expect(created).not.toBe(stored);
  });
});

describe("PluginDocumentStore: query/list", () => {
  it("фильтрует по collection, ids и indexedFields, сортирует и пагинирует", async () => {
    const provider = await createProvider();

    await provider.documents.put({
      pluginId: PLUGIN,
      collection: COLLECTION,
      id: "01JDOC00000000000000000011",
      data: { title: "B" },
      indexedFields: { status: "open" },
      expectedVersion: 0,
    });
    await provider.documents.put({
      pluginId: PLUGIN,
      collection: COLLECTION,
      id: "01JDOC00000000000000000012",
      data: { title: "A" },
      indexedFields: { status: "closed" },
      expectedVersion: 0,
    });
    await provider.documents.put({
      pluginId: PLUGIN,
      collection: OTHER_COLLECTION,
      id: "01JDOC00000000000000000013",
      data: { title: "C" },
      indexedFields: { status: "open" },
      expectedVersion: 0,
    });
    await provider.documents.put({
      pluginId: OTHER_PLUGIN,
      collection: COLLECTION,
      id: "01JDOC00000000000000000014",
      data: { title: "D" },
      indexedFields: { status: "open" },
      expectedVersion: 0,
    });

    const all = await provider.documents.list(PLUGIN);

    expect(all.map((document) => document.id)).toEqual([
      "01JDOC00000000000000000013",
      "01JDOC00000000000000000011",
      "01JDOC00000000000000000012",
    ]);

    const byCollection = await provider.documents.list(PLUGIN, COLLECTION);

    expect(byCollection.map((document) => document.id)).toEqual([
      "01JDOC00000000000000000011",
      "01JDOC00000000000000000012",
    ]);

    const open = await provider.documents.query({
      pluginId: PLUGIN,
      indexedFields: { status: "open" },
    });

    expect(open.map((document) => document.id)).toEqual([
      "01JDOC00000000000000000011",
      "01JDOC00000000000000000013",
    ]);

    const descending = await provider.documents.query({
      pluginId: PLUGIN,
      collection: COLLECTION,
      sort: { field: "id", direction: "desc" },
      limit: 1,
      offset: 0,
    });

    expect(descending.map((document) => document.id)).toEqual(["01JDOC00000000000000000012"]);

    const byIds = await provider.documents.query({
      pluginId: PLUGIN,
      ids: ["01JDOC00000000000000000012", "01JDOC00000000000000000013"],
    });

    expect(byIds.map((document) => document.id)).toEqual([
      "01JDOC00000000000000000012",
      "01JDOC00000000000000000013",
    ]);

    expect(await provider.documents.query({ pluginId: PLUGIN, ids: [] })).toEqual([]);
  });

  it("отклоняет некорректные pluginId, collection, id и лимит", async () => {
    const provider = await createProvider();

    await expect(provider.documents.list("Invalid:Plugin")).rejects.toMatchObject({
      code: "INVALID_PLUGIN_ID",
    });
    await expect(provider.documents.list(PLUGIN, "Invalid Collection")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(provider.documents.get(PLUGIN, COLLECTION, " ")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(provider.documents.query({ pluginId: PLUGIN, limit: 1001 })).rejects.toMatchObject(
      { code: "INVALID_ARGUMENT" },
    );
  });
});

describe("LinkStore: универсальные связи", () => {
  it("вставляет связь атомарно и идемпотентно", async () => {
    const provider = await createProvider();

    const first = await provider.links.add({
      sourceRef: SOURCE,
      targetRef: TARGET,
      relation: RELATION,
    });
    const second = await provider.links.add({
      sourceRef: SOURCE,
      targetRef: TARGET,
      relation: RELATION,
      createdAt: "2027-01-01T00:00:00.000Z",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.link.createdAt).toBe(first.link.createdAt);
  });

  it("находит связи с обеих сторон и фильтрует relation", async () => {
    const provider = await createProvider();

    await provider.links.add({ sourceRef: SOURCE, targetRef: TARGET, relation: RELATION });
    await provider.links.add({ sourceRef: OTHER, targetRef: SOURCE, relation: OTHER_RELATION });
    await provider.links.add({ sourceRef: SOURCE, targetRef: OTHER, relation: RELATION });

    const all = await provider.links.listByRef(SOURCE);

    expect(all).toHaveLength(3);
    expect((await provider.links.listByRef(SOURCE, RELATION)).map((link) => link.relation)).toEqual(
      [RELATION, RELATION],
    );
    expect(await provider.links.listByRef(TARGET)).toHaveLength(1);
  });

  it("идемпотентно удаляет связь и удаляет все связи ref", async () => {
    const provider = await createProvider();

    await provider.links.add({ sourceRef: SOURCE, targetRef: TARGET, relation: RELATION });
    await provider.links.add({ sourceRef: OTHER, targetRef: SOURCE, relation: OTHER_RELATION });

    expect(await provider.links.remove(SOURCE, TARGET, RELATION)).toBe(true);
    expect(await provider.links.remove(SOURCE, TARGET, RELATION)).toBe(false);
    expect(await provider.links.deleteByRef(SOURCE)).toBe(1);
    expect(await provider.links.listByRef(SOURCE)).toEqual([]);
  });

  it("отклоняет некорректный ResourceRef и relation", async () => {
    const provider = await createProvider();

    await expect(
      provider.links.add({ sourceRef: "invalid", targetRef: TARGET, relation: RELATION }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      provider.links.add({ sourceRef: SOURCE, targetRef: TARGET, relation: "single" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("PluginStateStore: версия, enabled и состояние", () => {
  it("создаёт и обновляет запись плагина", async () => {
    let now = new Date("2026-11-06T12:00:00.000Z");
    const provider = await createProvider({ now: () => now });

    const created = await provider.pluginStates.put({
      pluginId: PLUGIN,
      version: "1.0.0",
      enabled: true,
      state: { theme: "light" },
    });

    expect(created).toMatchObject({ pluginId: PLUGIN, version: "1.0.0", enabled: true });
    expect(created.updatedAt).toBe("2026-11-06T12:00:00.000Z");

    now = new Date("2026-11-06T13:00:00.000Z");

    const updated = await provider.pluginStates.put({
      pluginId: PLUGIN,
      version: "2.0.0",
      enabled: false,
      state: { theme: "dark" },
    });

    expect(updated).toMatchObject({ version: "2.0.0", enabled: false, state: { theme: "dark" } });
    expect(updated.updatedAt).toBe("2026-11-06T13:00:00.000Z");
    expect((await provider.pluginStates.get(PLUGIN))?.state).toEqual({ theme: "dark" });
  });

  it("перечисляет записи по возрастанию pluginId и удаляет явно", async () => {
    const provider = await createProvider();

    await provider.pluginStates.put({
      pluginId: OTHER_PLUGIN,
      version: "1.0.0",
      enabled: true,
      state: {},
    });
    await provider.pluginStates.put({
      pluginId: PLUGIN,
      version: "1.0.0",
      enabled: true,
      state: {},
    });

    expect((await provider.pluginStates.list()).map((record) => record.pluginId)).toEqual([
      OTHER_PLUGIN,
      PLUGIN,
    ]);
    expect(await provider.pluginStates.delete(PLUGIN)).toBe(true);
    expect(await provider.pluginStates.delete(PLUGIN)).toBe(false);
    expect(await provider.pluginStates.get(PLUGIN)).toBeNull();
  });

  it("не удаляет документы при удалении состояния плагина", async () => {
    const provider = await createProvider();

    await provider.documents.put(documentInput("01JDOC00000000000000000021", 0));
    await provider.pluginStates.put({
      pluginId: PLUGIN,
      version: "1.0.0",
      enabled: true,
      state: {},
    });
    await provider.pluginStates.delete(PLUGIN);

    expect(await provider.documents.list(PLUGIN, COLLECTION)).toHaveLength(1);
  });

  it("отклоняет невалидную версию плагина", async () => {
    const provider = await createProvider();

    await expect(
      provider.pluginStates.put({
        pluginId: PLUGIN,
        version: "1.0",
        enabled: true,
        state: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("MigrationStore: журнал и checksum", () => {
  const checksumA = "a".repeat(64);
  const checksumB = "b".repeat(64);

  function appliedMigration(checksum = checksumA) {
    return {
      backendId: "sqlite",
      pluginId: PLUGIN,
      version: 1,
      name: "init",
      checksum,
      appliedAt: "2026-11-06T12:00:00.000Z",
    };
  }

  it("записывает миграцию и читает её из журнала", async () => {
    const provider = await createProvider();

    await provider.migrations.record(appliedMigration());

    const found = await provider.migrations.find("sqlite", PLUGIN, 1);

    expect(found).toMatchObject({ name: "init", checksum: checksumA, version: 1 });
    expect(await provider.migrations.list()).toHaveLength(1);
    expect(await provider.migrations.list("other")).toEqual([]);
    expect(await provider.migrations.find("sqlite", PLUGIN, 2)).toBeNull();
  });

  it("идемпотентна при совпадающем checksum и отклоняет изменение", async () => {
    const provider = await createProvider();

    await provider.migrations.record(appliedMigration());
    await provider.migrations.record(appliedMigration());

    expect(await provider.migrations.list()).toHaveLength(1);

    await expect(provider.migrations.record(appliedMigration(checksumB))).rejects.toMatchObject({
      code: "MIGRATION_CHECKSUM_MISMATCH",
    });
  });

  it("отклоняет некорректный checksum до записи", async () => {
    const provider = await createProvider();

    await expect(
      provider.migrations.record(appliedMigration("not-a-checksum")),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await provider.migrations.list()).toEqual([]);
  });

  it("применяет инфраструктурную миграцию один раз через общий runner", async () => {
    const provider = await createProvider();
    const migrations = createCoreInfrastructureMigrations();
    const first = await new StorageMigrationRunner(provider).run(migrations);

    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]).toMatchObject({
      backendId: "sqlite",
      pluginId: "kanbaner.core",
      version: 1,
      name: "core-foundation",
      checksum: computeMigrationChecksum(migrations[0] as StorageMigration),
    });

    const second = await new StorageMigrationRunner(provider).run(migrations);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(await provider.migrations.list("sqlite")).toHaveLength(1);
  });

  it("откатывает неудачную миграцию и не оставляет записи журнала", async () => {
    const provider = await createProvider();
    const failing: StorageMigration = {
      pluginId: PLUGIN,
      version: 1,
      name: "failing",
      source: "failure",
      async up({ store }) {
        await store.record({
          backendId: "sqlite",
          pluginId: PLUGIN,
          version: 1,
          name: "failing",
          checksum: checksumA,
          appliedAt: "2026-11-06T12:00:00.000Z",
        });
        throw new Error("migration failed");
      },
    };

    await expect(new StorageMigrationRunner(provider).run([failing])).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });
    expect(await provider.migrations.list()).toEqual([]);
  });
});

describe("SearchIndexStore: FTS5, нормализация и excerpt", () => {
  const WIDGET = "acme.widgets:widget:01JWIDGET0000000000000011";
  const GADGET = "acme.gadgets:gadget:01JGADGET0000000000000011";

  it("нормализует регистр и Unicode NFKC", () => {
    // NFKC раскладывает знак № в совместимую пару "No".
    expect(normalizeSearchText("  ВИДЖЕТ №１  ")).toBe("  виджет no1  ");
    expect(tokenizeSearchText("Привет, мир! widget-42")).toEqual(["привет", "мир", "widget", "42"]);
  });

  it("строит безопасный FTS-запрос с фразой, prefix и AND", () => {
    expect(normalizeSearchQuery("Виджет")).toEqual({ match: '"виджет"', terms: ["виджет"] });
    expect(normalizeSearchQuery('"первый виджет" задач*')).toEqual({
      match: '"первый виджет" "задач"*',
      terms: ["первый", "виджет", "задач"],
    });
    expect(normalizeSearchQuery("!!! ???")).toBeNull();
  });

  it("строит excerpt вокруг первого термина", () => {
    expect(buildSearchExcerpt("Заголовок", "Текст с виджетом внутри", ["виджет"])).toContain(
      "виджет",
    );
    expect(buildSearchExcerpt("Виджет", "x".repeat(500), ["виджет"]).length).toBeLessThan(200);
  });

  it("индексирует, ищет с фильтрами и удаляет документы", async () => {
    const provider = await createProvider();

    expect(provider.searchIndex.strategy).toBe("full-text");
    expect(
      await provider.searchIndex.upsert([
        {
          ref: WIDGET,
          pluginId: PLUGIN,
          title: "Первый виджет",
          text: "Описание виджета для канбана",
          kind: "widget",
        },
        {
          ref: GADGET,
          pluginId: OTHER_PLUGIN,
          title: "Гаджет",
          text: "Виджет упоминается в тексте гаджета",
          kind: "gadget",
        },
      ]),
    ).toBe(2);

    const byWord = await provider.searchIndex.search({ text: "виджет" });

    expect(byWord.map((hit) => hit.ref).sort()).toEqual([GADGET, WIDGET].sort());
    expect(byWord.every((hit) => hit.strategy === "full-text")).toBe(true);
    expect(byWord.every((hit) => hit.excerpt.toLowerCase().includes("виджет"))).toBe(true);

    const byPlugin = await provider.searchIndex.search({ text: "виджет", pluginId: PLUGIN });

    expect(byPlugin.map((hit) => hit.ref)).toEqual([WIDGET]);

    const byKind = await provider.searchIndex.search({ text: "виджет", kind: "gadget" });

    expect(byKind.map((hit) => hit.ref)).toEqual([GADGET]);

    const prefix = await provider.searchIndex.search({ text: "видж*" });

    expect(prefix).toHaveLength(2);

    const phrase = await provider.searchIndex.search({ text: '"первый виджет"' });

    expect(phrase.map((hit) => hit.ref)).toEqual([WIDGET]);

    const page = await provider.searchIndex.search({ text: "виджет", limit: 1, offset: 1 });

    expect(page).toHaveLength(1);
    expect(await provider.searchIndex.list()).toHaveLength(2);

    expect(await provider.searchIndex.delete(WIDGET)).toBe(true);
    expect(await provider.searchIndex.delete(WIDGET)).toBe(false);
    expect((await provider.searchIndex.search({ text: "виджет" })).map((hit) => hit.ref)).toEqual([
      GADGET,
    ]);
  });

  it("заменяет индекс через reindex и очищает по плагину", async () => {
    const provider = await createProvider();

    await provider.searchIndex.upsert([
      { ref: WIDGET, pluginId: PLUGIN, title: "Виджет", text: "старый" },
      { ref: GADGET, pluginId: OTHER_PLUGIN, title: "Гаджет", text: "старый" },
    ]);

    expect(
      await provider.searchIndex.reindex([
        { ref: WIDGET, pluginId: PLUGIN, title: "Виджет", text: "новый текст" },
      ]),
    ).toBe(1);

    expect(await provider.searchIndex.search({ text: "старый" })).toEqual([]);
    expect(await provider.searchIndex.list()).toHaveLength(1);

    await provider.searchIndex.upsert([
      { ref: GADGET, pluginId: OTHER_PLUGIN, title: "Гаджет", text: "снова" },
    ]);

    expect(await provider.searchIndex.clear(PLUGIN)).toBe(1);
    expect((await provider.searchIndex.list()).map((document) => document.ref)).toEqual([GADGET]);
    expect(await provider.searchIndex.deleteMany([GADGET, "acme.gadgets:gadget:missing"])).toBe(1);
    expect(await provider.searchIndex.list()).toEqual([]);
  });

  it("отклоняет пустой запрос и некорректный документ", async () => {
    const provider = await createProvider();

    await expect(provider.searchIndex.search({ text: "   " })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(provider.searchIndex.search({ text: "!!!" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      provider.searchIndex.upsert([{ ref: "invalid", pluginId: PLUGIN, title: "x", text: "y" }]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      provider.searchIndex.upsert([{ ref: WIDGET, pluginId: PLUGIN, title: " ", text: "y" }]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
