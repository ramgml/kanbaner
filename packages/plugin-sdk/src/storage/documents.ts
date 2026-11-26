import type { JsonObject, JsonValue } from "../json.ts";
import type { PluginId } from "../plugin-id.ts";
import type { UtcTimestamp } from "./time.ts";

/**
 * Версионируемый документ универсального PluginDocumentStore.
 *
 * `data` — JSON-значение, `indexedFields` — необязательный JSON-объект для
 * точного фильтра. Store не интерпретирует предметный смысл полей.
 */
export interface PluginDocument {
  readonly pluginId: PluginId;
  readonly collection: string;
  readonly id: string;
  readonly version: number;
  readonly data: JsonValue;
  readonly indexedFields?: JsonObject;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

/** Вход создания или обновления документа. */
export interface PluginDocumentPutInput {
  readonly pluginId: PluginId;
  readonly collection: string;
  readonly id: string;
  readonly data: JsonValue;
  readonly indexedFields?: JsonObject;
  /**
   * Ожидаемая версия.
   *
   * Для создания допускается `undefined` или `0`. Для обновления значение
   * обязательно и должно совпадать с текущей версией; иначе возвращается
   * ошибка `VERSION_CONFLICT`, а данные не перезаписываются.
   */
  readonly expectedVersion?: number;
}

export interface PluginDocumentDeleteOptions {
  readonly expectedVersion?: number;
}

export interface PluginDocumentSort {
  readonly field: "id" | "createdAt" | "updatedAt";
  readonly direction: "asc" | "desc";
}

/**
 * Backend-neutral запрос документов.
 *
 * `indexedFields` проверяет точное совпадение перечисленных ключей; SQL,
 * имена таблиц и диалект backend в контракт не входят.
 */
export interface PluginDocumentQuery {
  readonly pluginId: PluginId;
  readonly collection?: string;
  readonly ids?: readonly string[];
  readonly indexedFields?: JsonObject;
  readonly sort?: PluginDocumentSort;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Универсальное хранилище простых документов для сторонних плагинов.
 *
 * Все операции асинхронны. Публичный ID создаёт приложение или плагин до
 * записи; backend не генерирует ID и не использует autoincrement как ID.
 */
export interface PluginDocumentStore {
  get(pluginId: PluginId, collection: string, id: string): Promise<PluginDocument | null>;
  put(input: PluginDocumentPutInput): Promise<PluginDocument>;
  delete(
    pluginId: PluginId,
    collection: string,
    id: string,
    options?: PluginDocumentDeleteOptions,
  ): Promise<boolean>;
  query(query: PluginDocumentQuery): Promise<readonly PluginDocument[]>;
  list(pluginId: PluginId, collection?: string): Promise<readonly PluginDocument[]>;
}
