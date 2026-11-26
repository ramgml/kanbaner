import type {
  PluginDiagnosticCode,
  PluginDiagnosticSeverity,
  PluginLifecyclePhase,
  PluginProblemStatus,
  PluginStatus,
} from "@kanbaner/kernel";
import type { JsonValue } from "@kanbaner/plugin-sdk";

/**
 * Безопасное представление диагностики для клиента.
 *
 * Полный `PluginDiagnostic` содержит `source`, но не содержит абсолютных
 * путей. Этот тип дополнительно фиксирует только те поля, которые нужны UI.
 */
export interface PluginManagerDiagnostic {
  readonly code: PluginDiagnosticCode;
  readonly severity: PluginDiagnosticSeverity;
  readonly phase: PluginLifecyclePhase;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface PluginManagerRequirement {
  readonly id: string;
  readonly range: string;
}

export interface PluginManagerEntry {
  readonly id: string | null;
  readonly source: string;
  readonly name: string;
  readonly version: string | null;
  readonly hostApi: string | null;
  readonly status: PluginStatus;
  /** Включён ли плагин в конфигурации, независимо от успеха активации. */
  readonly configuredEnabled: boolean;
  readonly activated: boolean;
  readonly canToggle: boolean;
  readonly requires: readonly PluginManagerRequirement[];
  readonly consumes: readonly string[];
  readonly provides: readonly string[];
  readonly permissions: readonly string[];
  readonly diagnostics: readonly PluginManagerDiagnostic[];
  readonly lastError: PluginManagerDiagnostic | null;
}

export interface PluginManagerProblem {
  readonly pluginId: string | null;
  readonly source: string;
  readonly status: PluginProblemStatus;
  readonly code: PluginDiagnosticCode;
  readonly message: string;
}

export interface PluginManagerState {
  readonly mode: "normal" | "safe_mode";
  readonly safeMode: boolean;
  readonly started: boolean;
  readonly plugins: readonly PluginManagerEntry[];
  readonly problems: readonly PluginManagerProblem[];
  readonly disabledPluginIds: readonly string[];
  readonly checkedAt: string;
}

/** Минимальные данные о плагинах, которые нужны клиентскому shell. */
export interface UiPluginAvailability {
  readonly activePluginIds: readonly string[];
  readonly unavailablePluginIds: readonly string[];
  readonly safeMode: boolean;
  readonly problemCount: number;
}

export interface PluginManagerActionError {
  readonly code: string;
  readonly message: string;
}

export interface PluginManagerActionResult {
  readonly ok: boolean;
  readonly state: PluginManagerState | null;
  readonly error: PluginManagerActionError | null;
}

export const EMPTY_UI_PLUGIN_AVAILABILITY: UiPluginAvailability = {
  activePluginIds: [],
  unavailablePluginIds: [],
  safeMode: false,
  problemCount: 0,
};

export function toUiPluginAvailability(state: PluginManagerState): UiPluginAvailability {
  return {
    activePluginIds: state.plugins
      .filter((plugin) => plugin.id !== null && plugin.activated)
      .map((plugin) => plugin.id as string),
    unavailablePluginIds: state.plugins
      .filter((plugin) => plugin.id !== null && !plugin.activated)
      .map((plugin) => plugin.id as string),
    safeMode: state.safeMode,
    problemCount: state.problems.length,
  };
}
