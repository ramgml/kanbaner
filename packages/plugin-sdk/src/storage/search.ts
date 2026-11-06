import type { JsonObject } from "../json.ts";
import type { PluginId } from "../plugin-id.ts";
import type { ResourceRef } from "../resources.ts";
import type { UtcTimestamp } from "./time.ts";

/**
 * Стратегия поиска индекса.
 *
 * `full-text` означает, что backend поддерживает полнотекстовый индекс
 * (например, FTS5). `substring` — документированный fallback без FTS:
 * регистронезависимый поиск подстроки по нормализованному тексту. Векторный
 * поиск, embeddings и семантический индекс не входят в контракт.
 */
export type SearchIndexStrategy = "full-text" | "substring";

/** Нормализованный документ поискового индекса без доменных типов. */
export interface SearchIndexDocument {
  readonly ref: ResourceRef;
  readonly pluginId: PluginId;
  readonly title: string;
  readonly text: string;
  readonly kind?: string;
  readonly projectRef?: ResourceRef;
  readonly updatedAt?: UtcTimestamp;
  readonly metadata?: JsonObject;
}

export interface SearchQuery {
  readonly text: string;
  readonly pluginId?: PluginId;
  readonly kind?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchHit {
  readonly ref: ResourceRef;
  readonly title: string;
  readonly excerpt: string;
  readonly score: number;
  readonly strategy: SearchIndexStrategy;
}

/**
 * Асинхронный поисковый индекс плагина поиска.
 *
 * Провайдер объявляет capability `fullTextSearch`. При её отсутствии
 * используется стратегия `substring`; контракт остаётся одинаковым.
 * `reindex` полностью заменяет индекс переданным набором документов и служит
 * восстановлению после пропущенных событий.
 */
export interface SearchIndexStore {
  readonly strategy: SearchIndexStrategy;
  upsert(documents: readonly SearchIndexDocument[]): Promise<number>;
  delete(ref: ResourceRef): Promise<boolean>;
  deleteMany(refs: readonly ResourceRef[]): Promise<number>;
  clear(pluginId?: PluginId): Promise<number>;
  search(query: SearchQuery): Promise<readonly SearchHit[]>;
  list(): Promise<readonly SearchIndexDocument[]>;
  reindex(documents: readonly SearchIndexDocument[]): Promise<number>;
}
