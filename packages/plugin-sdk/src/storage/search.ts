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
  readonly updatedAt?: UtcTimestamp;
  readonly metadata?: JsonObject;
}

/**
 * Оператор фильтра публичных метаданных поискового документа.
 *
 * `eq` сравнивает скалярное значение, `contains` ищет подстроку в строке или
 * точное значение в массиве. Секреты и служебные поля в metadata запрещены
 * контрактом доменного плагина.
 */
export type SearchFilterOperator = "eq" | "contains";

/** Фильтр по публичным метаданным поискового документа. */
export interface SearchFilter {
  readonly field: string;
  readonly operator: SearchFilterOperator;
  readonly value: string;
}

export interface SearchQuery {
  readonly text: string;
  readonly pluginId?: PluginId;
  readonly kind?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly filters?: readonly SearchFilter[];
}

export interface SearchHit {
  readonly ref: ResourceRef;
  readonly title: string;
  readonly excerpt: string;
  readonly score: number;
  readonly strategy: SearchIndexStrategy;
  /** Тип ресурса, если домен его индексирует. */
  readonly kind?: string;
  /** Публичные атрибуты для фильтрации и отображения без чтения домена. */
  readonly metadata?: JsonObject;
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
