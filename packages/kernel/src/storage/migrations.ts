import { createHash } from "node:crypto";

import type { PluginMigrationContext } from "../lifecycle/hooks.ts";
import type {
  AppliedMigration,
  BackendId,
  StorageHealth,
  StorageMigration,
  StorageProvider,
} from "./contracts.ts";
import { isStorageOperationError, safeStorageErrorName, storageError } from "./errors.ts";
import { assertPluginIdValue, assertPositiveVersion, currentUtcTimestamp } from "./validation.ts";

export interface StorageMigrationRunResult {
  readonly backendId: BackendId;
  readonly applied: readonly AppliedMigration[];
  readonly skipped: readonly AppliedMigration[];
}

export interface StorageMigrationRunnerOptions {
  readonly now?: () => Date;
  /** Уже проверенный health от bootstrap; заменяет повторный health check. */
  readonly health?: StorageHealth;
}

/** Загрузчик миграций плагина для lifecycle hook KAN-003. */
export interface PluginMigrationLoader {
  load(context: PluginMigrationContext): Promise<readonly StorageMigration[]>;
}

function compareMigrations(left: StorageMigration, right: StorageMigration): number {
  if (left.pluginId !== right.pluginId) {
    return left.pluginId < right.pluginId ? -1 : 1;
  }

  if (left.version !== right.version) {
    return left.version - right.version;
  }

  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** SHA-256 стабильного содержимого миграции. */
export function computeMigrationChecksum(migration: StorageMigration): string {
  return createHash("sha256")
    .update(JSON.stringify([migration.version, migration.name, migration.source]), "utf8")
    .digest("hex");
}

/**
 * Backend-neutral runner миграций.
 *
 * Проверяет вход до любых изменений, сортирует миграции детерминированно,
 * пропускает уже применённые с тем же checksum и блокирует несовпадение.
 * Каждая миграция и запись журнала фиксируются в одной транзакции; ошибка
 * откатывает изменения и не оставляет частичного результата.
 */
export class StorageMigrationRunner {
  readonly #provider: StorageProvider;
  readonly #now: () => Date;
  readonly #health: StorageHealth | undefined;

  constructor(provider: StorageProvider, options: StorageMigrationRunnerOptions = {}) {
    this.#provider = provider;
    this.#now = options.now ?? (() => new Date());
    this.#health = options.health;
  }

  async run(migrations: readonly StorageMigration[]): Promise<StorageMigrationRunResult> {
    const ordered = this.#prepare(migrations);
    const health = this.#health ?? (await this.#provider.healthCheck());

    if (!health.ok) {
      throw storageError("PROVIDER_NOT_READY", "Storage Provider не готов к миграциям", {
        details: { backendId: this.#provider.backendId },
      });
    }

    const backendId = this.#provider.backendId;
    const applied: AppliedMigration[] = [];
    const skipped: AppliedMigration[] = [];

    for (const migration of ordered) {
      const checksum = computeMigrationChecksum(migration);
      const existing = await this.#provider.migrations.find(
        backendId,
        migration.pluginId,
        migration.version,
      );

      if (existing !== null) {
        if (existing.checksum !== checksum) {
          throw this.#checksumMismatch(migration, existing);
        }

        skipped.push(existing);
        continue;
      }

      let skippedInsideTransaction: AppliedMigration | null = null;
      let recorded: AppliedMigration | null = null;

      try {
        await this.#provider.withTransaction(async (transaction) => {
          const current = await transaction.migrations.find(
            backendId,
            migration.pluginId,
            migration.version,
          );

          if (current !== null) {
            if (current.checksum !== checksum) {
              throw this.#checksumMismatch(migration, current);
            }

            skippedInsideTransaction = current;
            return;
          }

          await migration.up({
            backendId,
            pluginId: migration.pluginId,
            version: migration.version,
            name: migration.name,
            transaction,
            store: transaction.migrations,
          });

          const appliedMigration: AppliedMigration = {
            backendId,
            pluginId: migration.pluginId,
            version: migration.version,
            name: migration.name,
            checksum,
            appliedAt: currentUtcTimestamp(this.#now),
          };

          await transaction.migrations.record(appliedMigration);
          recorded = appliedMigration;
        });
      } catch (error) {
        if (isStorageOperationError(error) && error.code === "MIGRATION_CHECKSUM_MISMATCH") {
          throw error;
        }

        throw storageError("MIGRATION_FAILED", "Миграция не применена", {
          details: {
            backendId,
            pluginId: migration.pluginId,
            version: migration.version,
            name: migration.name,
            errorName: safeStorageErrorName(error),
          },
          cause: error,
        });
      }

      if (skippedInsideTransaction !== null) {
        skipped.push(skippedInsideTransaction);
      } else if (recorded !== null) {
        applied.push(recorded);
      }
    }

    return { backendId, applied, skipped };
  }

  #prepare(migrations: readonly StorageMigration[]): readonly StorageMigration[] {
    const seen = new Set<string>();

    for (const migration of migrations) {
      assertPluginIdValue(migration.pluginId);
      assertPositiveVersion(migration.version, "version");

      if (typeof migration.name !== "string" || migration.name.trim().length === 0) {
        throw storageError("INVALID_MIGRATION", "Имя миграции не может быть пустым");
      }

      if (typeof migration.source !== "string" || migration.source.length === 0) {
        throw storageError("INVALID_MIGRATION", "Содержимое миграции не может быть пустым");
      }

      if (typeof migration.up !== "function") {
        throw storageError("INVALID_MIGRATION", "Миграция должна содержать up");
      }

      const key = `${migration.pluginId}@${migration.version}`;

      if (seen.has(key)) {
        throw storageError("INVALID_MIGRATION", "Версия миграции повторяется", {
          details: { pluginId: migration.pluginId, version: migration.version },
        });
      }

      seen.add(key);
    }

    return [...migrations].sort(compareMigrations);
  }

  #checksumMismatch(migration: StorageMigration, existing: AppliedMigration): Error {
    return storageError(
      "MIGRATION_CHECKSUM_MISMATCH",
      "Checksum применённой миграции не совпадает",
      {
        details: {
          backendId: existing.backendId,
          pluginId: migration.pluginId,
          version: migration.version,
          expectedChecksum: computeMigrationChecksum(migration),
          actualChecksum: existing.checksum,
        },
      },
    );
  }
}

/**
 * Адаптер lifecycle hook KAN-003.
 *
 * Hook получает только путь к каталогу миграций; конкретный loader читает
 * backend-зависимые файлы. Чужие Plugin ID отклоняются до записи.
 */
export function createPluginMigrationHook(
  runner: StorageMigrationRunner,
  loader: PluginMigrationLoader,
): (context: PluginMigrationContext) => Promise<void> {
  return async (context: PluginMigrationContext): Promise<void> => {
    if (context.migrationsPath === null) {
      return;
    }

    const migrations = await loader.load(context);

    for (const migration of migrations) {
      if (migration.pluginId !== context.pluginId) {
        throw storageError("INVALID_MIGRATION", "Миграция принадлежит другому плагину", {
          details: { pluginId: migration.pluginId, expectedPluginId: context.pluginId },
        });
      }
    }

    await runner.run(migrations);
  };
}
