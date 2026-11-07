// @vitest-environment node

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { StorageError } from "@kanbaner/plugin-sdk";

import { createSqliteStorageProvider, type SqliteStorageProvider } from "./provider.ts";
import { pluginNamespacePrefix, pluginNamespaceTable } from "./namespaces.ts";

const directories: string[] = [];
const providers: SqliteStorageProvider[] = [];

function temporaryDirectory(prefix = "kanbaner-sqlite-provider-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
}

async function createOpenedProvider(
  options: Parameters<typeof createSqliteStorageProvider>[0] = {},
): Promise<SqliteStorageProvider> {
  const provider = createSqliteStorageProvider({
    dataDirectory: temporaryDirectory(),
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

describe("SQLite provider: настройки, WAL и persistence", () => {
  it("устанавливает WAL, foreign_keys, busy_timeout и synchronous=NORMAL", async () => {
    const provider = await createOpenedProvider();
    const diagnostics = await provider.diagnostics();

    expect(diagnostics.journalMode).toBe("wal");
    expect(diagnostics.wal).toBe(true);
    expect(diagnostics.foreignKeys).toBe(true);
    expect(diagnostics.busyTimeoutMs).toBe(5000);
    expect(diagnostics.synchronous).toBe("NORMAL");
  });

  it("сохраняет данные после close и повторного open", async () => {
    const provider = await createOpenedProvider();
    const dataDirectory = provider.dataDirectory;

    await provider.documents.put({
      pluginId: "acme.widgets",
      collection: "widgets",
      id: "01JDOC00000000000000000001",
      data: { title: "Persisted" },
      expectedVersion: 0,
    });
    await provider.close();

    const walPath = `${provider.databasePath}-wal`;
    expect(!existsSync(walPath) || statSync(walPath).size === 0).toBe(true);

    const reopened = createSqliteStorageProvider({ dataDirectory });
    providers.push(reopened);
    await reopened.open();

    const document = await reopened.documents.get(
      "acme.widgets",
      "widgets",
      "01JDOC00000000000000000001",
    );

    expect(document?.data).toEqual({ title: "Persisted" });
    expect((await reopened.diagnostics()).journalMode).toBe("wal");
  });

  it("работает с пробелами и не-ASCII в пути каталога данных", async () => {
    const directory = temporaryDirectory("kan baner-ü-");
    const provider = createSqliteStorageProvider({ dataDirectory: directory });
    providers.push(provider);
    await provider.open();

    await provider.pluginStates.put({
      pluginId: "acme.widgets",
      version: "1.0.0",
      enabled: true,
      state: { путь: "значение" },
    });

    expect((await provider.pluginStates.get("acme.widgets"))?.state).toEqual({
      путь: "значение",
    });
    expect(provider.databasePath.startsWith(directory)).toBe(true);
  });

  it("идемпотентно открывается и закрывается", async () => {
    const provider = createSqliteStorageProvider({ dataDirectory: temporaryDirectory() });
    providers.push(provider);

    await provider.open();
    await provider.open();
    expect((await provider.healthCheck()).ok).toBe(true);

    await provider.close();
    await provider.close();
    expect((await provider.healthCheck()).ok).toBe(false);
  });

  it("публичные операции закрытого provider-а отклоняются PROVIDER_CLOSED", async () => {
    const provider = createSqliteStorageProvider({ dataDirectory: temporaryDirectory() });
    providers.push(provider);

    await provider.open();
    await provider.close();

    await expect(provider.documents.list("acme.widgets")).rejects.toMatchObject({
      code: "PROVIDER_CLOSED",
    });
    await expect(provider.withTransaction(async () => undefined)).rejects.toMatchObject({
      code: "PROVIDER_CLOSED",
    });
  });
});

describe("SQLite provider: app-generated ID и UTC", () => {
  it("не использует rowid как публичный ID и сохраняет UTC без сдвига", async () => {
    let now = new Date("2026-11-06T12:00:00.000Z");
    const provider = await createOpenedProvider({ now: () => now });

    const created = await provider.documents.put({
      pluginId: "acme.widgets",
      collection: "widgets",
      id: "external-id-a",
      data: { title: "A" },
      expectedVersion: 0,
    });

    expect(created.id).toBe("external-id-a");
    expect(created.createdAt).toBe("2026-11-06T12:00:00.000Z");
    expect(created.updatedAt).toBe("2026-11-06T12:00:00.000Z");

    now = new Date("2026-11-06T13:30:00.000Z");

    const updated = await provider.documents.put({
      pluginId: "acme.widgets",
      collection: "widgets",
      id: "external-id-a",
      data: { title: "A2" },
      expectedVersion: 1,
    });

    expect(updated.createdAt).toBe("2026-11-06T12:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-11-06T13:30:00.000Z");

    await provider.documents.delete("acme.widgets", "widgets", "external-id-a");
    const recreated = await provider.documents.put({
      pluginId: "acme.widgets",
      collection: "widgets",
      id: "external-id-a",
      data: { title: "A3" },
      expectedVersion: 0,
    });

    expect(recreated.id).toBe("external-id-a");
    expect(recreated.version).toBe(1);
  });
});

describe("SQLite provider: bounded SQLITE_BUSY retry", () => {
  it("делает ограниченное число попыток и возвращает retryable ошибку", async () => {
    const provider = await createOpenedProvider({
      busyTimeoutMs: 5,
      busyRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const external = new Database(provider.databasePath);

    try {
      external.pragma("busy_timeout = 5");
      external.exec("BEGIN IMMEDIATE");

      const startedAt = Date.now();

      await expect(
        provider.documents.put({
          pluginId: "acme.widgets",
          collection: "widgets",
          id: "01JDOC00000000000000000001",
          data: { title: "Busy" },
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        retryable: true,
        details: { reason: "busy", attempts: 2 },
      });

      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      external.exec("ROLLBACK");
      external.close();
    }

    const document = await provider.documents.put({
      pluginId: "acme.widgets",
      collection: "widgets",
      id: "01JDOC00000000000000000001",
      data: { title: "After busy" },
      expectedVersion: 0,
    });

    expect(document.version).toBe(1);
  });

  it("повторяет безопасную операцию, если блокировка снята в пределах лимита", async () => {
    const provider = await createOpenedProvider({
      busyTimeoutMs: 5,
      busyRetry: { maxAttempts: 10, baseDelayMs: 5, maxDelayMs: 20 },
    });
    const external = new Database(provider.databasePath);

    try {
      external.pragma("busy_timeout = 5");
      external.exec("BEGIN IMMEDIATE");

      setTimeout(() => {
        external.exec("ROLLBACK");
      }, 30);

      const document = await provider.documents.put({
        pluginId: "acme.widgets",
        collection: "widgets",
        id: "01JDOC00000000000000000002",
        data: { title: "Eventually" },
        expectedVersion: 0,
      });

      expect(document.id).toBe("01JDOC00000000000000000002");
    } finally {
      if (external.inTransaction) {
        external.exec("ROLLBACK");
      }

      external.close();
    }
  });
});

describe("SQLite provider: singleton, namespace и отсутствие raw SQL API", () => {
  it("не открывает второе соединение при повторном запросе singleton-а", async () => {
    const directory = temporaryDirectory();
    const { getSqliteStorageProvider, resetSqliteStorageSingleton } =
      await import("./singleton.ts");

    try {
      const first = getSqliteStorageProvider({ dataDirectory: directory });
      const second = getSqliteStorageProvider({ dataDirectory: directory });

      expect(second).toBe(first);

      await first.open();
      await second.open();

      const otherDirectory = temporaryDirectory();
      expect(() => getSqliteStorageProvider({ dataDirectory: otherDirectory })).toThrow(
        StorageError,
      );

      await resetSqliteStorageSingleton();

      const third = getSqliteStorageProvider({ dataDirectory: directory });
      expect(third).not.toBe(first);
      await third.close();
    } finally {
      await resetSqliteStorageSingleton();
    }
  });

  it("изолирует документы и состояние по pluginId", async () => {
    const provider = await createOpenedProvider();

    await provider.documents.put({
      pluginId: "acme.widgets",
      collection: "widgets",
      id: "01JDOC00000000000000000001",
      data: { title: "Widget" },
      expectedVersion: 0,
    });
    await provider.pluginStates.put({
      pluginId: "acme.widgets",
      version: "1.0.0",
      enabled: true,
      state: { owner: "widgets" },
    });

    expect(
      await provider.documents.get("acme.gadgets", "widgets", "01JDOC00000000000000000001"),
    ).toBeNull();
    expect(await provider.pluginStates.get("acme.gadgets")).toBeNull();
    expect(await provider.pluginStates.list()).toHaveLength(1);
  });

  it("строит namespace-префикс только из валидированного Plugin ID", () => {
    expect(pluginNamespacePrefix("acme.widgets")).toBe("plugin_acme_widgets_");
    expect(pluginNamespaceTable("acme.widgets", "items")).toBe("plugin_acme_widgets_items");
    expect(() => pluginNamespacePrefix("Invalid:Plugin")).toThrow(StorageError);
    expect(() => pluginNamespaceTable("acme.widgets", "items; DROP TABLE x")).toThrow(StorageError);
  });

  it("не предоставляет публичного доступа к соединению или SQL", async () => {
    const provider = await createOpenedProvider();

    expect("exec" in provider).toBe(false);
    expect("prepare" in provider).toBe(false);
    expect("database" in provider).toBe(false);
    expect("db" in provider).toBe(false);
  });
});
