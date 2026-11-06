import type { StorageHealth, StorageMigration, StorageProvider } from "./contracts.ts";
import { StorageMigrationRunner, type StorageMigrationRunResult } from "./migrations.ts";
import { StorageProviderRegistry } from "./registry.ts";

export interface StorageBootstrapOptions {
  readonly registry: StorageProviderRegistry;
  readonly provider: StorageProvider;
  /** Инфраструктурные и плагинные миграции в детерминированном порядке. */
  readonly migrations?: readonly StorageMigration[];
  /** Источник UTC-времени для журнала миграций. */
  readonly now?: () => Date;
}

export interface StorageBootstrapResult {
  readonly provider: StorageProvider;
  readonly health: StorageHealth;
  readonly migrations: StorageMigrationRunResult;
}

/**
 * Bootstrap Storage-слоя.
 *
 * Порядок обязателен: регистрация провайдера, открытие, health check, затем
 * миграции. Ошибка регистрации или открытия не запускает ни одной миграции,
 * поэтому частичного применения не возникает.
 */
export async function bootstrapStorage(
  options: StorageBootstrapOptions,
): Promise<StorageBootstrapResult> {
  const { registry, provider } = options;

  registry.register(provider);

  const opened = await registry.open(provider.backendId);
  const health = await opened.healthCheck();
  const runner = new StorageMigrationRunner(
    opened,
    options.now === undefined ? {} : { now: options.now },
  );
  const migrations = await runner.run(options.migrations ?? []);

  return { provider: opened, health, migrations };
}
