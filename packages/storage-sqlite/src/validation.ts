import {
  assertApplicationId,
  assertBackendId,
  assertCollectionName,
  assertJsonObjectValue,
  assertJsonValueInput,
  assertPluginId,
  validateJsonValue,
  validateRelation,
  validateResourceLink,
  validateResourceRef,
  validateSemVer,
  validateUtcTimestamp,
} from "@kanbaner/plugin-sdk";

import { sqliteError } from "./errors.ts";

export {
  assertApplicationId,
  assertBackendId,
  assertCollectionName,
  assertJsonObjectValue,
  assertJsonValueInput,
  assertPluginId,
  validateJsonValue,
};

export const DEFAULT_PAGE_SIZE = 200;
export const DEFAULT_SEARCH_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;

export function assertUtcTimestampValue(value: unknown, label: string): asserts value is string {
  if (!validateUtcTimestamp(value).ok) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} должно быть UTC timestamp`);
  }
}

export function assertPluginVersion(value: unknown): asserts value is string {
  if (!validateSemVer(value).ok) {
    throw sqliteError("INVALID_ARGUMENT", "Версия плагина должна быть SemVer");
  }
}

function isIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function assertPositiveVersion(value: unknown, label = "version"): asserts value is number {
  if (!isIntegerValue(value) || value < 1) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} должно быть целым числом ≥ 1`);
  }
}

export function assertExpectedVersion(value: unknown): asserts value is number {
  if (!isIntegerValue(value) || value < 0) {
    throw sqliteError("INVALID_ARGUMENT", "expectedVersion должен быть целым числом ≥ 0");
  }
}

export function assertPageNumber(value: unknown, label: string): asserts value is number {
  if (!isIntegerValue(value) || value < 0) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} должно быть целым числом ≥ 0`);
  }
}

export function assertPageSize(value: number | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  assertPageNumber(value, label);

  if (value > MAX_PAGE_SIZE) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} не может превышать ${MAX_PAGE_SIZE}`);
  }
}

export function assertResourceRefValue(value: unknown, label: string): asserts value is string {
  if (!validateResourceRef(value).ok) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} должно быть ResourceRef`);
  }
}

export function assertRelationValue(value: unknown): asserts value is string {
  if (!validateRelation(value).ok) {
    throw sqliteError("INVALID_ARGUMENT", "Некорректный тип связи");
  }
}

export function assertResourceLinkValue(value: unknown): void {
  if (!validateResourceLink(value).ok) {
    throw sqliteError("INVALID_ARGUMENT", "Некорректная связь ресурсов");
  }
}

export function assertChecksum(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw sqliteError("INVALID_ARGUMENT", "checksum миграции должен быть SHA-256 hex");
  }
}

/** Возвращает независимую копию JSON-значения на границе Store. */
export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
