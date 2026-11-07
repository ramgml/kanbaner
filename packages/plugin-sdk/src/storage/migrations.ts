import type { PluginId } from "../plugin-id.ts";
import type { BackendId } from "./common.ts";
import type { StorageTransaction } from "./provider.ts";
import type { UtcTimestamp } from "./time.ts";

/**
 * Запись о применённой миграции.
 *
 * Ключ истории — `(backendId, pluginId, version, checksum)`. Проверка
 * checksum выполняется runner-ом до повторного применения.
 */
export interface AppliedMigration {
  readonly backendId: BackendId;
  readonly pluginId: PluginId;
  /** Монотонный номер миграции внутри плагина. */
  readonly version: number;
  readonly name: string;
  /** SHA-256 в нижнем hex-регистре. */
  readonly checksum: string;
  readonly appliedAt: UtcTimestamp;
}

/**
 * Асинхронный журнал миграций backend.
 *
 * Запись должна быть атомарной: `record` либо создаёт ровно одну запись, либо
 * сообщает о конфликте. Повторная запись с тем же ключом и checksum
 * идемпотентна, с другим checksum — ошибка `MIGRATION_CHECKSUM_MISMATCH`.
 */
export interface MigrationStore {
  list(backendId?: BackendId): Promise<readonly AppliedMigration[]>;
  find(backendId: BackendId, pluginId: PluginId, version: number): Promise<AppliedMigration | null>;
  record(migration: AppliedMigration): Promise<void>;
}

/** Контекст выполнения одной миграции внутри транзакции провайдера. */
export interface StorageMigrationContext {
  readonly backendId: BackendId;
  readonly pluginId: PluginId;
  readonly version: number;
  readonly name: string;
  /** Транзакция, в которой миграция и запись журнала фиксируются атомарно. */
  readonly transaction: StorageTransaction;
  /** Журнал, связанный с той же транзакцией. */
  readonly store: MigrationStore;
}

/**
 * Backend-зависимая миграция плагина.
 *
 * `source` — стабильное содержимое миграции (например, версия файла или DDL
 * конкретного провайдера). Runner вычисляет по нему SHA-256; сам контракт не
 * содержит SQL.
 */
export interface StorageMigration {
  readonly pluginId: PluginId;
  readonly version: number;
  readonly name: string;
  readonly source: string;
  up(context: StorageMigrationContext): Promise<void>;
}
