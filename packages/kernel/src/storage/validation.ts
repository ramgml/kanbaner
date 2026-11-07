import {
  assertApplicationId,
  assertBackendId,
  assertCollectionName,
  assertJsonObjectValue,
  assertJsonValueInput,
  assertPluginId,
  currentUtcTimestamp,
  validateSemVer,
  validateUtcTimestamp,
} from "@kanbaner/plugin-sdk";
import type { PluginVersion } from "@kanbaner/plugin-sdk";

import type { UtcTimestamp } from "./contracts.ts";
import { storageError } from "./errors.ts";

/**
 * Локальные адаптеры поверх публичных assert-хелперов SDK.
 *
 * Ядро не повторяет регулярные выражения и правила ID/JSON: канонические
 * проверки живут в `@kanbaner/plugin-sdk`. Здесь остаются только операции,
 * которых нет в публичном контракте (положительные версии, пагинация, SemVer).
 */
export { assertApplicationId, assertBackendId, assertCollectionName, currentUtcTimestamp };
export { assertJsonObjectValue as assertJsonObject, assertJsonValueInput as assertJsonValue };
export { assertPluginId as assertPluginIdValue };

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

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
