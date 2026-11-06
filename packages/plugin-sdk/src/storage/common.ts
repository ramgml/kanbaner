import type { JsonObject, JsonValue } from "../json.ts";
import { isContractId, isPluginId, type ContractId, type PluginId } from "../plugin-id.ts";
import { validateJsonValue } from "../validation.ts";
import { StorageError } from "./errors.ts";

/** Стабильный идентификатор backend, например `kanbaner.sqlite` или `in-memory`. */
export type BackendId = string;

export const BACKEND_ID_PATTERN = "^[a-z][a-z0-9-]*(?:\\.[a-z0-9-]+)*$";

const backendIdRegex = new RegExp(BACKEND_ID_PATTERN);
const applicationIdRegex = new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$");
const collectionRegex = new RegExp("^[a-z][a-z0-9_-]{0,63}$");

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && backendIdRegex.test(value);
}

export function assertBackendId(value: unknown): asserts value is BackendId {
  if (!isBackendId(value)) {
    throw new StorageError("INVALID_BACKEND_ID", "Некорректный идентификатор Storage backend");
  }
}

/**
 * Проверяет ID, который приложение или плагин создаёт до записи.
 *
 * Хранилище не генерирует публичные ID и не использует autoincrement/rowid.
 */
export function isApplicationId(value: unknown): value is string {
  return typeof value === "string" && applicationIdRegex.test(value);
}

export function assertApplicationId(value: unknown, label = "id"): asserts value is string {
  if (!isApplicationId(value)) {
    throw new StorageError("INVALID_ARGUMENT", `Некорректный application-generated ${label}`);
  }
}

/** Проверяет имя коллекции документа. */
export function isCollectionName(value: unknown): value is string {
  return typeof value === "string" && collectionRegex.test(value);
}

export function assertCollectionName(value: unknown): asserts value is string {
  if (!isCollectionName(value)) {
    throw new StorageError("INVALID_ARGUMENT", "Некорректное имя коллекции документа");
  }
}

export function assertPluginId(value: unknown): asserts value is PluginId {
  if (!isPluginId(value)) {
    throw new StorageError("INVALID_PLUGIN_ID", "Некорректный Plugin ID");
  }
}

export function assertContractId(value: unknown): asserts value is ContractId {
  if (!isContractId(value)) {
    throw new StorageError("INVALID_ARGUMENT", "Некорректный идентификатор Store-контракта");
  }
}

/** Проверяет, что значение является JSON-объектом, а не массивом или классом. */
export function isJsonObjectValue(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertJsonObjectValue(value: unknown, label: string): asserts value is JsonObject {
  if (!isJsonObjectValue(value)) {
    throw new StorageError("INVALID_ARGUMENT", `Поле ${label} должно быть JSON-объектом`);
  }
}

export function isJsonValueInput(value: unknown): value is JsonValue {
  return validateJsonValue(value).ok;
}

export function assertJsonValueInput(value: unknown, label: string): asserts value is JsonValue {
  if (!isJsonValueInput(value)) {
    throw new StorageError("INVALID_ARGUMENT", `Поле ${label} должно быть JSON-значением`);
  }
}
