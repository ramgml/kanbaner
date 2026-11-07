import type { PluginId } from "@kanbaner/plugin-sdk";

import { sqliteError } from "./errors.ts";
import { assertPluginId } from "./validation.ts";

/**
 * Безопасный namespace-префикс таблиц плагина.
 *
 * Плагин не передаёт provider-у имена таблиц и SQL. Если будущая
 * backend-зависимая миграция плагина создаёт свои таблицы, имя строится
 * только из валидированного Plugin ID и фиксированного префикса.
 */
export function pluginNamespacePrefix(pluginId: PluginId): string {
  assertPluginId(pluginId);

  return `plugin_${pluginId.replace(/\./gu, "_")}_`;
}

/** Проверяет, что имя таблицы использует namespace-префикс плагина. */
export function isPluginNamespaceTable(pluginId: PluginId, tableName: unknown): boolean {
  if (typeof tableName !== "string") {
    return false;
  }

  const prefix = pluginNamespacePrefix(pluginId);

  return /^[a-z][a-z0-9_]*$/u.test(tableName) && tableName.startsWith(prefix);
}

/** Создаёт имя таблицы в namespace плагина без интерполяции произвольных имён. */
export function pluginNamespaceTable(pluginId: PluginId, suffix: string): string {
  if (typeof suffix !== "string" || !/^[a-z][a-z0-9_]*$/u.test(suffix)) {
    throw sqliteError("INVALID_ARGUMENT", "Некорректный суффикс namespace-таблицы", {
      details: { reason: "constraint" },
    });
  }

  return `${pluginNamespacePrefix(pluginId)}${suffix}`;
}
