import { isSemVer } from "@kanbaner/plugin-sdk";
import { satisfies } from "semver";

/** Версия Host API по умолчанию для Contract v1. */
export const DEFAULT_HOST_API_VERSION = "1.0.0";

/**
 * Проверяет, удовлетворяет ли версия SemVer-диапазону.
 *
 * Неверная версия или диапазон не считаются совместимыми: манифест уже
 * провалидирован SDK, поэтому такой результат означает только несовпадение.
 */
export function versionSatisfies(version: string, range: string): boolean {
  if (!isSemVer(version)) {
    return false;
  }

  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
}

/** Проверяет, что Host API версия является конкретным SemVer. */
export function isHostApiVersion(value: string): boolean {
  return isSemVer(value);
}
