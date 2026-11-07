/**
 * Публичный API SQLite Storage Provider.
 *
 * Пакет реализует backend-специфичную часть Storage-слоя. SDK и ядро не
 * зависят от него; composition root приложения регистрирует провайдер при
 * bootstrap.
 */
export const SQLITE_BACKEND_ID = "sqlite" as const;

export {
  createSqliteStorageProvider,
  SqliteStorageProvider,
  type SqliteBusyRetryOptions,
  type SqliteOnlineBackupResult,
  type SqliteStorageDelays,
  type SqliteStorageDiagnostics,
  type SqliteStorageProviderOptions,
} from "./provider.ts";

export { getSqliteStorageProvider, resetSqliteStorageSingleton } from "./singleton.ts";

export { createCoreInfrastructureMigrations } from "./infrastructure-migrations.ts";

export {
  CORE_INFRASTRUCTURE_NAME,
  CORE_INFRASTRUCTURE_PLUGIN_ID,
  CORE_INFRASTRUCTURE_VERSION,
} from "./schema.ts";

export {
  DEFAULT_DATABASE_FILE_NAME,
  assertDatabaseFileName,
  assertLocalFilesystemPath,
  isSameFilesystemPath,
  resolveDataDirectory,
  resolveDatabasePath,
  resolveDefaultDataDirectory,
  type DataDirectoryOptions,
  type DatabasePathOptions,
} from "./paths.ts";

export {
  SEARCH_NORMALIZER_VERSION,
  buildSearchExcerpt,
  normalizeSearchQuery,
  normalizeSearchText,
  tokenizeSearchText,
  type NormalizedSearchQuery,
} from "./normalizer.ts";

export {
  isPluginNamespaceTable,
  pluginNamespacePrefix,
  pluginNamespaceTable,
} from "./namespaces.ts";

export {
  restoreDatabase,
  verifyDatabaseIntegrity,
  type IntegrityCheckResult,
  type RestoreDatabaseOptions,
  type RestoreDatabaseResult,
} from "./backup.ts";
