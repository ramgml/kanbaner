import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import {
  createStorageCapabilities,
  currentUtcTimestamp,
  isContractId,
  type BackendId,
  type StorageCapabilities,
  type StorageHealth,
  type StorageProvider,
  type StorageStoreRegistration,
  type StorageStoreScope,
  type StorageTransaction,
} from "@kanbaner/plugin-sdk";

import { AsyncMutex } from "./async-mutex.ts";
import { TransactionScheduler } from "./scheduler.ts";
import {
  assertLocalFilesystemPath,
  isSameFilesystemPath,
  resolveDataDirectory,
  resolveDatabasePath,
} from "./paths.ts";
import {
  isSqliteBusyError,
  providerClosedError,
  savepointsUnsupportedError,
  sqliteError,
  toStorageError,
  transactionClosedError,
} from "./errors.ts";
import {
  assertDestinationFree,
  backupTempPath,
  checkpointBackupDatabase,
  publishExclusive,
  removeOwnedFiles,
  verifyDatabaseIntegrity,
} from "./backup.ts";
import { JOURNAL_SCHEMA_SQL } from "./schema.ts";
import {
  createDocumentStore,
  createLinkStore,
  createMigrationStore,
  createPluginStateStore,
  createSearchIndexStore,
  type StoreRunner,
} from "./stores.ts";
import {
  createTransactionScope,
  hasRolledBackAncestor,
  isScopeActive,
  type TransactionScope,
} from "./scope.ts";
import { assertBackendId, assertPositiveVersion } from "./validation.ts";

export interface SqliteStorageDelays {
  readonly openMs?: number;
  readonly healthCheckMs?: number;
  readonly operationMs?: number;
  readonly transactionMs?: number;
}

export interface SqliteBusyRetryOptions {
  /** Максимальное число попыток; 1 означает отсутствие повторов. */
  readonly maxAttempts?: number;
  /** Базовая задержка перед повтором, мс. */
  readonly baseDelayMs?: number;
  /** Верхняя граница задержки, мс. */
  readonly maxDelayMs?: number;
}

export interface SqliteStorageProviderOptions {
  /**
   * Стабильный backendId. Production всегда использует `sqlite`.
   * Переопределение нужно только для conformance-проверки реестра.
   */
  readonly backendId?: BackendId;
  readonly dataDirectory?: string;
  readonly databaseFileName?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
  readonly now?: () => Date;
  readonly delays?: SqliteStorageDelays;
  readonly busyTimeoutMs?: number;
  readonly busyRetry?: SqliteBusyRetryOptions;
  readonly savepoints?: boolean;
}

export interface SqliteStorageDiagnostics {
  readonly backendId: BackendId;
  readonly databasePath: string;
  readonly dataDirectory: string;
  readonly journalMode: string;
  readonly wal: boolean;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  readonly synchronous: "OFF" | "NORMAL" | "FULL" | "EXTRA";
}

export interface SqliteOnlineBackupResult {
  readonly path: string;
  readonly sizeBytes: number;
  readonly totalPages: number;
  readonly integrity: string;
  readonly checkedAt: string;
}

interface ScopedOutcome<T> {
  readonly failed: boolean;
  readonly failure: unknown;
  readonly result: T;
}

interface TransactionHost {
  readonly backendId: BackendId;
  readonly savepoints: boolean;
  readonly scope: TransactionScope;
  readonly scheduler: TransactionScheduler;
  readonly transactionRunner: (scope: TransactionScope) => StoreRunner;
  readonly createStores: (run: StoreRunner) => StorageStoreScope;
  readonly executeSavepoint: <T>(
    depth: number,
    parentScope: TransactionScope,
    callback: (transaction: StorageTransaction) => Promise<T>,
  ) => Promise<T>;
  readonly track: <T>(scope: TransactionScope, task: Promise<T>) => Promise<T>;
  readonly assertStoreRegistration: <T>(registration: StorageStoreRegistration<T>) => void;
  readonly execDdl: (sql: string) => void;
}

function delayValue(value: number | undefined, label: string, maximum: number): number {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw sqliteError(
      "INVALID_ARGUMENT",
      `Задержка ${label} должна быть целым числом 0…${maximum} мс`,
    );
  }

  return value;
}

function busyTimeoutValue(value: number | undefined): number {
  if (value === undefined) {
    return 5_000;
  }

  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    throw sqliteError("INVALID_ARGUMENT", "busy_timeout должен быть целым числом 0…60000 мс");
  }

  return value;
}

function retryValue(
  value: number | undefined,
  label: string,
  fallback: number,
  max: number,
): number {
  const resolved = value ?? fallback;

  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw sqliteError("INVALID_ARGUMENT", `Параметр ${label} должен быть целым числом 0…${max}`);
  }

  return resolved;
}

/**
 * Транзакция SQLite provider-а.
 *
 * Класс не входит в публичный экспорт пакета. Инфраструктурная миграция
 * использует его внутренний DDL-метод, чтобы не выносить SQL в доменный код.
 */
export class SqliteStorageTransaction implements StorageTransaction {
  readonly backendId: BackendId;
  readonly depth: number;
  readonly documents: StorageStoreScope["documents"];
  readonly links: StorageStoreScope["links"];
  readonly pluginStates: StorageStoreScope["pluginStates"];
  readonly migrations: StorageStoreScope["migrations"];
  readonly searchIndex: StorageStoreScope["searchIndex"];

  readonly #host: TransactionHost;
  readonly #scope: TransactionScope;

  constructor(host: TransactionHost, depth: number) {
    this.#host = host;
    this.#scope = host.scope;
    this.backendId = host.backendId;
    this.depth = depth;

    const stores = host.createStores(host.transactionRunner(host.scope));

    this.documents = stores.documents;
    this.links = stores.links;
    this.pluginStates = stores.pluginStates;
    this.migrations = stores.migrations;
    this.searchIndex = stores.searchIndex;
  }

  withSavepoint<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T> {
    if (!this.#host.savepoints) {
      return Promise.reject(savepointsUnsupportedError());
    }

    if (!isScopeActive(this.#scope)) {
      return Promise.reject(transactionClosedError());
    }

    const task = this.#host.executeSavepoint(this.depth + 1, this.#scope, callback);

    return this.#host.track(this.#scope, task);
  }

  async createStore<TStore>(registration: StorageStoreRegistration<TStore>): Promise<TStore> {
    if (!isScopeActive(this.#scope)) {
      throw transactionClosedError();
    }

    this.#host.assertStoreRegistration(registration);

    return registration.create(this);
  }

  /** @internal Используется инфраструктурной миграцией provider-а. */
  execInfrastructureDdl(sql: string): void {
    if (!isScopeActive(this.#scope)) {
      throw transactionClosedError();
    }

    this.#host.execDdl(sql);
  }

  /** @internal Используется backend-specific loader-ом миграций плагина. */
  execMigrationSql(sql: string): void {
    if (!isScopeActive(this.#scope)) {
      throw transactionClosedError();
    }

    this.#host.execDdl(sql);
  }
}

/**
 * Storage Provider на SQLite WAL.
 *
 * Синхронный `better-sqlite3` полностью скрыт внутри асинхронного публичного
 * API. Все операции на соединении сериализуются FIFO-мьютексом; транзакция
 * удерживает его до завершения async callback.
 */
export class SqliteStorageProvider implements StorageProvider {
  readonly backendId: BackendId;
  readonly capabilities: StorageCapabilities;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly documents: StorageStoreScope["documents"];
  readonly links: StorageStoreScope["links"];
  readonly pluginStates: StorageStoreScope["pluginStates"];
  readonly migrations: StorageStoreScope["migrations"];
  readonly searchIndex: StorageStoreScope["searchIndex"];

  readonly #mutex = new AsyncMutex();
  readonly #now: () => Date;
  readonly #delays: Required<SqliteStorageDelays>;
  readonly #busyTimeoutMs: number;
  readonly #busyRetry: Required<SqliteBusyRetryOptions>;
  #database: Database.Database | null = null;
  #opened = false;
  #savepointCounter = 0;
  #activeBackups = 0;
  readonly #backupWaiters: (() => void)[] = [];

  constructor(options: SqliteStorageProviderOptions = {}) {
    const backendId = options.backendId ?? "sqlite";

    assertBackendId(backendId);

    this.backendId = backendId;
    this.capabilities = createStorageCapabilities({
      savepoints: options.savepoints ?? true,
      json: true,
      fullTextSearch: true,
      stemming: false,
      onlineBackup: true,
      wal: true,
      watch: false,
    });
    this.#now = options.now ?? (() => new Date());
    this.#delays = {
      openMs: delayValue(options.delays?.openMs, "openMs", 60_000),
      healthCheckMs: delayValue(options.delays?.healthCheckMs, "healthCheckMs", 60_000),
      operationMs: delayValue(options.delays?.operationMs, "operationMs", 60_000),
      transactionMs: delayValue(options.delays?.transactionMs, "transactionMs", 60_000),
    };
    this.#busyTimeoutMs = busyTimeoutValue(options.busyTimeoutMs);
    this.#busyRetry = {
      maxAttempts: Math.max(1, retryValue(options.busyRetry?.maxAttempts, "maxAttempts", 5, 20)),
      baseDelayMs: retryValue(options.busyRetry?.baseDelayMs, "baseDelayMs", 5, 1_000),
      maxDelayMs: retryValue(options.busyRetry?.maxDelayMs, "maxDelayMs", 50, 5_000),
    };
    this.databasePath = resolveDatabasePath({
      ...options,
      dataDirectory: options.dataDirectory ?? resolveDataDirectory(options),
    });
    this.dataDirectory = path.dirname(this.databasePath);

    const stores = this.#createStores(this.#outsideRunner());

    this.documents = stores.documents;
    this.links = stores.links;
    this.pluginStates = stores.pluginStates;
    this.migrations = stores.migrations;
    this.searchIndex = stores.searchIndex;
  }

  async open(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      if (this.#opened && this.#database !== null) {
        return;
      }

      await this.#delay(this.#delays.openMs);

      try {
        mkdirSync(this.dataDirectory, { recursive: true });
      } catch (error) {
        throw sqliteError("INVALID_ARGUMENT", "Каталог данных недоступен для записи", {
          details: { reason: "path" },
          cause: error,
        });
      }

      let database: Database.Database | undefined;

      try {
        database = new Database(this.databasePath);
        database.pragma("journal_mode = WAL");
        database.pragma("foreign_keys = ON");
        database.pragma(`busy_timeout = ${this.#busyTimeoutMs}`);
        database.pragma("synchronous = NORMAL");
        // До применения миграции создаётся только минимальный журнал,
        // необходимый runner-у. Версионируемая схема появляется в migration.up
        // одной транзакцией вместе с checksum-записью.
        database.exec("BEGIN IMMEDIATE");

        try {
          database.exec(JOURNAL_SCHEMA_SQL);
          database.exec("COMMIT");
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // Первичная ошибка важнее ошибки rollback.
          }

          throw error;
        }

        this.#database = database;
        this.#opened = true;
      } catch (error) {
        try {
          database?.close();
        } catch {
          // Ошибка cleanup не затирает первичную причину.
        }

        throw toStorageError(error);
      }
    });
  }

  async close(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      this.#opened = false;
      await this.#waitForBackups();

      const database = this.#database;
      this.#database = null;

      if (database === null) {
        return;
      }

      let checkpointFailure: ReturnType<typeof toStorageError> | null = null;

      try {
        const rows = database.pragma("wal_checkpoint(TRUNCATE)") as readonly {
          readonly busy?: unknown;
        }[];
        const result = rows[0];

        if (result === undefined || Number(result.busy) !== 0) {
          checkpointFailure = sqliteError(
            "INTERNAL_ERROR",
            "WAL checkpoint при закрытии не завершён",
            {
              retryable: true,
              details: { reason: "busy" },
            },
          );
        }
      } catch (error) {
        checkpointFailure = toStorageError(error);
      }

      try {
        database.close();
      } catch (error) {
        throw toStorageError(error);
      }

      if (checkpointFailure !== null) {
        throw checkpointFailure;
      }
    });
  }

  async healthCheck(): Promise<StorageHealth> {
    return this.#mutex.runExclusive(async () => {
      await this.#delay(this.#delays.healthCheckMs);

      const checkedAt = currentUtcTimestamp(this.#now);

      if (!this.#opened || this.#database === null) {
        return { ok: false, backendId: this.backendId, checkedAt };
      }

      try {
        this.#database.prepare("SELECT 1 AS ok").get();
        const journalMode = String(this.#database.pragma("journal_mode", { simple: true }));

        return {
          ok: true,
          backendId: this.backendId,
          checkedAt,
          details: { journalMode, wal: journalMode === "wal" },
        };
      } catch {
        return { ok: false, backendId: this.backendId, checkedAt };
      }
    });
  }

  async diagnostics(): Promise<SqliteStorageDiagnostics> {
    return this.#mutex.runExclusive(async () => {
      await this.#delay(this.#delays.operationMs);
      this.#assertOpen();

      const database = this.#getDatabase();
      const journalMode = String(database.pragma("journal_mode", { simple: true }));
      const foreignKeys = Number(database.pragma("foreign_keys", { simple: true })) === 1;
      const busyTimeoutMs = Number(database.pragma("busy_timeout", { simple: true }));
      const synchronousCode = Number(database.pragma("synchronous", { simple: true }));
      const synchronous =
        synchronousCode === 0
          ? "OFF"
          : synchronousCode === 1
            ? "NORMAL"
            : synchronousCode === 2
              ? "FULL"
              : "EXTRA";

      return {
        backendId: this.backendId,
        databasePath: this.databasePath,
        dataDirectory: this.dataDirectory,
        journalMode,
        wal: journalMode === "wal",
        foreignKeys,
        busyTimeoutMs,
        synchronous,
      };
    });
  }

  async withTransaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T> {
    const release = await this.#mutex.acquire();

    try {
      await this.#delay(this.#delays.transactionMs);
      this.#assertOpen();
      await this.#beginImmediate();

      const scope = createTransactionScope(null);
      const scheduler = new TransactionScheduler();
      const transaction = this.#createTransaction(1, scope, scheduler);
      const outcome = await this.#runScopedCallback(scope, () => callback(transaction));

      if (outcome.failed) {
        this.#rollbackQuietly();
        scope.rolledBack = true;
        throw outcome.failure;
      }

      try {
        this.#getDatabase().exec("COMMIT");
      } catch (error) {
        this.#rollbackQuietly();
        scope.rolledBack = true;
        throw toStorageError(error);
      }

      return outcome.result;
    } finally {
      release();
    }
  }

  async createStore<TStore>(registration: StorageStoreRegistration<TStore>): Promise<TStore> {
    this.#assertStoreRegistration(registration);

    return registration.create(this);
  }

  /**
   * Online backup через SQLite `.backup()` на активном соединении.
   *
   * Мьютекс удерживается только для проверки и старта backup-а. Во время
   * самого копирования writes на том же соединении разрешены: SQLite
   * отражает их в backup-е. Close ждёт завершения активного backup-а.
   */
  async backupTo(
    destination: string,
    options: { readonly pagesPerStep?: number } = {},
  ): Promise<SqliteOnlineBackupResult> {
    // Проверяем исходную строку до resolve: URI/UNC не должны
    // нормализоваться в локальный путь.
    assertLocalFilesystemPath(destination, "destination");

    const targetPath = path.resolve(destination);
    const pagesPerStep = options.pagesPerStep ?? 100;

    if (!Number.isInteger(pagesPerStep) || pagesPerStep < 1 || pagesPerStep > 10_000) {
      throw sqliteError("INVALID_ARGUMENT", "pagesPerStep должен быть целым числом 1…10000");
    }

    if (
      isSameFilesystemPath(targetPath, this.databasePath) ||
      isSameFilesystemPath(targetPath, `${this.databasePath}-wal`) ||
      isSameFilesystemPath(targetPath, `${this.databasePath}-shm`) ||
      isSameFilesystemPath(targetPath, `${this.databasePath}-journal`)
    ) {
      throw sqliteError("INVALID_ARGUMENT", "Backup не может перезаписывать live-файлы базы", {
        details: { reason: "backup" },
      });
    }

    const parent = path.dirname(targetPath);

    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      throw sqliteError("INVALID_ARGUMENT", "Каталог backup-а недоступен для записи", {
        details: { reason: "path" },
        cause: error,
      });
    }

    // Существующий destination и его sidecar-файлы никогда не удаляются и не
    // перезаписываются. Ошибка возникает до создания временной копии.
    assertDestinationFree(targetPath, "Backup destination");

    let database: Database.Database;
    const tempPath = backupTempPath(targetPath);

    const release = await this.#mutex.acquire();

    try {
      await this.#delay(this.#delays.operationMs);
      this.#assertOpen();
      assertDestinationFree(targetPath, "Backup destination");

      removeOwnedFiles(tempPath);
      database = this.#getDatabase();
      this.#activeBackups += 1;
    } catch (error) {
      removeOwnedFiles(tempPath);
      throw error;
    } finally {
      release();
    }

    try {
      const metadata = await database.backup(tempPath, {
        progress: ({ remainingPages }) => Math.min(pagesPerStep, Math.max(1, remainingPages)),
      });

      checkpointBackupDatabase(tempPath);
      const integrity = verifyDatabaseIntegrity(tempPath, "INTERNAL_ERROR");

      // Повторная проверка перед публикацией: чужой файл, появившийся во
      // время копирования, остаётся нетронутым.
      assertDestinationFree(targetPath, "Backup destination");
      publishExclusive(tempPath, targetPath);

      return {
        path: targetPath,
        sizeBytes: statSync(targetPath).size,
        totalPages: metadata.totalPages,
        integrity: integrity.status,
        checkedAt: currentUtcTimestamp(this.#now),
      };
    } catch (error) {
      removeOwnedFiles(tempPath);
      throw toStorageError(error);
    } finally {
      this.#activeBackups -= 1;

      if (this.#activeBackups === 0) {
        const waiters = this.#backupWaiters.splice(0);

        for (const waiter of waiters) {
          waiter();
        }
      }
    }
  }

  #createStores(run: StoreRunner): StorageStoreScope {
    return {
      documents: createDocumentStore(() => this.#getDatabase(), run, this.#now),
      links: createLinkStore(() => this.#getDatabase(), run, this.#now),
      pluginStates: createPluginStateStore(() => this.#getDatabase(), run, this.#now),
      migrations: createMigrationStore(() => this.#getDatabase(), run),
      searchIndex: createSearchIndexStore(
        () => this.#getDatabase(),
        run,
        this.#now,
        this.capabilities.fullTextSearch ? "full-text" : "substring",
      ),
    };
  }

  #outsideRunner(): StoreRunner {
    return {
      read: <T>(operation: () => T): Promise<T> =>
        this.#mutex.runExclusive(async () => {
          await this.#delay(this.#delays.operationMs);
          this.#assertOpen();

          return this.#runRead(operation);
        }),
      write: <T>(operation: () => T): Promise<T> =>
        this.#mutex.runExclusive(async () => {
          await this.#delay(this.#delays.operationMs);
          this.#assertOpen();

          return this.#runWrite(operation);
        }),
    };
  }

  #transactionRunner(scope: TransactionScope, scheduler: TransactionScheduler): StoreRunner {
    const run = <T>(operation: () => T): Promise<T> => {
      if (!isScopeActive(scope)) {
        return Promise.reject(transactionClosedError());
      }

      const task = scheduler.runExclusive(scope, async () => {
        await this.#delay(this.#delays.operationMs);

        if (!isScopeActive(scope)) {
          throw transactionClosedError();
        }

        this.#assertOpen();

        try {
          return operation();
        } catch (error) {
          throw toStorageError(error);
        }
      });

      return this.#track(scope, task);
    };

    return { read: run, write: run };
  }

  #createTransaction(
    depth: number,
    scope: TransactionScope,
    scheduler: TransactionScheduler,
  ): SqliteStorageTransaction {
    const host: TransactionHost = {
      backendId: this.backendId,
      savepoints: this.capabilities.savepoints,
      scope,
      scheduler,
      transactionRunner: (transactionScope) => this.#transactionRunner(transactionScope, scheduler),
      createStores: (run) => this.#createStores(run),
      executeSavepoint: <T>(
        savepointDepth: number,
        parentScope: TransactionScope,
        callback: (transaction: StorageTransaction) => Promise<T>,
      ) => this.#executeSavepoint(savepointDepth, parentScope, callback, scheduler),
      track: <T>(trackedScope: TransactionScope, task: Promise<T>) =>
        this.#track(trackedScope, task),
      assertStoreRegistration: <T>(registration: StorageStoreRegistration<T>) =>
        this.#assertStoreRegistration(registration),
      execDdl: (sql) => this.#execDdl(sql),
    };

    return new SqliteStorageTransaction(host, depth);
  }

  async #executeSavepoint<T>(
    depth: number,
    parentScope: TransactionScope,
    callback: (transaction: StorageTransaction) => Promise<T>,
    scheduler: TransactionScheduler,
  ): Promise<T> {
    const child = createTransactionScope(parentScope);

    // Sibling-savepoint ждёт завершения текущей savepoint-области, а
    // parent-операции ждут child. Вложенный savepoint реентерабелен внутри
    // уже удерживаемой области.
    return scheduler.runExclusive(child, async () => {
      await this.#delay(this.#delays.transactionMs);

      if (!isScopeActive(parentScope)) {
        throw transactionClosedError();
      }

      this.#assertOpen();

      const database = this.#getDatabase();
      const savepointName = `kanbaner_savepoint_${depth}_${this.#savepointCounter}`;

      this.#savepointCounter += 1;

      try {
        database.exec(`SAVEPOINT ${savepointName}`);
      } catch (error) {
        throw toStorageError(error);
      }

      const transaction = this.#createTransaction(depth, child, scheduler);
      const outcome = await this.#runScopedCallback(child, () => callback(transaction));

      if (outcome.failed) {
        // Родитель может быть sealed, но ещё не откатился: он ждёт drain этой
        // tracked child-области. Восстанавливаем собственный savepoint, пока
        // фактического rollback предка не было.
        if (!hasRolledBackAncestor(parentScope)) {
          try {
            database.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            database.exec(`RELEASE SAVEPOINT ${savepointName}`);
          } catch (error) {
            if (!hasRolledBackAncestor(parentScope)) {
              throw toStorageError(error);
            }
          }
        }

        child.rolledBack = true;
        throw outcome.failure;
      }

      if (!hasRolledBackAncestor(parentScope)) {
        try {
          database.exec(`RELEASE SAVEPOINT ${savepointName}`);
        } catch (error) {
          throw toStorageError(error);
        }
      }

      return outcome.result;
    });
  }

  async #runScopedCallback<T>(
    scope: TransactionScope,
    callback: () => Promise<T>,
  ): Promise<ScopedOutcome<T>> {
    let failed = false;
    let failure: unknown;
    let result: T | undefined;

    try {
      result = await callback();
    } catch (error) {
      failed = true;
      failure = error;
    }

    scope.active = false;

    while (scope.pending.size > 0) {
      await Promise.allSettled([...scope.pending]);
    }

    return { failed, failure, result: result as T };
  }

  async #track<T>(scope: TransactionScope, task: Promise<T>): Promise<T> {
    scope.pending.add(task);

    try {
      return await task;
    } finally {
      scope.pending.delete(task);
    }
  }

  async #beginImmediate(): Promise<void> {
    let attempt = 1;

    for (;;) {
      try {
        this.#getDatabase().exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        if (!this.#shouldRetry(error, attempt)) {
          throw toStorageError(error, attempt);
        }

        await this.#delay(this.#backoff(attempt));
        attempt += 1;
      }
    }
  }

  async #runRead<T>(operation: () => T): Promise<T> {
    let attempt = 1;

    for (;;) {
      try {
        return operation();
      } catch (error) {
        if (!this.#shouldRetry(error, attempt)) {
          throw toStorageError(error, attempt);
        }

        await this.#delay(this.#backoff(attempt));
        attempt += 1;
      }
    }
  }

  async #runWrite<T>(operation: () => T): Promise<T> {
    let attempt = 1;

    for (;;) {
      try {
        return this.#beginAndRun(operation);
      } catch (error) {
        if (!this.#shouldRetry(error, attempt)) {
          throw toStorageError(error, attempt);
        }

        await this.#delay(this.#backoff(attempt));
        attempt += 1;
      }
    }
  }

  #beginAndRun<T>(operation: () => T): T {
    const database = this.#getDatabase();

    database.exec("BEGIN IMMEDIATE");

    try {
      const result = operation();

      database.exec("COMMIT");

      return result;
    } catch (error) {
      this.#rollbackQuietly();
      throw error;
    }
  }

  #shouldRetry(error: unknown, attempt: number): boolean {
    return attempt < this.#busyRetry.maxAttempts && isSqliteBusyError(error);
  }

  #backoff(attempt: number): number {
    return Math.min(this.#busyRetry.maxDelayMs, this.#busyRetry.baseDelayMs * 2 ** (attempt - 1));
  }

  #rollbackQuietly(): void {
    const database = this.#database;

    if (database === null) {
      return;
    }

    try {
      if (database.inTransaction) {
        database.exec("ROLLBACK");
      }
    } catch {
      // Первичная ошибка важнее ошибки rollback.
    }
  }

  #waitForBackups(): Promise<void> {
    if (this.#activeBackups === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.#backupWaiters.push(resolve);
    });
  }

  #execDdl(sql: string): void {
    this.#getDatabase().exec(sql);
  }

  #assertStoreRegistration<TStore>(registration: StorageStoreRegistration<TStore>): void {
    if (typeof registration !== "object" || registration === null) {
      throw sqliteError("INVALID_ARGUMENT", "Некорректная регистрация Store-контракта");
    }

    const contract = registration.contract;

    if (typeof contract !== "object" || contract === null || !isContractId(contract.id)) {
      throw sqliteError("INVALID_ARGUMENT", "Некорректный Store-контракт");
    }

    assertPositiveVersion(contract.version, "contract.version");

    if (typeof registration.create !== "function") {
      throw sqliteError("INVALID_ARGUMENT", "Store-контракт должен содержать create");
    }
  }

  #assertOpen(): void {
    if (!this.#opened || this.#database === null) {
      throw providerClosedError();
    }
  }

  #getDatabase(): Database.Database {
    if (this.#database === null) {
      throw providerClosedError();
    }

    return this.#database;
  }

  async #delay(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) {
      await Promise.resolve();

      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}

/** Создаёт SQLite provider. */
export function createSqliteStorageProvider(
  options: SqliteStorageProviderOptions = {},
): SqliteStorageProvider {
  return new SqliteStorageProvider(options);
}
