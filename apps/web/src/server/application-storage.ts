import {
  bootstrapStorage,
  StorageMigrationRunner,
  StorageProviderRegistry,
  type StorageMigrationRunResult,
} from "@kanbaner/kernel";
import type { StorageHealth, StorageMigration, StorageProvider } from "@kanbaner/plugin-sdk";
import {
  createCoreInfrastructureMigrations,
  createSqliteStorageProvider,
  resolveDatabasePath,
} from "@kanbaner/storage-sqlite";

const STORAGE_RUNTIME_KEY = "__kanbanerWebStorageRuntimeV1";

export interface ApplicationStorageOptions {
  readonly dataDirectory?: string;
  readonly databaseFileName?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Миграции остальных плагинов; инфраструктурные выполняются всегда первыми. */
  readonly pluginMigrations?: readonly StorageMigration[];
  /** Готовый провайдер для тестов; по умолчанию создаётся SQLite provider. */
  readonly provider?: StorageProvider;
}

export interface ApplicationStorageRuntime {
  readonly registry: StorageProviderRegistry;
  readonly provider: StorageProvider;
  readonly health: StorageHealth;
  readonly infrastructure: StorageMigrationRunResult;
  readonly plugins: StorageMigrationRunResult;
}

interface StorageRuntimeEntry {
  readonly key: string;
  readonly promise: Promise<ApplicationStorageRuntime>;
  closing: Promise<void> | null;
}

interface StorageRuntimeHolder {
  [STORAGE_RUNTIME_KEY]?: StorageRuntimeEntry;
}

interface ShutdownHolder {
  __kanbanerStorageShuttingDown?: boolean;
  /** Мост для production custom server: await-able close + checkpoint. */
  __kanbanerStorageShutdown?: (() => Promise<void>) | null;
}

const globalHolder = globalThis as typeof globalThis & StorageRuntimeHolder & ShutdownHolder;

/**
 * Composition root Storage-слоя приложения.
 *
 * Порядок обязателен:
 * 1. регистрация провайдера;
 * 2. открытие и ровно один health check (`openChecked` внутри bootstrap);
 * 3. инфраструктурные миграции core-таблиц;
 * 4. миграции остальных плагинов.
 *
 * Ошибка открытия или любой миграции закрывает провайдер и не оставляет
 * частично применённого набора.
 */
export async function createApplicationStorage(
  options: ApplicationStorageOptions = {},
): Promise<ApplicationStorageRuntime> {
  const registry = new StorageProviderRegistry();
  const provider =
    options.provider ??
    createSqliteStorageProvider({
      ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
      ...(options.databaseFileName === undefined
        ? {}
        : { databaseFileName: options.databaseFileName }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

  const bootstrap = await bootstrapStorage({
    registry,
    provider,
    migrations: createCoreInfrastructureMigrations(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  try {
    const plugins = await new StorageMigrationRunner(bootstrap.provider, {
      health: bootstrap.health,
      ...(options.now === undefined ? {} : { now: options.now }),
    }).run(options.pluginMigrations ?? []);

    return {
      registry,
      provider: bootstrap.provider,
      health: bootstrap.health,
      infrastructure: bootstrap.migrations,
      plugins,
    };
  } catch (error) {
    try {
      await registry.closeAll();
    } catch {
      // Первичная ошибка миграции важнее ошибки cleanup.
    }

    throw error;
  }
}

function storageSingletonKey(options: ApplicationStorageOptions): string {
  return resolveDatabasePath({
    ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
    ...(options.databaseFileName === undefined
      ? {}
      : { databaseFileName: options.databaseFileName }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

/**
 * Регистрирует мост для production custom server.
 *
 * Signal-handling живёт в `apps/web/scripts/server.mjs`: сначала сервер
 * прекращает приём запросов и дожидается активных, затем вызывает этот
 * await-able bridge, который закрывает provider и выполняет WAL checkpoint.
 * Promise не сохраняется в globalThis в расчёте на то, что Next его дождётся.
 */
globalHolder.__kanbanerStorageShutdown = () => shutdownApplicationStorage();

/**
 * Singleton Storage runtime для Next.js hot reload.
 *
 * Параллельные запросы разделяют один и тот же Promise и не открывают
 * дополнительные соединения. Пока идёт close, новый get ждёт его завершения
 * и только затем создаёт runtime. Ошибка инициализации сбрасывает singleton,
 * чтобы следующий запрос мог повторить попытку.
 */
export function getApplicationStorage(
  options: ApplicationStorageOptions = {},
): Promise<ApplicationStorageRuntime> {
  if (globalHolder.__kanbanerStorageShuttingDown === true) {
    return Promise.reject(new Error("Storage runtime остановлен"));
  }

  const key = storageSingletonKey(options);
  const existing = globalHolder[STORAGE_RUNTIME_KEY];

  if (existing !== undefined) {
    if (existing.key !== key) {
      return Promise.reject(
        new Error("Storage runtime уже инициализирован с другим каталогом данных"),
      );
    }

    if (existing.closing !== null) {
      return existing.closing.then(() => getApplicationStorage(options));
    }

    return existing.promise;
  }

  const promise = createApplicationStorage(options).catch((error: unknown) => {
    if (globalHolder[STORAGE_RUNTIME_KEY] === entry) {
      Reflect.deleteProperty(globalHolder, STORAGE_RUNTIME_KEY);
    }

    throw error;
  });
  const entry: StorageRuntimeEntry = { key, promise, closing: null };

  globalHolder[STORAGE_RUNTIME_KEY] = entry;

  return promise;
}

/**
 * Закрывает активный runtime и выполняет WAL checkpoint.
 *
 * Повторный вызов разделяет тот же `closing` Promise. Запись singleton-а
 * удаляется только после успешного закрытия, поэтому get во время close
 * ждёт и не открывает второе соединение с тем же каталогом.
 */
export async function closeApplicationStorage(): Promise<void> {
  const existing = globalHolder[STORAGE_RUNTIME_KEY];

  if (existing === undefined) {
    return;
  }

  if (existing.closing !== null) {
    return existing.closing;
  }

  const closing = (async () => {
    const runtime = await existing.promise.catch(() => null);

    try {
      if (runtime !== null) {
        await runtime.registry.closeAll();
      }
    } finally {
      // Запись удаляется только после попытки close: get во время close
      // дождался этого Promise и не открыл второе соединение.
      if (globalHolder[STORAGE_RUNTIME_KEY] === existing) {
        Reflect.deleteProperty(globalHolder, STORAGE_RUNTIME_KEY);
      }
    }
  })();

  existing.closing = closing;

  try {
    await closing;
  } finally {
    if (existing.closing === closing) {
      existing.closing = null;
    }
  }
}

/**
 * Останавливает приём новых runtime-ов, дожидается текущих и выполняет close.
 *
 * Возвращает await-able Promise; signal-handler сохраняет его, чтобы checkpoint
 * не терялся при завершении процесса.
 */
export function shutdownApplicationStorage(): Promise<void> {
  globalHolder.__kanbanerStorageShuttingDown = true;

  return closeApplicationStorage();
}

/**
 * @internal Сбрасывает singleton и shutdown-состояние между тестами.
 *
 * Не закрывает активный runtime: вызывающий обязан сначала дождаться
 * `closeApplicationStorage()`.
 */
export function resetApplicationStorageForTests(): void {
  Reflect.deleteProperty(globalHolder, STORAGE_RUNTIME_KEY);
  globalHolder.__kanbanerStorageShuttingDown = false;
  globalHolder.__kanbanerStorageShutdown = () => shutdownApplicationStorage();
}
