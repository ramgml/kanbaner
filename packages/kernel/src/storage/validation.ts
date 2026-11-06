import {
  isPluginId,
  validateJsonValue,
  validateSemVer,
  validateUtcTimestamp,
} from "@kanbaner/plugin-sdk";
import type { JsonObject, JsonValue, PluginId, PluginVersion } from "@kanbaner/plugin-sdk";

import type { BackendId, UtcTimestamp } from "./contracts.ts";
import { storageError } from "./errors.ts";

const BACKEND_ID_PATTERN = "^[a-z][a-z0-9-]*(?:\\.[a-z0-9-]+)*$";
const COLLECTION_PATTERN = "^[a-z][a-z0-9_-]{0,63}$";
const APPLICATION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$";

const backendIdRegex = new RegExp(BACKEND_ID_PATTERN);
const collectionRegex = new RegExp(COLLECTION_PATTERN);
const applicationIdRegex = new RegExp(APPLICATION_ID_PATTERN);

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && backendIdRegex.test(value);
}

export function assertBackendId(value: unknown): asserts value is BackendId {
  if (!isBackendId(value)) {
    throw storageError("INVALID_BACKEND_ID", "Некорректный идентификатор Storage backend");
  }
}

export function assertPluginIdValue(value: unknown): asserts value is PluginId {
  if (!isPluginId(value)) {
    throw storageError("INVALID_PLUGIN_ID", "Некорректный Plugin ID");
  }
}

export function assertCollection(value: unknown): asserts value is string {
  if (typeof value !== "string" || !collectionRegex.test(value)) {
    throw storageError("INVALID_ARGUMENT", "Некорректное имя коллекции документа");
  }
}

export function assertApplicationId(value: unknown, label = "id"): asserts value is string {
  if (typeof value !== "string" || !applicationIdRegex.test(value)) {
    throw storageError("INVALID_ARGUMENT", `Некорректный application-generated ${label}`);
  }
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (!validateJsonValue(value).ok) {
    throw storageError("INVALID_ARGUMENT", `Поле ${label} должно быть JSON-значением`);
  }
}

export function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !validateJsonValue(value).ok
  ) {
    throw storageError("INVALID_ARGUMENT", `Поле ${label} должно быть JSON-объектом`);
  }
}

export function assertUtcTimestamp(value: unknown, label: string): asserts value is UtcTimestamp {
  if (!validateUtcTimestamp(value).ok) {
    throw storageError("INVALID_ARGUMENT", `Поле ${label} должно быть UTC timestamp`);
  }
}

export function assertPluginVersion(value: unknown): asserts value is PluginVersion {
  if (!validateSemVer(value).ok) {
    throw storageError("INVALID_ARGUMENT", "Версия плагина должна быть SemVer");
  }
}

function isIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function assertPositiveVersion(value: unknown, label = "version"): asserts value is number {
  if (!isIntegerValue(value) || value < 1) {
    throw storageError("INVALID_ARGUMENT", `Поле ${label} должно быть целым числом ≥ 1`);
  }
}

export function assertExpectedVersion(value: unknown): asserts value is number {
  if (!isIntegerValue(value) || value < 0) {
    throw storageError("INVALID_ARGUMENT", "expectedVersion должен быть целым числом ≥ 0");
  }
}

export function assertPageNumber(value: unknown, label: string): asserts value is number {
  if (!isIntegerValue(value) || value < 0) {
    throw storageError("INVALID_ARGUMENT", `Поле ${label} должно быть целым числом ≥ 0`);
  }
}

export function currentUtcTimestamp(now: () => Date): UtcTimestamp {
  const date = now();

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw storageError("INTERNAL_ERROR", "Не удалось получить текущее UTC-время");
  }

  return date.toISOString();
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
