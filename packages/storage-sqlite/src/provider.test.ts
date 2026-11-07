// @vitest-environment node

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { StorageError } from "@kanbaner/plugin-sdk";
import { StorageMigrationRunner } from "@kanbaner/kernel";

import { createCoreInfrastructureMigrations } from "./infrastructure-migrations.ts";

import { createSqliteStorageProvider, type SqliteStorageProvider } from "./provider.ts";
import { pluginNamespacePrefix, pluginNamespaceTable } from "./namespaces.ts";

const directories: string[] = [];
const providers: SqliteStorageProvider[] = [];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function documentInput(id: string) {
  return {
    pluginId: "acme.widgets",
    collection: "widgets",
    id,
    data: { title: `Widget ${id}` },
    expectedVersion: 0,
  };
}

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
  it("open создаёт только журнал, версионируемая схема — в migration.up", async () => {
    const provider = createSqliteStorageProvider({ dataDirectory: temporaryDirectory() });
    providers.push(provider);
    await provider.open();

    const inspect = () => {
      const database = new Database(provider.databasePath, { readonly: true });

      try {
        return (
          database
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
            .all() as { readonly name: string }[]
        ).map((row) => row.name);
      } finally {
        database.close();
      }
    };

    const before = inspect();

    expect(before).toContain("core_plugin_migrations");
    expect(before).not.toContain("core_documents");
    expect(before).not.toContain("core_plugins");
    expect(before).not.toContain("core_resource_links");
    expect(before).not.toContain("core_search_documents");

    await new StorageMigrationRunner(provider).run(createCoreInfrastructureMigrations());

    const after = inspect();

    expect(after).toContain("core_documents");
    expect(after).toContain("core_plugins");
    expect(after).toContain("core_resource_links");
    expect(after).toContain("core_search_documents");
  });

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
    const provider = await createOpenedProvider({ dataDirectory: directory });

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

describe("SQLite provider: savepoint scheduling", () => {
  it("сериализует sibling savepoints и не даёт позднему завершиться раньше раннего", async () => {
    const provider = await createOpenedProvider();
    const gate = deferred<undefined>();
    const events: string[] = [];

    await provider.withTransaction(async (transaction) => {
      const first = transaction.withSavepoint(async (nested) => {
        events.push("first:enter");
        await gate.promise;
        await nested.documents.put(documentInput("01JSAVEPOINT0000000000000001"));
        events.push("first:exit");
      });
      const second = transaction.withSavepoint(async (nested) => {
        events.push("second:enter");
        await nested.documents.put(documentInput("01JSAVEPOINT0000000000000002"));
        events.push("second:exit");
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(events).toEqual(["first:enter"]);

      gate.resolve(undefined);
      await Promise.all([first, second]);
    });

    expect(events).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);

    const documents = await provider.documents.list("acme.widgets", "widgets");

    expect(documents.map((document) => document.id).sort()).toEqual([
      "01JSAVEPOINT0000000000000001",
      "01JSAVEPOINT0000000000000002",
    ]);
  });

  it("заставляет parent write ждать rollback child savepoint", async () => {
    const provider = await createOpenedProvider();
    const childEntered = deferred<undefined>();
    const gate = deferred<undefined>();
    let parentSettled = false;

    await provider.withTransaction(async (transaction) => {
      const child = transaction.withSavepoint(async (nested) => {
        await nested.documents.put(documentInput("01JSAVEPOINT0000000000000011"));
        childEntered.resolve(undefined);
        await gate.promise;
        throw new Error("child savepoint failed");
      });

      void child.catch(() => undefined);
      await childEntered.promise;

      const parentWrite = transaction.documents.put(documentInput("01JSAVEPOINT0000000000000012"));

      void parentWrite.finally(() => {
        parentSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(parentSettled).toBe(false);

      gate.resolve(undefined);

      await expect(child).rejects.toThrow(/child savepoint failed/u);
      await parentWrite;
    });

    expect(
      await provider.documents.get("acme.widgets", "widgets", "01JSAVEPOINT0000000000000011"),
    ).toBeNull();
    expect(
      await provider.documents.get("acme.widgets", "widgets", "01JSAVEPOINT0000000000000012"),
    ).not.toBeNull();
  });
});

describe("SQLite provider: stack-aware savepoint scheduling", () => {
  it("parent write, начатый первым, заставляет child savepoint ждать", async () => {
    const provider = await createOpenedProvider({ delays: { operationMs: 25 } });
    const events: string[] = [];

    await provider.withTransaction(async (transaction) => {
      const parentWrite = transaction.documents.put(documentInput("01JSTACK00000000000000000001"));

      const child = transaction.withSavepoint(async (nested) => {
        // Child стартует после SQL parent-операции: в собственной транзакции
        // parent-запись уже видна, хотя её Promise-обработчик ещё не выполнен.
        const parentDocument = await nested.documents.get(
          "acme.widgets",
          "widgets",
          "01JSTACK00000000000000000001",
        );

        events.push(parentDocument === null ? "child:missing-parent" : "child:sees-parent");
        await nested.documents.put(documentInput("01JSTACK00000000000000000002"));
        events.push("child:exit");
      });

      await Promise.all([parentWrite, child]);
    });

    expect(events).toEqual(["child:sees-parent", "child:exit"]);
  });

  it("сериализует sibling savepoints внутри вложенного savepoint", async () => {
    const provider = await createOpenedProvider();
    const gate = deferred<undefined>();
    const events: string[] = [];

    await provider.withTransaction(async (transaction) => {
      await transaction.withSavepoint(async (outer) => {
        const first = outer.withSavepoint(async (nested) => {
          events.push("first:enter");
          await gate.promise;
          await nested.documents.put(documentInput("01JSTACK00000000000000000011"));
          events.push("first:exit");
        });
        const second = outer.withSavepoint(async (nested) => {
          events.push("second:enter");
          await nested.documents.put(documentInput("01JSTACK00000000000000000012"));
          events.push("second:exit");
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(events).toEqual(["first:enter"]);

        gate.resolve(undefined);
        await Promise.all([first, second]);
      });
    });

    expect(events).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);

    const documents = await provider.documents.list("acme.widgets", "widgets");

    expect(documents.map((document) => document.id).sort()).toEqual([
      "01JSTACK00000000000000000011",
      "01JSTACK00000000000000000012",
    ]);
  });

  it("rollback inner savepoint не откатывает write parent scope", async () => {
    const provider = await createOpenedProvider();
    const innerEntered = deferred<undefined>();
    const gate = deferred<undefined>();
    let parentWriteSettled = false;

    await provider.withTransaction(async (transaction) => {
      await transaction.withSavepoint(async (outer) => {
        const inner = outer.withSavepoint(async (deep) => {
          await deep.documents.put(documentInput("01JSTACK00000000000000000021"));
          innerEntered.resolve(undefined);
          await gate.promise;
          throw new Error("inner savepoint failed");
        });

        void inner.catch(() => undefined);
        await innerEntered.promise;

        const parentScopeWrite = outer.documents.put(documentInput("01JSTACK00000000000000000022"));

        void parentScopeWrite.finally(() => {
          parentWriteSettled = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(parentWriteSettled).toBe(false);

        gate.resolve(undefined);

        await expect(inner).rejects.toThrow(/inner savepoint failed/u);
        await parentScopeWrite;
      });
    });

    expect(
      await provider.documents.get("acme.widgets", "widgets", "01JSTACK00000000000000000021"),
    ).toBeNull();
    expect(
      await provider.documents.get("acme.widgets", "widgets", "01JSTACK00000000000000000022"),
    ).not.toBeNull();
  });
});

describe("SQLite provider: deadlock планировщика", () => {
  it(
    "depth 1: await операции parent scope внутри child callback даёт SCHEDULING_DEADLOCK",
    { timeout: 3_000 },
    async () => {
      const provider = await createOpenedProvider();

      const result = await provider.withTransaction(async (transaction) => {
        return transaction.withSavepoint(async (nested) => {
          await expect(
            transaction.documents.put(documentInput("01JDEADLOCK00000000000000001")),
          ).rejects.toMatchObject({
            code: "INVALID_ARGUMENT",
            details: { reason: "SCHEDULING_DEADLOCK", operation: "operation" },
          });

          // Собственный scope продолжает работать после обработанной ошибки.
          await nested.documents.put(documentInput("01JDEADLOCK00000000000000002"));

          return "committed";
        });
      });

      expect(result).toBe("committed");

      const documents = await provider.documents.list("acme.widgets", "widgets");

      expect(documents.map((document) => document.id)).toEqual(["01JDEADLOCK00000000000000002"]);

      // Provider принимает новые операции и корректно закрывается.
      await provider.documents.put(documentInput("01JDEADLOCK00000000000000003"));
      await provider.close();
    },
  );

  it(
    "depth 2: await операции parent scope внутри grandchild callback даёт SCHEDULING_DEADLOCK",
    { timeout: 3_000 },
    async () => {
      const provider = await createOpenedProvider();

      await provider.withTransaction(async (transaction) => {
        await transaction.withSavepoint(async (child) => {
          await child.withSavepoint(async (grandchild) => {
            await expect(
              child.documents.put(documentInput("01JDEADLOCK00000000000000011")),
            ).rejects.toMatchObject({
              code: "INVALID_ARGUMENT",
              details: { reason: "SCHEDULING_DEADLOCK", operation: "operation" },
            });

            await grandchild.documents.put(documentInput("01JDEADLOCK00000000000000012"));
          });
        });
      });

      const documents = await provider.documents.list("acme.widgets", "widgets");

      expect(documents.map((document) => document.id)).toEqual(["01JDEADLOCK00000000000000012"]);

      await provider.close();
    },
  );

  it(
    "await sibling savepoint из активного callback даёт SCHEDULING_DEADLOCK",
    { timeout: 3_000 },
    async () => {
      const provider = await createOpenedProvider();

      await provider.withTransaction(async (transaction) => {
        await transaction.withSavepoint(async (child) => {
          await expect(
            transaction.withSavepoint(async (sibling) => {
              await sibling.documents.put(documentInput("01JDEADLOCK00000000000000021"));
            }),
          ).rejects.toMatchObject({
            code: "INVALID_ARGUMENT",
            details: { reason: "SCHEDULING_DEADLOCK", operation: "savepoint" },
          });

          // Допустимый вложенный savepoint и store op в своём scope работают.
          await child.withSavepoint(async (nested) => {
            await nested.documents.put(documentInput("01JDEADLOCK00000000000000022"));
          });
          await child.documents.put(documentInput("01JDEADLOCK00000000000000023"));
        });
      });

      const documents = await provider.documents.list("acme.widgets", "widgets");

      expect(documents.map((document) => document.id).sort()).toEqual([
        "01JDEADLOCK00000000000000022",
        "01JDEADLOCK00000000000000023",
      ]);

      await provider.close();
    },
  );

  it(
    "необработанный scheduling deadlock откатывает транзакцию, provider остаётся рабочим",
    { timeout: 3_000 },
    async () => {
      const provider = await createOpenedProvider();

      await expect(
        provider.withTransaction(async (transaction) => {
          await transaction.withSavepoint(async (child) => {
            await child.documents.put(documentInput("01JDEADLOCK00000000000000031"));
            await transaction.documents.put(documentInput("01JDEADLOCK00000000000000032"));
          });
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { reason: "SCHEDULING_DEADLOCK" },
      });

      expect(await provider.documents.list("acme.widgets", "widgets")).toEqual([]);

      await provider.documents.put(documentInput("01JDEADLOCK00000000000000033"));
      await provider.close();
    },
  );
});
