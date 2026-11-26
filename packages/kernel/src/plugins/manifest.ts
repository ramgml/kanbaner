import { isPluginId, validatePluginManifest, type PluginManifest } from "@kanbaner/plugin-sdk";

import type { PluginDiagnostic } from "../lifecycle/index.ts";
import { createDiagnostic } from "./diagnostics.ts";

const MAX_REPORTED_ISSUES = 20;

export interface ParsedPluginManifest {
  readonly manifest: PluginManifest | null;
  /** ID, извлечённый из JSON, даже если манифест не прошёл валидацию. */
  readonly pluginId: string | null;
  readonly diagnostic: PluginDiagnostic | null;
}

function extractPluginId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return null;
  }

  const id = (value as { readonly id?: unknown }).id;

  return isPluginId(id) ? id : null;
}

/**
 * Разбирает и валидирует манифест через публичный SDK.
 *
 * Ни одна часть серверного кода плагина не импортируется до успешной
 * валидации манифеста.
 */
export function parsePluginManifest(text: string, source: string): ParsedPluginManifest {
  const normalizedText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let value: unknown;

  try {
    value = JSON.parse(normalizedText);
  } catch {
    return {
      manifest: null,
      pluginId: null,
      diagnostic: createDiagnostic({
        code: "manifest_invalid_json",
        severity: "error",
        phase: "manifest_validation",
        pluginId: null,
        source,
        message: "Манифест не является корректным JSON",
      }),
    };
  }

  const pluginId = extractPluginId(value);
  const validation = validatePluginManifest(value);

  if (!validation.ok) {
    const issues = validation.errors.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
      path: issue.path,
      keyword: issue.keyword,
      message: issue.message,
    }));

    return {
      manifest: null,
      pluginId,
      diagnostic: createDiagnostic({
        code: "manifest_invalid",
        severity: "error",
        phase: "manifest_validation",
        pluginId,
        source,
        message: "Манифест не соответствует Plugin Contract v1",
        details: { issues },
      }),
    };
  }

  return {
    manifest: validation.value,
    pluginId: validation.value.id,
    diagnostic: null,
  };
}
