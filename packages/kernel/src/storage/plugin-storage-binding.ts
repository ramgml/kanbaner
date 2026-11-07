import type {
  PluginDocument,
  PluginDocumentDeleteOptions,
  PluginDocumentPutInput,
  PluginDocumentQuery,
  PluginDocumentStore,
  PluginId,
  PluginStorage,
  StorageProvider,
  StorageStoreScope,
} from "@kanbaner/plugin-sdk";

import { OperationFailure } from "../operations/errors.ts";

function denied(): OperationFailure {
  return new OperationFailure("PERMISSION_DENIED", "Storage-операция другого плагина запрещена");
}

function assertOwned(actual: PluginId, expected: PluginId): void {
  if (actual !== expected) {
    throw denied();
  }
}

function bindDocuments(documents: PluginDocumentStore, pluginId: PluginId): PluginDocumentStore {
  return {
    async get(
      requestedPluginId: PluginId,
      collection: string,
      id: string,
    ): Promise<PluginDocument | null> {
      assertOwned(requestedPluginId, pluginId);

      return documents.get(pluginId, collection, id);
    },
    async put(input: PluginDocumentPutInput): Promise<PluginDocument> {
      assertOwned(input.pluginId, pluginId);

      return documents.put({ ...input, pluginId });
    },
    async delete(
      requestedPluginId: PluginId,
      collection: string,
      id: string,
      options?: PluginDocumentDeleteOptions,
    ): Promise<boolean> {
      assertOwned(requestedPluginId, pluginId);

      return documents.delete(pluginId, collection, id, options);
    },
    async query(query: PluginDocumentQuery): Promise<readonly PluginDocument[]> {
      assertOwned(query.pluginId, pluginId);

      return documents.query({ ...query, pluginId });
    },
    async list(
      requestedPluginId: PluginId,
      collection?: string,
    ): Promise<readonly PluginDocument[]> {
      assertOwned(requestedPluginId, pluginId);

      return documents.list(pluginId, collection);
    },
  };
}

/**
 * Привязывает Storage Provider к plugin ID.
 *
 * Плагин получает только documents и transaction-scoped documents. Open,
 * close, migrations, pluginStates, raw links, search и createStore не
 * доступны. Каждая операция проверяет pluginId, поэтому чужой namespace
 * недоступен даже при прямом вызове.
 */
export function bindPluginStorage(provider: StorageProvider, pluginId: PluginId): PluginStorage {
  return {
    backendId: provider.backendId,
    documents: bindDocuments(provider.documents, pluginId),
    withTransaction<T>(
      callback: (transaction: { readonly documents: PluginDocumentStore }) => Promise<T>,
    ): Promise<T> {
      return provider.withTransaction(async (transaction: StorageStoreScope) =>
        callback({ documents: bindDocuments(transaction.documents, pluginId) }),
      );
    },
  };
}
