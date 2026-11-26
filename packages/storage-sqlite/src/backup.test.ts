// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StorageMigrationRunner } from "@kanbaner/kernel";
import Database from "better-sqlite3";

import { checkpointBackupDatabase, restoreDatabase, verifyDatabaseIntegrity } from "./backup.ts";
import { createCoreInfrastructureMigrations } from "./infrastructure-migrations.ts";
import { createSqliteStorageProvider, type SqliteStorageProvider } from "./provider.ts";

const PLUGIN = "acme.widgets";
const COLLECTION = "widgets";

const directories: string[] = [];
const providers: SqliteStorageProvider[] = [];

function temporaryDirectory(prefix = "kanbaner-sqlite-backup-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
}

async function createProvider(
  options: Parameters<typeof createSqliteStorageProvider>[0] = {},
): Promise<SqliteStorageProvider> {
  const provider = createSqliteStorageProvider({
    dataDirectory: temporaryDirectory(),
    ...options,
  });

  providers.push(provider);
  await provider.open();
  await new StorageMigrationRunner(provider).run(createCoreInfrastructureMigrations());

  const database = new Database(provider.databasePath);

  try {
    database.prepare("DELETE FROM core_plugin_migrations WHERE plugin_id = ?").run("kanbaner.core");
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }

  return provider;
}

function closeProvider(provider: SqliteStorageProvider): Promise<void> {
  const index = providers.indexOf(provider);

  if (index >= 0) {
    providers.splice(index, 1);
  }

  return provider.close();
}

function documentInput(id: string) {
  return {
    pluginId: PLUGIN,
    collection: COLLECTION,
    id,
    data: { title: `Widget ${id}` },
    expectedVersion: 0,
  };
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

describe("online backup", () => {
  it("создаёт целостный backup при конкурентных записях", async () => {
    const provider = await createProvider();

    await provider.documents.put(documentInput("01JBACKUP00000000000000000001"));

    const backupPath = join(temporaryDirectory(), "snapshot.sqlite");
    const backupPromise = provider.backupTo(backupPath, { pagesPerStep: 1 });
    const writes: Promise<unknown>[] = [];

    for (let index = 1; index <= 25; index += 1) {
      writes.push(
        provider.documents.put(
          documentInput(`01JBACKUP0000000000000000${String(index + 1).padStart(2, "0")}`),
        ),
      );
    }

    const [backupResult] = await Promise.all([backupPromise, ...writes]);

    expect(backupResult.integrity).toBe("ok");
    expect(backupResult.sizeBytes).toBeGreaterThan(0);
    expect(backupResult.totalPages).toBeGreaterThan(0);
    expect(verifyDatabaseIntegrity(backupPath)).toEqual({ ok: true, status: "ok" });
    expect(await provider.documents.list(PLUGIN, COLLECTION)).toHaveLength(26);

    // Backup содержит документ, записанный до старта копирования. Конкурентные
    // записи отражаются в согласованном снимке, а не в повреждённом файле.
    const restoreDirectory = temporaryDirectory();
    const restored = await restoreDatabase({
      backupPath,
      dataDirectory: restoreDirectory,
    });
    const inspect = createSqliteStorageProvider({ dataDirectory: restoreDirectory });

    providers.push(inspect);
    await inspect.open();

    const documents = await inspect.documents.list(PLUGIN, COLLECTION);

    expect(documents.length).toBeGreaterThanOrEqual(1);
    expect(documents.length).toBeLessThanOrEqual(26);
    expect(existsSync(restored.databasePath)).toBe(true);
  });

  it("отклоняет перезапись live-базы и её sidecar-файлов", async () => {
    const provider = await createProvider();

    await expect(provider.backupTo(provider.databasePath)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "backup" },
    });
    await expect(provider.backupTo(`${provider.databasePath}-wal`)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "backup" },
    });
    await expect(
      provider.backupTo(join(temporaryDirectory(), "snapshot.sqlite"), {
        pagesPerStep: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("закрывает provider после завершения активного backup-а", async () => {
    const provider = await createProvider();

    for (let index = 0; index < 100; index += 1) {
      await provider.documents.put(
        documentInput(`01JCLOSE00000000000${String(index).padStart(3, "0")}`),
      );
    }

    const backupPath = join(temporaryDirectory(), "snapshot.sqlite");
    const backupPromise = provider.backupTo(backupPath, { pagesPerStep: 1 });
    const closePromise = closeProvider(provider);

    const [backupResult] = await Promise.all([backupPromise, closePromise]);

    expect(backupResult.integrity).toBe("ok");
    expect(existsSync(backupPath)).toBe(true);
    expect((await provider.healthCheck()).ok).toBe(false);
  });
});

describe("verifyDatabaseIntegrity", () => {
  it("обнаруживает повреждённый или не-SQLite файл", () => {
    const directory = temporaryDirectory();
    const corruptPath = join(directory, "corrupt.sqlite");

    writeFileSync(corruptPath, "это не база данных", "utf8");

    expect(() => verifyDatabaseIntegrity(corruptPath)).toThrow();
    expect(() => verifyDatabaseIntegrity(join(directory, "missing.sqlite"))).toThrow();

    for (const path of [corruptPath, join(directory, "missing.sqlite")]) {
      try {
        verifyDatabaseIntegrity(path);
        throw new Error("Ожидалась ошибка integrity_check");
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "corrupt" } });
      }
    }
  });

  it("отклоняет сетевой путь до открытия файла", () => {
    expect(() => verifyDatabaseIntegrity("//server/share/kanbaner.sqlite")).toThrow();

    try {
      verifyDatabaseIntegrity("//server/share/kanbaner.sqlite");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "path" } });
    }
  });
});

describe("offline restore", () => {
  async function createBackup(): Promise<{ backupPath: string; title: string }> {
    const provider = await createProvider();
    const title = "Restored widget";

    await provider.documents.put({
      pluginId: PLUGIN,
      collection: COLLECTION,
      id: "01JDOC00000000000000000301",
      data: { title },
      expectedVersion: 0,
    });

    const backupPath = join(temporaryDirectory(), "restore-source.sqlite");

    await provider.backupTo(backupPath);
    await closeProvider(provider);

    return { backupPath, title };
  }

  it("восстанавливает базу в новый каталог и открывает её через provider", async () => {
    const { backupPath, title } = await createBackup();
    const dataDirectory = temporaryDirectory();

    const result = await restoreDatabase({ backupPath, dataDirectory });

    expect(result.databasePath).toBe(join(dataDirectory, "kanbaner.sqlite"));
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(verifyDatabaseIntegrity(result.databasePath).ok).toBe(true);

    const provider = createSqliteStorageProvider({ dataDirectory });

    providers.push(provider);
    await provider.open();

    const document = await provider.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000301");

    expect(document?.data).toEqual({ title });
    expect((await provider.diagnostics()).journalMode).toBe("wal");
  });

  it("отклоняет существующую базу или её sidecar-файлы в целевом каталоге", async () => {
    const { backupPath } = await createBackup();
    const dataDirectory = temporaryDirectory();

    await restoreDatabase({ backupPath, dataDirectory });

    await expect(restoreDatabase({ backupPath, dataDirectory })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "path" },
    });

    const walDirectory = temporaryDirectory();
    const walTarget = join(walDirectory, "kanbaner.sqlite");

    mkdirSync(walDirectory, { recursive: true });
    writeFileSync(`${walTarget}-wal`, "", "utf8");

    await expect(
      restoreDatabase({ backupPath, dataDirectory: walDirectory }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "path" } });

    const shmDirectory = temporaryDirectory();

    writeFileSync(join(shmDirectory, "kanbaner.sqlite-shm"), "", "utf8");

    await expect(
      restoreDatabase({ backupPath, dataDirectory: shmDirectory }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "path" } });
  });

  it("отклоняет backup с sidecar-файлами live-базы", async () => {
    const { backupPath } = await createBackup();

    writeFileSync(`${backupPath}-wal`, "", "utf8");

    await expect(
      restoreDatabase({ backupPath, dataDirectory: temporaryDirectory() }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "backup" } });
  });

  it("отклоняет отсутствующий, повреждённый и совпадающий с целью backup", async () => {
    const directory = temporaryDirectory();
    const missing = join(directory, "missing.sqlite");

    await expect(
      restoreDatabase({ backupPath: missing, dataDirectory: temporaryDirectory() }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "path" } });

    const corrupt = join(directory, "corrupt.sqlite");

    writeFileSync(corrupt, "not a database", "utf8");

    await expect(
      restoreDatabase({ backupPath: corrupt, dataDirectory: temporaryDirectory() }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "corrupt" } });

    await expect(
      restoreDatabase({ backupPath: corrupt, dataDirectory: directory }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const { backupPath } = await createBackup();

    await expect(
      restoreDatabase({
        backupPath,
        dataDirectory: backupPath.slice(0, backupPath.lastIndexOf("/")),
        databaseFileName: "restore-source.sqlite",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "path" } });

    await expect(
      restoreDatabase({
        backupPath,
        dataDirectory: temporaryDirectory(),
        databaseFileName: "invalid name.sqlite",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "path" } });
  });

  it("поддерживает не-ASCII и пробелы в пути восстановления", async () => {
    const { backupPath, title } = await createBackup();
    const dataDirectory = temporaryDirectory("kan baner-restore-ü-");

    const result = await restoreDatabase({
      backupPath,
      dataDirectory,
      databaseFileName: "copy-1.sqlite",
    });

    expect(result.databasePath).toBe(join(dataDirectory, "copy-1.sqlite"));

    const provider = createSqliteStorageProvider({
      dataDirectory,
      databaseFileName: "copy-1.sqlite",
    });

    providers.push(provider);
    await provider.open();

    expect(
      (await provider.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000301"))?.data,
    ).toEqual({ title });
  });
});

describe("backup: сохранность чужих файлов и checkpoint", () => {
  it("не перезаписывает существующий backup и его sidecar-файлы", async () => {
    const provider = await createProvider();
    const directory = temporaryDirectory();
    const destination = join(directory, "old-backup.sqlite");
    const sidecars = [`${destination}-wal`, `${destination}-shm`, `${destination}-journal`];

    writeFileSync(destination, "old backup", "utf8");

    for (const sidecar of sidecars) {
      writeFileSync(sidecar, `foreign:${sidecar}`, "utf8");
    }

    await expect(provider.backupTo(destination)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "path" },
    });

    expect(readFileSync(destination, "utf8")).toBe("old backup");

    for (const sidecar of sidecars) {
      expect(readFileSync(sidecar, "utf8")).toBe(`foreign:${sidecar}`);
    }

    expect(readdirSync(directory).sort()).toEqual(
      [
        "old-backup.sqlite",
        "old-backup.sqlite-journal",
        "old-backup.sqlite-shm",
        "old-backup.sqlite-wal",
      ].sort(),
    );
  });

  it("не оставляет temp и sidecar-файлов после успешного backup", async () => {
    const provider = await createProvider();
    const directory = temporaryDirectory();
    const destination = join(directory, "snapshot.sqlite");

    await provider.backupTo(destination);

    const entries = readdirSync(directory);

    expect(entries).toEqual(["snapshot.sqlite"]);
    expect(existsSync(`${destination}-wal`)).toBe(false);
    expect(existsSync(`${destination}-shm`)).toBe(false);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("сообщает busy, если checkpoint удерживает читатель", { timeout: 15_000 }, () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "busy.sqlite");
    const writer = new Database(databasePath);
    let reader: Database.Database | undefined;

    try {
      writer.pragma("journal_mode = WAL");
      writer.exec(
        "CREATE TABLE checkpoint_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);" +
          "INSERT INTO checkpoint_items (value) VALUES ('a');",
      );

      reader = new Database(databasePath);
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM checkpoint_items").all();

      expect(() => checkpointBackupDatabase(databasePath)).toThrow(/checkpoint/u);
    } finally {
      try {
        reader?.exec("COMMIT");
      } catch {
        // Транзакция могла быть уже закрыта.
      }

      reader?.close();
      writer.close();
    }
  });
});

describe("offline restore: пустой каталог и temp", () => {
  it("отклоняет непустой каталог до открытия backup и сохраняет чужой файл", async () => {
    const { backupPath } = await (async () => {
      const provider = await createProvider();

      await provider.documents.put({
        pluginId: PLUGIN,
        collection: COLLECTION,
        id: "01JDOC00000000000000000401",
        data: { title: "Restore" },
        expectedVersion: 0,
      });

      const path = join(temporaryDirectory(), "backup-source.sqlite");

      await provider.backupTo(path);
      await closeProvider(provider);

      return { backupPath: path };
    })();

    const dataDirectory = temporaryDirectory();
    const foreign = join(dataDirectory, "foreign.txt");

    writeFileSync(foreign, "keep me", "utf8");

    await expect(restoreDatabase({ backupPath, dataDirectory })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "path" },
    });

    expect(readFileSync(foreign, "utf8")).toBe("keep me");
    expect(existsSync(join(dataDirectory, "kanbaner.sqlite"))).toBe(false);
    expect(readdirSync(dataDirectory)).toEqual(["foreign.txt"]);
  });

  it("создаёт несуществующий каталог и не оставляет temp после успеха", async () => {
    const provider = await createProvider();
    const backupPath = join(temporaryDirectory(), "backup-source.sqlite");

    await provider.backupTo(backupPath);
    await closeProvider(provider);

    const dataDirectory = join(temporaryDirectory(), "nested", "data ü");

    const result = await restoreDatabase({ backupPath, dataDirectory });

    expect(result.databasePath).toBe(join(dataDirectory, "kanbaner.sqlite"));
    expect(readdirSync(dataDirectory)).toEqual(["kanbaner.sqlite"]);
    expect(existsSync(`${result.databasePath}-wal`)).toBe(false);
    expect(existsSync(`${result.databasePath}-shm`)).toBe(false);
  });
});
