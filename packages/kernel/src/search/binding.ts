import {
  parseResourceRef,
  toSearchDocument,
  type PluginId,
  type PluginSearchService,
  type ResourceRef,
  type SearchAggregateResult,
  type SearchDocumentInput,
  type SearchFacetSet,
  type SearchHit,
  type SearchIndexDocument,
  type SearchProvider,
  type SearchProviderQuery,
  type SearchQuery,
  type SearchRegistrar,
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

function normalizeDocuments(
  pluginId: PluginId,
  documents: readonly SearchDocumentInput[],
): readonly SearchDocumentInput[] {
  for (const document of documents) {
    assertRefOwnedBy(document.ref, pluginId);
  }

  return documents.map((document) => toSearchDocument(pluginId, document));
}

/**
 * Привязывает поисковый сервис к namespace-у активируемого плагина.
 *
 * Bound-фасад не принимает `pluginId`: подстановка выполняется здесь, а
 * ResourceRef каждого документа проверяется на принадлежность плагину.
 * SearchProvider регистрируется только под собственным ID плагина.
 */
export function bindPluginSearch(search: SearchRegistrar, pluginId: PluginId): PluginSearchService {
  return {
    async upsert(documents: readonly SearchDocumentInput[]): Promise<number> {
      const normalized = normalizeDocuments(pluginId, documents);

      return normalized.length === 0 ? 0 : search.upsert(pluginId, normalized);
    },
    async delete(ref: ResourceRef): Promise<boolean> {
      assertRefOwnedBy(ref, pluginId);

      return search.delete(pluginId, ref);
    },
    list(): Promise<readonly SearchIndexDocument[]> {
      return Promise.resolve(search.list(pluginId));
    },
    search(query: Omit<SearchQuery, "pluginId">): Promise<readonly SearchHit[]> {
      return search.search(pluginId, query);
    },
    async reindex(documents: readonly SearchDocumentInput[]): Promise<number> {
      return search.reindex(pluginId, normalizeDocuments(pluginId, documents));
    },
    registerProvider(provider: SearchProvider): void {
      if (provider.id !== pluginId) {
        throw denied();
      }

      search.registerProvider(pluginId, provider);
    },
    unregisterProviders(): void {
      search.unregisterProviders(pluginId);
    },
    aggregate(query: SearchProviderQuery): Promise<SearchAggregateResult> {
      return search.aggregate(query);
    },
    listFacets(): Promise<SearchFacetSet> {
      return search.listFacets();
    },
  };
}
