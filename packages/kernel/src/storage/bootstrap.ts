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
 * Порядок обязателен: регистрация провайдера, открытие с одним health check,
 * затем миграции. Bootstrap использует проверенный `StorageHealth`, полученный
 * при открытии, и не выполняет второй health check.
 *
 * При ошибке миграции провайдер закрывается, активный backend очищается, а
 * исходная ошибка сохраняется даже если cleanup завершился ошибкой.
 */
export async function bootstrapStorage(
  options: StorageBootstrapOptions,
): Promise<StorageBootstrapResult> {
  const { registry, provider } = options;

  registry.register(provider);

  const opened = await registry.openChecked(provider.backendId);
  const runner = new StorageMigrationRunner(opened.provider, {
    health: opened.health,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  try {
    const migrations = await runner.run(options.migrations ?? []);

    return { provider: opened.provider, health: opened.health, migrations };
  } catch (error) {
    try {
      await registry.close(opened.provider.backendId);
    } catch {
      // Первичная ошибка миграции важнее ошибки cleanup.
    }

    throw error;
  }
}
