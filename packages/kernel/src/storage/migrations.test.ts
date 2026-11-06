import { describe, expect, it } from "vitest";

import type { PluginMigrationContext } from "../lifecycle/hooks.ts";
import type { StorageMigration } from "./contracts.ts";
import { InMemoryStorageProvider } from "./in-memory-provider.ts";
import {
  StorageMigrationRunner,
  computeMigrationChecksum,
  createPluginMigrationHook,
  type PluginMigrationLoader,
} from "./migrations.ts";

const NOW = () => new Date("2026-11-06T12:00:00.000Z");
const PLUGIN = "acme.widgets";
const DOC_ID = "01JDOC00000000000000000001";

function provider(backendId = "memory-migrations"): InMemoryStorageProvider {
  return new InMemoryStorageProvider({ backendId, now: NOW });
}

async function expectCode(work: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(code);

    return;
  }

  throw new Error(`Ожидалась ошибка ${code}`);
}

function migration(
  version: number,
  source = `migration ${version}`,
  up: StorageMigration["up"] = async () => undefined,
  pluginId = PLUGIN,
): StorageMigration {
  return {
    pluginId,
    version,
    name: `m${version}`,
    source,
    up,
  };
}

describe("StorageMigrationRunner", () => {
  it("вычисляет детерминированный SHA-256 checksum", () => {
    const first = computeMigrationChecksum(migration(1, "same"));
    const second = computeMigrationChecksum(migration(1, "same"));
    const changed = computeMigrationChecksum(migration(1, "changed"));

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("применяет миграции в детерминированном порядке ровно один раз", async () => {
    const memory = provider();
    const order: string[] = [];
    const runner = new StorageMigrationRunner(memory, { now: NOW });

    await memory.open();

    try {
      const migrations: readonly StorageMigration[] = [
        migration(2, "second", async () => {
          order.push("second");
        }),
        migration(1, "first", async () => {
          order.push("first");
        }),
      ];

      const firstRun = await runner.run(migrations);

      expect(order).toEqual(["first", "second"]);
      expect(firstRun.applied.map((entry) => entry.version)).toEqual([1, 2]);
      expect(firstRun.applied[0]?.appliedAt).toBe("2026-11-06T12:00:00.000Z");
      expect(firstRun.skipped).toHaveLength(0);

      const secondRun = await runner.run(migrations);

      expect(order).toEqual(["first", "second"]);
      expect(secondRun.applied).toHaveLength(0);
      expect(secondRun.skipped.map((entry) => entry.version)).toEqual([1, 2]);
      expect((await memory.migrations.list(memory.backendId)).length).toBe(2);
    } finally {
      await memory.close();
    }
  });

  it("применяет миграцию один раз при конкурентном запуске", async () => {
    const memory = provider("memory-concurrent");
    const runner = new StorageMigrationRunner(memory, { now: NOW });
    let upCalls = 0;

    await memory.open();

    try {
      const migrationList = [
        migration(1, "concurrent", async () => {
          upCalls += 1;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 2);
          });
        }),
      ];

      const [first, second] = await Promise.all([
        runner.run(migrationList),
        runner.run(migrationList),
      ]);

      expect(upCalls).toBe(1);
      expect(first.applied.length + second.applied.length).toBe(1);
      expect(first.skipped.length + second.skipped.length).toBe(1);
      expect((await memory.migrations.list(memory.backendId)).length).toBe(1);
    } finally {
      await memory.close();
    }
  });

  it("блокирует несовпадение checksum", async () => {
    const memory = provider();
    const runner = new StorageMigrationRunner(memory);

    await memory.open();

    try {
      await runner.run([migration(1, "version A")]);

      await expectCode(runner.run([migration(1, "version B")]), "MIGRATION_CHECKSUM_MISMATCH");

      expect((await memory.migrations.list(memory.backendId)).length).toBe(1);
    } finally {
      await memory.close();
    }
  });

  it("откатывает изменения и журнал при ошибке миграции", async () => {
    const memory = provider();
    const runner = new StorageMigrationRunner(memory);

    await memory.open();

    try {
      await expectCode(
        runner.run([
          migration(1, "failing", async ({ transaction }) => {
            await transaction.documents.put({
              pluginId: PLUGIN,
              collection: "widgets",
              id: DOC_ID,
              data: { title: "partial" },
              expectedVersion: 0,
            });
            throw new Error("migration failed");
          }),
        ]),
        "MIGRATION_FAILED",
      );

      expect(await memory.documents.get(PLUGIN, "widgets", DOC_ID)).toBeNull();
      expect(await memory.migrations.list(memory.backendId)).toEqual([]);
    } finally {
      await memory.close();
    }
  });

  it("изолирует историю миграций по backendId", async () => {
    const first = provider("memory-backend-a");
    const second = provider("memory-backend-b");
    const firstRunner = new StorageMigrationRunner(first);
    const secondRunner = new StorageMigrationRunner(second);

    await first.open();
    await second.open();

    try {
      const applied = await firstRunner.run([migration(1, "backend scoped")]);

      expect(applied.backendId).toBe("memory-backend-a");
      expect((await first.migrations.list("memory-backend-a")).length).toBe(1);
      expect(await first.migrations.find("memory-backend-b", PLUGIN, 1)).toBeNull();
      expect(await second.migrations.list("memory-backend-a")).toEqual([]);

      await secondRunner.run([migration(1, "backend scoped")]);
      expect((await second.migrations.list("memory-backend-b")).length).toBe(1);
      expect((await first.migrations.list("memory-backend-a")).length).toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("не создаёт namespace для неверного Plugin ID", async () => {
    const memory = provider();
    const runner = new StorageMigrationRunner(memory);

    await memory.open();

    try {
      await expectCode(
        runner.run([migration(1, "bad", async () => undefined, "Invalid:Plugin")]),
        "INVALID_PLUGIN_ID",
      );

      expect(await memory.migrations.list()).toEqual([]);
      expect(await memory.pluginStates.list()).toEqual([]);
    } finally {
      await memory.close();
    }
  });

  it("отклоняет повтор версии и пустое содержимое до записи", async () => {
    const memory = provider();
    const runner = new StorageMigrationRunner(memory);

    await memory.open();

    try {
      await expectCode(runner.run([migration(1), migration(1, "duplicate")]), "INVALID_MIGRATION");
      await expectCode(runner.run([migration(1, "")]), "INVALID_MIGRATION");

      expect(await memory.migrations.list()).toEqual([]);
    } finally {
      await memory.close();
    }
  });

  it("требует открытый и здоровый провайдер", async () => {
    const memory = provider();
    const runner = new StorageMigrationRunner(memory);

    await expectCode(runner.run([migration(1)]), "PROVIDER_NOT_READY");
    await memory.close();
  });

  it("адаптер lifecycle hook применяет миграции плагина", async () => {
    const memory = provider();
    const runner = new StorageMigrationRunner(memory);
    let loadCalls = 0;
    const loader: PluginMigrationLoader = {
      async load() {
        loadCalls += 1;

        return [migration(1, "hook")];
      },
    };
    const hook = createPluginMigrationHook(runner, loader);
    const context = {
      pluginId: PLUGIN,
      migrationsPath: "/plugins/acme/migrations",
    } as unknown as PluginMigrationContext;

    await memory.open();

    try {
      await hook(context);

      expect(loadCalls).toBe(1);
      expect((await memory.migrations.list(memory.backendId)).length).toBe(1);

      await hook({
        ...context,
        migrationsPath: null,
      });

      expect(loadCalls).toBe(1);
    } finally {
      await memory.close();
    }
  });

  it("адаптер lifecycle hook отклоняет миграцию чужого плагина", async () => {
    const memory = provider();
    const runner = new StorageMigrationRunner(memory);
    const hook = createPluginMigrationHook(runner, {
      async load() {
        return [migration(1, "foreign", async () => undefined, "acme.gadgets")];
      },
    });

    await memory.open();

    try {
      await expectCode(
        hook({
          pluginId: PLUGIN,
          migrationsPath: "/plugins/acme/migrations",
        } as unknown as PluginMigrationContext),
        "INVALID_MIGRATION",
      );

      expect((await memory.migrations.list()).length).toBe(0);
    } finally {
      await memory.close();
    }
  });
});
