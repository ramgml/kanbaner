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

interface StorageRuntimeHolder {
  [STORAGE_RUNTIME_KEY]?: {
    readonly key: string;
    readonly promise: Promise<ApplicationStorageRuntime>;
  };
}

interface ShutdownHolder {
  __kanbanerStorageShutdownHooks?: boolean;
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

function registerShutdownHooks(): void {
  if (globalHolder.__kanbanerStorageShutdownHooks === true) {
    return;
  }

  globalHolder.__kanbanerStorageShutdownHooks = true;

  const shutdown = (): void => {
    void closeApplicationStorage().catch(() => undefined);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("beforeExit", shutdown);
}

/**
 * Singleton Storage runtime для Next.js hot reload.
 *
 * Параллельные запросы разделяют один и тот же Promise и не открывают
 * дополнительные соединения. Ошибка инициализации сбрасывает singleton,
 * чтобы следующий запрос мог повторить попытку.
 */
export function getApplicationStorage(
  options: ApplicationStorageOptions = {},
): Promise<ApplicationStorageRuntime> {
  const key = storageSingletonKey(options);
  const existing = globalHolder[STORAGE_RUNTIME_KEY];

  if (existing !== undefined) {
    if (existing.key !== key) {
      return Promise.reject(
        new Error("Storage runtime уже инициализирован с другим каталогом данных"),
      );
    }

    return existing.promise;
  }

  registerShutdownHooks();

  const promise = createApplicationStorage(options).catch((error: unknown) => {
    if (globalHolder[STORAGE_RUNTIME_KEY]?.promise === promise) {
      Reflect.deleteProperty(globalHolder, STORAGE_RUNTIME_KEY);
    }

    throw error;
  });

  globalHolder[STORAGE_RUNTIME_KEY] = { key, promise };

  return promise;
}

/** Закрывает активный runtime и выполняет WAL checkpoint. */
export async function closeApplicationStorage(): Promise<void> {
  const existing = globalHolder[STORAGE_RUNTIME_KEY];

  if (existing === undefined) {
    return;
  }

  Reflect.deleteProperty(globalHolder, STORAGE_RUNTIME_KEY);

  const runtime = await existing.promise.catch(() => undefined);

  await runtime?.registry.closeAll();
}
