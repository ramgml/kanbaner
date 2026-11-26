import type { JsonValue } from "@kanbaner/plugin-sdk";

import type {
  PluginDiagnostic,
  PluginDiagnosticCode,
  PluginDiagnosticSeverity,
  PluginLifecyclePhase,
} from "../lifecycle/index.ts";

export interface DiagnosticInput {
  readonly code: PluginDiagnosticCode;
  readonly severity: PluginDiagnosticSeverity;
  readonly phase: PluginLifecyclePhase;
  readonly pluginId: string | null;
  readonly source: string | null;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/** Создаёт диагностику, не добавляя необязательные поля со значением `undefined`. */
export function createDiagnostic(input: DiagnosticInput): PluginDiagnostic {
  if (input.details === undefined) {
    return {
      code: input.code,
      severity: input.severity,
      phase: input.phase,
      pluginId: input.pluginId,
      source: input.source,
      message: input.message,
    };
  }

  return {
    code: input.code,
    severity: input.severity,
    phase: input.phase,
    pluginId: input.pluginId,
    source: input.source,
    message: input.message,
    details: input.details,
  };
}

/** Сравнение строк по коду символа, независимое от локали. */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/** Рекурсивно замораживает JSON-подобную структуру. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return value;
}

/** Клонирует значение, сохраняя только JSON-совместимые поля. */
export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
