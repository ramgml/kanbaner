import type { BackendId } from "./common.ts";
import type { PluginDocumentStore } from "./documents.ts";

/**
 * Документы, доступные плагину в текущей транзакционной области.
 *
 * Фасад не раскрывает links, searchIndex, migrations, pluginStates,
 * createStore и управление соединением: это инфраструктура composition root.
 */
export interface PluginStorageTransaction {
  readonly documents: PluginDocumentStore;
}

/**
 * Плагинный фасад Storage Provider.
 *
 * Все операции Store привязаны к plugin ID активируемого плагина: передать
 * чужой `pluginId` нельзя. `withTransaction` выполняет callback в транзакции
 * активного provider-а и передаёт только разрешённый набор Store.
 */
export interface PluginStorage {
  readonly backendId: BackendId;
  readonly documents: PluginDocumentStore;
  withTransaction<T>(callback: (transaction: PluginStorageTransaction) => Promise<T>): Promise<T>;
}
