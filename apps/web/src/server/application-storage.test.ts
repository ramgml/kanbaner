// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeMigrationChecksum } from "@kanbaner/kernel";
import type { StorageMigration } from "@kanbaner/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCoreInfrastructureMigrations,
  createSqliteStorageProvider,
} from "@kanbaner/storage-sqlite";

import {
  closeApplicationStorage,
  createApplicationStorage,
  getApplicationStorage,
  type ApplicationStorageRuntime,
} from "./application-storage";

const NOW = () => new Date("2026-11-06T12:00:00.000Z");
const PLUGIN = "acme.widgets";
const directories: string[] = [];
const runtimes: ApplicationStorageRuntime[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kanbaner-app-storage-"));
  directories.push(directory);

  return directory;
}

function pluginMigration(
  onUp: (context: Parameters<StorageMigration["up"]>[0]) => Promise<void>,
  version = 1,
): StorageMigration {
  return {
    pluginId: PLUGIN,
    version,
    name: `widgets-${version}`,
    source: `plugin migration ${version}`,
    async up(context) {
      await onUp(context);
    },
  };
}

afterEach(async () => {
  await closeApplicationStorage();

  for (const runtime of runtimes.splice(0)) {
    await runtime.registry.closeAll();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createApplicationStorage", () => {
  it("применяет инфраструктурную миграцию до миграций плагинов", async () => {
    const order: string[] = [];
    const seen: Array<{ infraBefore: boolean; pluginId: string; version: number }> = [];

    const runtime = await createApplicationStorage({
      dataDirectory: temporaryDirectory(),
      now: NOW,
      pluginMigrations: [
        pluginMigration(async ({ backendId, pluginId, version, store }) => {
          order.push("plugin");
          const infrastructure = await store.find(backendId, "kanbaner.core", 1);

          seen.push({ infraBefore: infrastructure !== null, pluginId, version });
        }),
      ],
    });

    runtimes.push(runtime);
    order.push("returned");

    expect(order).toEqual(["plugin", "returned"]);
    expect(seen).toEqual([{ infraBefore: true, pluginId: PLUGIN, version: 1 }]);
    expect(runtime.infrastructure.applied).toHaveLength(1);
    expect(runtime.infrastructure.applied[0]).toMatchObject({
      backendId: "sqlite",
      pluginId: "kanbaner.core",
      version: 1,
      name: "core-foundation",
    });
    expect(runtime.plugins.applied).toHaveLength(1);
    expect(runtime.health.ok).toBe(true);
  });

  it("фиксирует в журнале kanbaner.core с устойчивым checksum", async () => {
    const runtime = await createApplicationStorage({
      dataDirectory: temporaryDirectory(),
      now: NOW,
    });

    runtimes.push(runtime);

    const journal = await runtime.provider.migrations.list("sqlite");
    const infrastructure = journal.find(
      (migration: { readonly pluginId: string }) => migration.pluginId === "kanbaner.core",
    );
    const [infrastructureMigration] = createCoreInfrastructureMigrations();

    if (infrastructureMigration === undefined) {
      throw new Error("Ожидалась инфраструктурная миграция");
    }

    expect(journal).toHaveLength(1);
    expect(infrastructure).toMatchObject({
      backendId: "sqlite",
      pluginId: "kanbaner.core",
      version: 1,
      name: "core-foundation",
      appliedAt: "2026-11-06T12:00:00.000Z",
    });
    expect(infrastructure?.checksum).toBe(
      computeMigrationChecksum(infrastructureMigration as StorageMigration),
    );
  });

  it("повторный запуск пропускает уже применённые миграции", async () => {
    const dataDirectory = temporaryDirectory();
    const migration = pluginMigration(async () => undefined);

    const first = await createApplicationStorage({
      dataDirectory,
      now: NOW,
      pluginMigrations: [migration],
    });

    runtimes.push(first);
    await first.registry.closeAll();

    const second = await createApplicationStorage({
      dataDirectory,
      now: NOW,
      pluginMigrations: [migration],
    });

    runtimes.push(second);

    expect(second.infrastructure.applied).toEqual([]);
    expect(second.infrastructure.skipped).toHaveLength(1);
    expect(second.plugins.applied).toEqual([]);
    expect(second.plugins.skipped).toHaveLength(1);
  });

  it("закрывает provider и откатывает миграцию при ошибке плагина", async () => {
    const dataDirectory = temporaryDirectory();
    const provider = createSqliteStorageProvider({ dataDirectory, now: NOW });
    const failing = pluginMigration(async ({ store, backendId }) => {
      await store.record({
        backendId,
        pluginId: PLUGIN,
        version: 1,
        name: "widgets-1",
        checksum: "a".repeat(64),
        appliedAt: "2026-11-06T12:00:00.000Z",
      });
      throw new Error("plugin migration failed");
    });

    await expect(
      createApplicationStorage({
        dataDirectory,
        now: NOW,
        provider,
        pluginMigrations: [failing],
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    expect((await provider.healthCheck()).ok).toBe(false);
    await expect(provider.documents.list(PLUGIN)).rejects.toMatchObject({
      code: "PROVIDER_CLOSED",
    });

    const reopened = createSqliteStorageProvider({ dataDirectory, now: NOW });

    try {
      await reopened.open();

      const journal = await reopened.migrations.list("sqlite");

      expect(journal.map((migration) => migration.pluginId)).toEqual(["kanbaner.core"]);
    } finally {
      await reopened.close();
    }
  });

  it("не запускает миграции, если health после открытия неуспешен", async () => {
    const dataDirectory = temporaryDirectory();
    const provider = createSqliteStorageProvider({ dataDirectory, now: NOW });

    provider.healthCheck = async () => ({
      ok: false,
      backendId: provider.backendId,
      checkedAt: "2026-11-06T12:00:00.000Z",
    });

    await expect(
      createApplicationStorage({
        dataDirectory,
        now: NOW,
        provider,
        pluginMigrations: [pluginMigration(async () => undefined)],
      }),
    ).rejects.toMatchObject({ code: "HEALTH_CHECK_FAILED" });

    expect((await provider.healthCheck()).ok).toBe(false);
  });
});

describe("getApplicationStorage", () => {
  it("возвращает один runtime для одного каталога данных", async () => {
    const dataDirectory = temporaryDirectory();
    const first = getApplicationStorage({ dataDirectory, now: NOW });
    const second = getApplicationStorage({ dataDirectory, now: NOW });

    expect(second).toBe(first);

    const runtime = await first;

    runtimes.push(runtime);
    expect(runtime.health.ok).toBe(true);
    expect(runtime.health.details).toMatchObject({ wal: true });
  });

  it("отклоняет другой каталог при уже созданном singleton-е", async () => {
    const runtime = await getApplicationStorage({
      dataDirectory: temporaryDirectory(),
      now: NOW,
    });

    runtimes.push(runtime);

    await expect(
      getApplicationStorage({ dataDirectory: temporaryDirectory(), now: NOW }),
    ).rejects.toThrow("другим каталогом данных");
  });

  it("закрывает runtime и позволяет создать новый после close", async () => {
    const dataDirectory = temporaryDirectory();
    const runtime = await getApplicationStorage({ dataDirectory, now: NOW });

    await closeApplicationStorage();

    expect((await runtime.provider.healthCheck()).ok).toBe(false);

    const recreated = await getApplicationStorage({ dataDirectory, now: NOW });

    runtimes.push(recreated);
    expect(recreated).not.toBe(runtime);
    expect(recreated.health.ok).toBe(true);
  });

  it("сбрасывает singleton после ошибки миграции и повторяет попытку", async () => {
    const dataDirectory = temporaryDirectory();
    const failing = pluginMigration(async () => {
      throw new Error("first attempt fails");
    });

    await expect(
      getApplicationStorage({ dataDirectory, now: NOW, pluginMigrations: [failing] }),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    const runtime = await getApplicationStorage({ dataDirectory, now: NOW });

    runtimes.push(runtime);
    expect(runtime.health.ok).toBe(true);
    expect(await runtime.provider.migrations.list("sqlite")).toHaveLength(1);
  });
});
