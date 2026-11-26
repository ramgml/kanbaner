/**
 * Реэкспорт публичных Storage-контрактов SDK для внутренних модулей ядра.
 *
 * Канонические типы и значения находятся в `@kanbaner/plugin-sdk`
 * (`packages/plugin-sdk/src/storage/**`). Ядро не дублирует контракт:
 * этот модуль только собирает используемые имена из корневого экспорта SDK.
 *
 * Модуль не входит в публичный barrel ядра, чтобы не пересекаться с
 * одноимённым портом `LinkStore` из `resources`.
 */
export type {
  AppliedMigration,
  BackendId,
  ContractId,
  JsonObject,
  JsonValue,
  LinkStore,
  LinkStoreAddResult,
  MigrationStore,
  PluginDocument,
  PluginDocumentDeleteOptions,
  PluginDocumentPutInput,
  PluginDocumentQuery,
  PluginDocumentSort,
  PluginDocumentStore,
  PluginId,
  PluginStatePutInput,
  PluginStateRecord,
  PluginStateStore,
  PluginVersion,
  Relation,
  ResourceLink,
  ResourceRef,
  SearchHit,
  SearchFilter,
  SearchIndexDocument,
  SearchIndexStore,
  SearchIndexStrategy,
  SearchQuery,
  StorageCapabilities,
  StorageHealth,
  StorageMigration,
  StorageMigrationContext,
  StorageProvider,
  StorageProviderInfo,
  StorageProviderRegistry,
  StorageStoreContract,
  StorageStoreRegistration,
  StorageStoreScope,
  StorageTransaction,
  UtcTimestamp,
} from "@kanbaner/plugin-sdk";

export { CORE_STORAGE_STORES, defineStorageStore } from "@kanbaner/plugin-sdk";
