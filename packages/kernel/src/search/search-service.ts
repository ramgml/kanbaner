import {
  parseResourceRef,
  toSearchDocument,
  type PluginId,
  type ResourceRef,
  type SearchHit,
  type SearchIndexDocument,
  type SearchIndexStore,
  type SearchQuery,
  type SearchRegistrar,
  type SearchDocumentInput,
} from "@kanbaner/plugin-sdk";

import { OperationFailure } from "../operations/errors.ts";

function denied(): OperationFailure {
  return new OperationFailure("PERMISSION_DENIED", "Поисковый индекс другого плагина недоступен");
}

function assertRefOwnedBy(ref: ResourceRef, pluginId: PluginId): void {
  const parts = parseResourceRef(ref);

  if (parts.pluginId !== pluginId) {
    throw denied();
  }
}

/**
 * Хост-реализация поискового контракта поверх активного SearchIndexStore.
 *
 * Каждая операция принимает ответственный pluginId от доверенного runtime.
 * Плагин получает только bound-фасад `PluginSearchService`.
 */
export class KernelSearchService implements SearchRegistrar {
  readonly #store: SearchIndexStore;

  constructor(store: SearchIndexStore) {
    this.#store = store;
  }

  async upsert(pluginId: PluginId, documents: readonly SearchDocumentInput[]): Promise<number> {
    const normalized = documents.map((document) => toSearchDocument(pluginId, document));

    return normalized.length === 0 ? 0 : this.#store.upsert(normalized);
  }

  async delete(pluginId: PluginId, ref: ResourceRef): Promise<boolean> {
    assertRefOwnedBy(ref, pluginId);

    return this.#store.delete(ref);
  }

  async list(pluginId: PluginId): Promise<readonly SearchIndexDocument[]> {
    const documents = await this.#store.list();

    return documents.filter((document) => document.pluginId === pluginId);
  }

  async search(
    pluginId: PluginId,
    query: Omit<SearchQuery, "pluginId">,
  ): Promise<readonly SearchHit[]> {
    return this.#store.search({ ...query, pluginId });
  }

  /**
   * Полностью переиндексирует документы одного плагина.
   *
   * Raw `reindex` заменяет весь индекс, поэтому чужие документы сохраняются
   * явно: плагин не может стереть поисковый индекс другого плагина.
   */
  async reindex(pluginId: PluginId, documents: readonly SearchDocumentInput[]): Promise<number> {
    const normalized = documents.map((document) => toSearchDocument(pluginId, document));
    const existing = await this.#store.list();
    const foreign = existing.filter((document) => document.pluginId !== pluginId);

    return this.#store.reindex([...foreign, ...normalized]);
  }
}

export function createSearchService(store: SearchIndexStore): SearchRegistrar {
  return new KernelSearchService(store);
}
