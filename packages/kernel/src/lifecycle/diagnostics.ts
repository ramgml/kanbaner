import type { JsonValue } from "@kanbaner/plugin-sdk";

/** Фаза жизненного цикла, к которой относится диагностика. */
export const PLUGIN_LIFECYCLE_PHASES = [
  "discovery",
  "manifest_validation",
  "dependency_resolution",
  "migration",
  "server_activation",
  "client_registration",
  "active",
  "deactivation",
  "stopped",
  "runtime",
] as const;

export type PluginLifecyclePhase = (typeof PLUGIN_LIFECYCLE_PHASES)[number];

/** Стабильные коды диагностики plugin runtime. */
export const PLUGIN_DIAGNOSTIC_CODES = [
  "plugin_root_unavailable",
  "manifest_read_failed",
  "manifest_invalid_json",
  "manifest_invalid",
  "duplicate_plugin_id",
  "plugin_disabled",
  "host_api_incompatible",
  "missing_dependency",
  "dependency_version_unsatisfied",
  "dependency_unavailable",
  "dependency_cycle",
  "entrypoint_invalid",
  "entrypoint_not_found",
  "migrations_path_invalid",
  "module_import_failed",
  "entrypoint_invalid_module",
  "migration_failed",
  "hook_failed",
  "activation_failed",
  "rollback_failed",
  "deactivation_failed",
  "plugin_stopped",
  "safe_mode",
  "runtime_failed",
] as const;

export type PluginDiagnosticCode = (typeof PLUGIN_DIAGNOSTIC_CODES)[number];

export type PluginDiagnosticSeverity = "error" | "warning" | "info";

/**
 * Диагностическое сообщение plugin manager.
 *
 * Сообщение и детали не содержат стеков, секретов и абсолютных путей:
 * вызывающая сторона получает только стабильный код, безопасный текст и
 * идентификаторы плагинов.
 */
export interface PluginDiagnostic {
  readonly code: PluginDiagnosticCode;
  readonly severity: PluginDiagnosticSeverity;
  readonly phase: PluginLifecyclePhase;
  readonly pluginId: string | null;
  readonly source: string | null;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}
