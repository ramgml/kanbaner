// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { computeMigrationChecksum } from "@kanbaner/kernel";
import type { PluginManifest, StorageMigration } from "@kanbaner/plugin-sdk";
import { createSqliteStorageProvider, executeSqliteMigrationSql } from "@kanbaner/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginService, type PluginServiceOptions } from "./plugin-service";
import {
  createSqlitePluginMigrationLoader,
  loadSqliteMigrationFiles,
  migratePluginWithSqlite,
} from "./sqlite-plugin-migrations";

const PLUGIN = "acme.widgets";
const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];

function temporaryDirectory(prefix = "kanbaner-plugin-migrations-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
}

function migrationsDirectory(files: Readonly<Record<string, string>>): string {
  const directory = temporaryDirectory("kanbaner-migrations-");

  for (const [fileName, source] of Object.entries(files)) {
    writeFileSync(join(directory, fileName), source, "utf8");
  }

  return directory;
}

function manifest(migrations = "migrations"): PluginManifest {
  return {
    id: PLUGIN,
    name: "Widgets",
    version: "1.0.0",
    hostApi: "^1.0.0",
    entrypoints: { server: "./server.mjs" },
    requires: {},
    consumes: [],
    provides: [],
    permissions: [],
    migrations,
  };
}

function migrationContext(migrationsPath: string | null) {
  return {
    pluginId: PLUGIN,
    manifest: manifest(),
    directory: migrationsPath ?? temporaryDirectory(),
    hostApiVersion: "1.0.0",
    manifestVersion: "1.0.0",
    migrationsPath,
  };
}

async function createOpenedProvider(): Promise<ReturnType<typeof createSqliteStorageProvider>> {
  const provider = createSqliteStorageProvider({ dataDirectory: temporaryDirectory() });

  await provider.open();

  return provider;
}

function tableNames(databasePath: string): readonly string[] {
  const database = new Database(databasePath, { readonly: true });

  try {
    return (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        readonly name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    database.close();
  }
}

function pluginFixture(): string {
  const root = temporaryDirectory("kanbaner-plugin-fixture-");
  const directory = join(root, "widgets");

  mkdirSync(directory);
  writeFileSync(
    join(directory, "plugin.json"),
    JSON.stringify(manifest("migrations"), null, 2),
    "utf8",
  );
  writeFileSync(
    join(directory, "server.mjs"),
    "export function activate() {}\nexport function deactivate() {}\n",
    "utf8",
  );
  mkdirSync(join(directory, "migrations"));
  writeFileSync(
    join(directory, "migrations", "001_init.sql"),
    "CREATE TABLE plugin_acme_widgets_items (id TEXT PRIMARY KEY, label TEXT NOT NULL);\n",
    "utf8",
  );

  return root;
}

async function createService(options: PluginServiceOptions) {
  const service = createPluginService(options);

  disposers.push(() => service.dispose());

  return service;
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    await dispose();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("детерминированный .sql loader", () => {
  it("сортирует файлы по версии независимо от порядка в каталоге", async () => {
    const directory = migrationsDirectory({
      "010_ten.sql": "SELECT 10;\n",
      "002_two.sql": "SELECT 2;\n",
      "001_one.sql": "SELECT 1;\n",
    });

    const files = await loadSqliteMigrationFiles(directory);

    expect(files.map((file) => file.version)).toEqual([1, 2, 10]);
    expect(files.map((file) => file.name)).toEqual(["one", "two", "ten"]);
  });

  it("отклоняет дубль версии и symlink", async () => {
    const duplicate = migrationsDirectory({
      "001_one.sql": "SELECT 1;\n",
      "001_other.sql": "SELECT 1;\n",
    });

    await expect(loadSqliteMigrationFiles(duplicate)).rejects.toThrow(/повторяется/u);

    const directory = migrationsDirectory({ "001_one.sql": "SELECT 1;\n" });
    const link = join(directory, "002_link.sql");

    symlinkSync(join(directory, "001_one.sql"), link);

    await expect(loadSqliteMigrationFiles(directory)).rejects.toThrow(/обычным файлом/u);
  });

  it("отклоняет пустой каталог и пустой файл", async () => {
    await expect(loadSqliteMigrationFiles(temporaryDirectory())).rejects.toThrow(
      /не содержит файлов/u,
    );

    const empty = migrationsDirectory({ "001_empty.sql": "  \n" });

    await expect(loadSqliteMigrationFiles(empty)).rejects.toThrow(/пуст/u);
  });
});

describe("migratePluginWithSqlite", () => {
  it("применяет SQL и фиксирует checksum в одной транзакции, затем пропускает повтор", async () => {
    const provider = await createOpenedProvider();
    const directory = migrationsDirectory({
      "001_init.sql":
        "CREATE TABLE plugin_acme_widgets_items (id TEXT PRIMARY KEY, label TEXT NOT NULL);\n",
    });

    try {
      const context = migrationContext(directory);

      await migratePluginWithSqlite(context, { provider });

      const journal = await provider.migrations.list("sqlite");
      const [migration] = await createSqlitePluginMigrationLoader().load(context);

      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        pluginId: PLUGIN,
        version: 1,
        name: "init",
      });
      expect(journal[0]?.checksum).toBe(computeMigrationChecksum(migration as StorageMigration));
      expect(tableNames(provider.databasePath)).toContain("plugin_acme_widgets_items");

      await migratePluginWithSqlite(context, { provider });

      expect(await provider.migrations.list("sqlite")).toHaveLength(1);
    } finally {
      await provider.close();
    }
  });

  it("откатывает DDL и журнал при ошибке внутри файла", async () => {
    const provider = await createOpenedProvider();
    const directory = migrationsDirectory({
      "001_broken.sql":
        "CREATE TABLE plugin_acme_widgets_items (id TEXT PRIMARY KEY);\n" +
        "INSERT INTO plugin_acme_widgets_missing (id) VALUES ('x');\n",
    });

    try {
      await expect(
        migratePluginWithSqlite(migrationContext(directory), { provider }),
      ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

      expect(await provider.migrations.list("sqlite")).toEqual([]);
      expect(tableNames(provider.databasePath)).not.toContain("plugin_acme_widgets_items");
    } finally {
      await provider.close();
    }
  });

  it("блокирует изменение уже применённого SQL по checksum", async () => {
    const provider = await createOpenedProvider();
    const directory = migrationsDirectory({
      "001_init.sql": "CREATE TABLE plugin_acme_widgets_items (id TEXT PRIMARY KEY);\n",
    });

    try {
      const context = migrationContext(directory);

      await migratePluginWithSqlite(context, { provider });

      writeFileSync(
        join(directory, "001_init.sql"),
        "CREATE TABLE plugin_acme_widgets_other (id TEXT PRIMARY KEY);\n",
        "utf8",
      );

      await expect(migratePluginWithSqlite(context, { provider })).rejects.toMatchObject({
        code: "MIGRATION_CHECKSUM_MISMATCH",
      });

      expect(tableNames(provider.databasePath)).toContain("plugin_acme_widgets_items");
      expect(tableNames(provider.databasePath)).not.toContain("plugin_acme_widgets_other");
    } finally {
      await provider.close();
    }
  });

  it("поддерживает статический список миграций без чтения каталога", async () => {
    const provider = await createOpenedProvider();
    const sql = "CREATE TABLE plugin_acme_widgets_static (id TEXT PRIMARY KEY);\n";
    const migration: StorageMigration = {
      pluginId: PLUGIN,
      version: 1,
      name: "static",
      source: sql,
      async up({ transaction }) {
        executeSqliteMigrationSql(transaction, sql);
      },
    };

    try {
      await migratePluginWithSqlite(migrationContext(temporaryDirectory()), {
        provider,
        load: {
          async load() {
            return [migration];
          },
        },
      });

      expect(await provider.migrations.list("sqlite")).toHaveLength(1);
      expect(tableNames(provider.databasePath)).toContain("plugin_acme_widgets_static");
    } finally {
      await provider.close();
    }
  });

  it("отклоняет COMMIT до выполнения DDL и не оставляет таблицу или журнал", async () => {
    const provider = await createOpenedProvider();
    const directory = migrationsDirectory({
      "001_commit.sql": "CREATE TABLE plugin_acme_widgets_commit (id TEXT PRIMARY KEY);\nCOMMIT;\n",
    });

    try {
      await expect(
        migratePluginWithSqlite(migrationContext(directory), { provider }),
      ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

      expect(await provider.migrations.list("sqlite")).toEqual([]);
      expect(tableNames(provider.databasePath)).not.toContain("plugin_acme_widgets_commit");
    } finally {
      await provider.close();
    }
  });

  it("отклоняет ROLLBACK до выполнения DDL и не оставляет таблицу или журнал", async () => {
    const provider = await createOpenedProvider();
    const directory = migrationsDirectory({
      "001_rollback.sql":
        "CREATE TABLE plugin_acme_widgets_rollback (id TEXT PRIMARY KEY);\nROLLBACK;\n",
    });

    try {
      await expect(
        migratePluginWithSqlite(migrationContext(directory), { provider }),
      ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

      expect(await provider.migrations.list("sqlite")).toEqual([]);
      expect(tableNames(provider.databasePath)).not.toContain("plugin_acme_widgets_rollback");
    } finally {
      await provider.close();
    }
  });

  it("допускает COMMIT/ROLLBACK в комментариях, строках и quoted identifiers", async () => {
    const provider = await createOpenedProvider();
    const directory = migrationsDirectory({
      "001_safe.sql": `
        -- COMMIT; ROLLBACK;
        CREATE TABLE plugin_acme_widgets_safe (
          id TEXT PRIMARY KEY,
          "COMMIT" TEXT,
          note TEXT DEFAULT 'ROLLBACK'
        );
        /* SAVEPOINT s1; RELEASE s1; */
        CREATE INDEX plugin_acme_widgets_safe_idx ON plugin_acme_widgets_safe (id);
      `,
    });

    try {
      await migratePluginWithSqlite(migrationContext(directory), { provider });

      expect(await provider.migrations.list("sqlite")).toHaveLength(1);
      expect(tableNames(provider.databasePath)).toContain("plugin_acme_widgets_safe");
    } finally {
      await provider.close();
    }
  });

  it("не активирует плагин с migrations без доступного каталога", async () => {
    const provider = await createOpenedProvider();

    try {
      await expect(migratePluginWithSqlite(migrationContext(null), { provider })).rejects.toThrow(
        /canonical path/u,
      );
    } finally {
      await provider.close();
    }
  });
});

describe("PluginService: migrations hook", () => {
  it("помечает плагин failed, если hook миграций не настроен", async () => {
    const service = await createService({ pluginDirectories: [pluginFixture()] });
    const state = await service.getState();
    const plugin = state.plugins.find((entry) => entry.id === PLUGIN);

    expect(plugin?.status).toBe("failed");
    expect(plugin?.activated).toBe(false);
    expect(plugin?.diagnostics.map((diagnostic) => diagnostic.code)).toContain("migration_failed");
  });

  it("вызывает настроенный hook с canonical migrationsPath и активирует плагин", async () => {
    const seen: string[] = [];
    const service = await createService({
      pluginDirectories: [pluginFixture()],
      hooks: {
        migrate: async (context) => {
          if (context.migrationsPath !== null) {
            seen.push(context.migrationsPath);
          }
        },
      },
    });
    const state = await service.getState();
    const plugin = state.plugins.find((entry) => entry.id === PLUGIN);

    expect(plugin?.status).toBe("active");
    expect(plugin?.activated).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endsWith(join("migrations"))).toBe(true);
  });
});
