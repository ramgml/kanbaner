import type { JsonObject } from "./json.ts";
import { parseResourceRef } from "./resources.ts";
import type { PluginId } from "./plugin-id.ts";
import type { SearchHit, SearchIndexDocument, SearchQuery } from "./storage/search.ts";
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
