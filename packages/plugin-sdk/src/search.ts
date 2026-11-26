import type { JsonObject } from "./json.ts";
import { parseResourceRef } from "./resources.ts";
import type { PluginId } from "./plugin-id.ts";
import type {
  SearchFilter,
  SearchFilterOperator,
  SearchHit,
  SearchIndexDocument,
  SearchQuery,
} from "./storage/search.ts";
import type { UtcTimestamp } from "./storage/time.ts";
import type { ResourceRef } from "./resources.ts";
import { StorageError } from "./storage/errors.ts";

/**
 * Публичный вход поискового документа.
 *
 * `pluginId` не передаётся: ответственный плагин подставляется фасадом и
 * проверяется по ResourceRef. Это не даёт записать документ в чужой
 * namespace поискового индекса.
 */
export interface SearchDocumentInput {
  readonly ref: ResourceRef;
  readonly title: string;
  readonly text: string;
  readonly kind?: string;
  readonly metadata?: JsonObject;
  readonly updatedAt?: UtcTimestamp;
}

/** Минимальный публичный поисковый фасад, привязанный к plugin ID. */
export interface PluginSearchService {
  upsert(documents: readonly SearchDocumentInput[]): Promise<number>;
  delete(ref: ResourceRef): Promise<boolean>;
  list(): Promise<readonly SearchIndexDocument[]>;
  search(query: Omit<SearchQuery, "pluginId">): Promise<readonly SearchHit[]>;
  reindex(documents: readonly SearchDocumentInput[]): Promise<number>;
  /**
   * Регистрирует SearchProvider текущего плагина.
   *
   * `provider.id` обязан совпадать с plugin ID: реестр агрегирует только
   * активные доверенные провайдеры и не читает их namespace напрямую.
   */
  registerProvider(provider: SearchProvider): void;
  /** Снимает провайдера текущего плагина; вызывается при деактивации. */
  unregisterProviders(): void;
  /** Агрегирует выдачу всех активных провайдеров с bounded pagination. */
  aggregate(query: SearchProviderQuery): Promise<SearchAggregateResult>;
  /** Объединяет типы и фильтры активных провайдеров для UI. */
  listFacets(): Promise<SearchFacetSet>;
}

/** Публичный тип ресурса, который провайдер добавляет в глобальную выдачу. */
export interface SearchProviderKind {
  readonly id: string;
  readonly title: string;
}

/** Значение facet-а с машинным значением и отображаемой подписью. */
export interface SearchProviderFacetValue {
  readonly value: string;
  readonly label: string;
}

/**
 * Фильтр, который провайдер умеет применять к своим метаданным.
 *
 * Facet описывает только публичные атрибуты документа; произвольные поля
 * метаданных не становятся каналом доступа к чужим данным.
 */
export interface SearchProviderFacet {
  readonly id: string;
  readonly title: string;
  readonly operators: readonly SearchFilterOperator[];
  readonly values: readonly SearchProviderFacetValue[];
}

/** Запрос провайдера в рамках агрегированного глобального поиска. */
export interface SearchProviderQuery {
  readonly text: string;
  readonly kinds?: readonly string[];
  readonly filters?: readonly SearchFilter[];
  readonly limit?: number;
  readonly offset?: number;
}

/** Безопасное предупреждение об отказе одного провайдера или чужой ссылке. */
export interface SearchAggregateWarning {
  readonly providerId: string;
  readonly code: "provider_failed" | "foreign_ref";
}

/** Результат агрегированного поиска: страница, признак продолжения и warning-и. */
export interface SearchAggregateResult {
  readonly hits: readonly SearchHit[];
  readonly hasMore: boolean;
  readonly warnings: readonly SearchAggregateWarning[];
}

/** Объединённые типы и фильтры активных провайдеров. */
export interface SearchFacetSet {
  readonly kinds: readonly SearchProviderKind[];
  readonly facets: readonly SearchProviderFacet[];
  readonly warnings: readonly SearchAggregateWarning[];
}

/**
 * Поисковый провайдер доменного плагина.
 *
 * Провайдер не получает доступ к чужим данным: его `search` вызывается
 * реестром, а реализация использует только bound `PluginSearchService` и
 * собственный Store.
 */
export interface SearchProvider {
  readonly id: string;
  readonly kinds: readonly SearchProviderKind[];
  /**
   * Поля публичных метаданных, которые провайдер умеет фильтровать.
   *
   * Список статичен и используется для маршрутизации: провайдер без поля не
   * вызывается, поэтому заметки не попадают в выдачу с фильтром проекта.
   */
  readonly filterFields: readonly string[];
  /** Возвращает актуальные facet-ы по данным плагина. */
  listFacets(): Promise<readonly SearchProviderFacet[]>;
  search(query: SearchProviderQuery): Promise<readonly SearchHit[]>;
  /** Идемпотентная полная переиндексация своего namespace. */
  reindex(): Promise<number>;
}

/**
 * Хост-регистратор поиска.
 *
 * `pluginId` передаёт доверенный runtime; публичный плагин работает только с
 * bound-фасадом `PluginSearchService`.
 */
export interface SearchRegistrar {
  upsert(pluginId: PluginId, documents: readonly SearchDocumentInput[]): Promise<number>;
  delete(pluginId: PluginId, ref: ResourceRef): Promise<boolean>;
  list(pluginId: PluginId): Promise<readonly SearchIndexDocument[]>;
  search(pluginId: PluginId, query: Omit<SearchQuery, "pluginId">): Promise<readonly SearchHit[]>;
  reindex(pluginId: PluginId, documents: readonly SearchDocumentInput[]): Promise<number>;
  registerProvider(pluginId: PluginId, provider: SearchProvider): void;
  unregisterProviders(pluginId: PluginId): void;
  aggregate(query: SearchProviderQuery): Promise<SearchAggregateResult>;
  listFacets(): Promise<SearchFacetSet>;
}

/**
 * Преобразует вход в нормализованный документ поиска.
 *
 * ResourceRef обязан принадлежать `pluginId`; иначе документ не может быть
 * записан. Функция входит в публичный SDK и не зависит от backend-а.
 */
export function toSearchDocument(
  pluginId: PluginId,
  input: SearchDocumentInput,
): SearchIndexDocument {
  const parts = parseResourceRef(input.ref);

  if (parts.pluginId !== pluginId) {
    throw new StorageError(
      "INVALID_PLUGIN_ID",
      "ResourceRef поискового документа принадлежит другому плагину",
    );
  }

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new StorageError("INVALID_ARGUMENT", "Заголовок поискового документа обязателен");
  }

  if (typeof input.text !== "string") {
    throw new StorageError("INVALID_ARGUMENT", "Текст поискового документа должен быть строкой");
  }

  const document: SearchIndexDocument = {
    ref: input.ref,
    pluginId,
    title: input.title,
    text: input.text,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };

  return Object.freeze(document);
}
