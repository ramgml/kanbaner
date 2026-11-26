import type { PluginManifest } from "@kanbaner/plugin-sdk";

import type { PluginDiagnostic, PluginDiagnosticCode } from "./diagnostics.ts";

/** Состояния жизненного цикла Plugin Contract v1. */
export const PLUGIN_STATUSES = [
  "discovered",
  "manifest_validated",
  "dependencies_resolved",
  "migrated",
  "server_activated",
  "client_registered",
  "active",
  "failed",
  "disabled",
  "incompatible",
  "missing_dependency",
  "safe_mode",
] as const;

export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** Ошибочные состояния, из-за которых ядро работает в safe mode. */
export const PLUGIN_PROBLEM_STATUSES = [
  "failed",
  "incompatible",
  "missing_dependency",
  "safe_mode",
] as const;

export type PluginProblemStatus = (typeof PLUGIN_PROBLEM_STATUSES)[number];

export type PluginRuntimeMode = "normal" | "safe_mode";

/**
 * Whitelist-представление манифеста для внешнего состояния.
 *
 * Entrypoints, migrations и любые неизвестные поля не публикуются: plugin
 * manager не должен получать пути загрузки кода или внутренние данные.
 */
export interface PluginManifestSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hostApi: string;
  readonly requires: Readonly<Record<string, string>>;
  readonly consumes: readonly string[];
  readonly provides: readonly string[];
  readonly permissions: readonly string[];
}

/** Создаёт безопасное whitelist-представление манифеста. */
export function summarizePluginManifest(manifest: PluginManifest): PluginManifestSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    hostApi: manifest.hostApi,
    requires: { ...manifest.requires },
    consumes: [...manifest.consumes],
    provides: [...manifest.provides],
    permissions: [...manifest.permissions],
  };
}

/** Проблемный плагин и причина, по которой он не активирован. */
export interface PluginProblem {
  readonly pluginId: string | null;
  readonly source: string;
  readonly status: PluginProblemStatus;
  readonly code: PluginDiagnosticCode;
  readonly message: string;
}

/** Публичное состояние одного плагина для plugin manager. */
export interface PluginStateSnapshot {
  readonly pluginId: string | null;
  readonly source: string;
  readonly status: PluginStatus;
  readonly manifest: PluginManifestSummary | null;
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly activated: boolean;
  readonly deactivated: boolean;
  readonly activationIndex: number | null;
}

/** Публичный снимок состояния runtime и всех обнаруженных плагинов. */
export interface PluginRuntimeSnapshot {
  readonly mode: PluginRuntimeMode;
  readonly safeMode: boolean;
  readonly started: boolean;
  readonly activationOrder: readonly string[];
  readonly deactivationOrder: readonly string[];
  readonly plugins: readonly PluginStateSnapshot[];
  readonly problems: readonly PluginProblem[];
  readonly diagnostics: readonly PluginDiagnostic[];
}
