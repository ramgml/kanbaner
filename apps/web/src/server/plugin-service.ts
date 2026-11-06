import path from "node:path";

import {
  createPluginRuntime,
  type PluginDiagnostic,
  type PluginRuntime,
  type PluginRuntimeLogger,
  type PluginRuntimeSnapshot,
} from "@kanbaner/kernel";
import type { JsonValue } from "@kanbaner/plugin-sdk";

import type {
  PluginManagerDiagnostic,
  PluginManagerEntry,
  PluginManagerProblem,
  PluginManagerState,
} from "../lib/plugin-manager-types";

const SERVICE_KEY = "__kanbanerWebPluginServiceV1";
const UNSAFE_DETAIL_KEYS = new Set([
  "path",
  "paths",
  "directory",
  "directories",
  "file",
  "files",
  "entrypoint",
  "entrypoints",
  "token",
  "secret",
  "password",
  "stack",
]);

const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\/)/;

export class PluginServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginServiceError";
    this.code = code;
  }
}

export interface PluginServiceOptions {
  readonly pluginDirectories?: readonly string[];
  readonly disabledPlugins?: readonly string[];
  readonly hostApiVersion?: string;
  readonly logger?: PluginRuntimeLogger;
}

function configuredPluginDirectories(): readonly string[] {
  const configured = process.env.KANBANER_PLUGIN_DIRS?.trim();

  if (configured !== undefined && configured.length > 0) {
    return configured
      .split(path.delimiter)
      .map((directory) => directory.trim())
      .filter((directory) => directory.length > 0);
  }

  return [path.join(process.cwd(), "plugins")];
}

function configuredDisabledPlugins(): readonly string[] {
  return (process.env.KANBANER_DISABLED_PLUGINS ?? "")
    .split(",")
    .map((pluginId) => pluginId.trim())
    .filter((pluginId) => pluginId.length > 0);
}

function createDefaultLogger(): PluginRuntimeLogger {
  return {
    log(level, message, details) {
      if (process.env.NODE_ENV !== "development") {
        return;
      }

      // Ошибка журналирования не должна влиять на lifecycle и не должна
      // становиться unhandled rejection.
      void Promise.resolve()
        .then(() => {
          const line = `[plugins] ${message}`;

          if (level === "error") {
            console.error(line, details ?? {});
          } else if (level === "warn") {
            console.warn(line, details ?? {});
          } else {
            console.info(line, details ?? {});
          }
        })
        .catch(() => {
          // Журналирование best-effort.
        });
    },
  };
}

function sanitizeString(value: string): string {
  return ABSOLUTE_PATH_PATTERN.test(value) ? "[redacted]" : value;
}

function sanitizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, JsonValue> = {};

    for (const [key, nested] of Object.entries(value)) {
      if (!UNSAFE_DETAIL_KEYS.has(key.toLowerCase())) {
        sanitized[key] = sanitizeJsonValue(nested);
      }
    }

    return sanitized;
  }

  return value;
}

function sanitizeDiagnostic(diagnostic: PluginDiagnostic): PluginManagerDiagnostic {
  if (diagnostic.details === undefined) {
    return {
      code: diagnostic.code,
      severity: diagnostic.severity,
      phase: diagnostic.phase,
      message: diagnostic.message,
    };
  }

  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    phase: diagnostic.phase,
    message: diagnostic.message,
    details: sanitizeJsonValue(diagnostic.details) as Readonly<Record<string, JsonValue>>,
  };
}

function sanitizeSource(source: string | null): string {
  if (source === null || source.length === 0) {
    return "runtime";
  }

  return sanitizeString(source);
}

function toManagerEntry(
  plugin: PluginRuntimeSnapshot["plugins"][number],
  disabledPlugins: ReadonlySet<string>,
): PluginManagerEntry {
  const manifest = plugin.manifest;
  const diagnostics = plugin.diagnostics.map(sanitizeDiagnostic);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const requires = Object.entries(manifest?.requires ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, range]) => ({ id, range }));

  return {
    id: plugin.pluginId,
    source: sanitizeSource(plugin.source),
    name: manifest?.name ?? plugin.pluginId ?? "Неизвестный плагин",
    version: manifest?.version ?? null,
    hostApi: manifest?.hostApi ?? null,
    status: plugin.status,
    configuredEnabled: plugin.pluginId === null ? false : !disabledPlugins.has(plugin.pluginId),
    activated: plugin.activated,
    canToggle: plugin.pluginId !== null,
    requires,
    consumes: manifest?.consumes ?? [],
    provides: manifest?.provides ?? [],
    permissions: manifest?.permissions ?? [],
    diagnostics,
    lastError: errors.length > 0 ? (errors[errors.length - 1] ?? null) : null,
  };
}

function toManagerState(
  snapshot: PluginRuntimeSnapshot,
  disabledPlugins: ReadonlySet<string>,
): PluginManagerState {
  const plugins = snapshot.plugins.map((plugin) => toManagerEntry(plugin, disabledPlugins));
  const problems: PluginManagerProblem[] = snapshot.problems.map((problem) => ({
    pluginId: problem.pluginId,
    source: sanitizeSource(problem.source),
    status: problem.status,
    code: problem.code,
    message: problem.message,
  }));

  return {
    mode: snapshot.mode,
    safeMode: snapshot.safeMode,
    started: snapshot.started,
    plugins,
    problems,
    disabledPluginIds: [...disabledPlugins].sort((left, right) => left.localeCompare(right)),
    checkedAt: new Date().toISOString(),
  };
}

function createFallbackState(): PluginManagerState {
  return {
    mode: "safe_mode",
    safeMode: true,
    started: false,
    plugins: [],
    problems: [
      {
        pluginId: null,
        source: "runtime",
        status: "failed",
        code: "runtime_failed",
        message: "Не удалось запустить runtime плагинов",
      },
    ],
    disabledPluginIds: [],
    checkedAt: new Date().toISOString(),
  };
}

class PluginService {
  private readonly pluginDirectories: readonly string[];
  private readonly hostApiVersion: string;
  private readonly logger: PluginRuntimeLogger;
  private readonly disabledPlugins: Set<string>;
  private runtime: PluginRuntime | null = null;
  private snapshot: PluginRuntimeSnapshot | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PluginServiceOptions = {}) {
    this.pluginDirectories = options.pluginDirectories ?? configuredPluginDirectories();
    this.hostApiVersion = options.hostApiVersion ?? "1.0.0";
    this.logger = options.logger ?? createDefaultLogger();
    this.disabledPlugins = new Set(options.disabledPlugins ?? configuredDisabledPlugins());
  }

  getState(): Promise<PluginManagerState> {
    return this.enqueue(async () => {
      const snapshot = await this.ensureStarted();

      return toManagerState(snapshot, this.disabledPlugins);
    });
  }

  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginManagerState> {
    return this.enqueue(async () => {
      const snapshot = await this.ensureStarted();

      if (!snapshot.plugins.some((plugin) => plugin.pluginId === pluginId)) {
        throw new PluginServiceError("NOT_FOUND", "Плагин не найден");
      }

      const currentlyEnabled = !this.disabledPlugins.has(pluginId);

      if (currentlyEnabled === enabled) {
        return toManagerState(snapshot, this.disabledPlugins);
      }

      await this.runtime?.stop();

      if (enabled) {
        this.disabledPlugins.delete(pluginId);
      } else {
        this.disabledPlugins.add(pluginId);
      }

      return this.restartInternal();
    });
  }

  refresh(): Promise<PluginManagerState> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      await this.runtime?.stop();

      return this.restartInternal();
    });
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      await this.runtime?.stop();
      this.runtime = null;
      this.snapshot = null;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);

    this.queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private async ensureStarted(): Promise<PluginRuntimeSnapshot> {
    if (this.snapshot !== null) {
      return this.snapshot;
    }

    this.runtime ??= this.createRuntime();
    this.snapshot = await this.runtime.start();

    return this.snapshot;
  }

  private async restartInternal(): Promise<PluginManagerState> {
    this.runtime = this.createRuntime();
    this.snapshot = await this.runtime.start();

    return toManagerState(this.snapshot, this.disabledPlugins);
  }

  private createRuntime(): PluginRuntime {
    return createPluginRuntime({
      pluginDirectories: this.pluginDirectories,
      hostApiVersion: this.hostApiVersion,
      disabledPlugins: [...this.disabledPlugins],
      logger: this.logger,
    });
  }
}

const globalHolder = globalThis as typeof globalThis & {
  [SERVICE_KEY]?: PluginService;
};

/** Создаёт независимый сервис; используется тестами и composition root. */
export function createPluginService(options: PluginServiceOptions = {}): PluginService {
  return new PluginService(options);
}

/** Singleton сервиса для Next.js с учётом hot reload. */
export function getPluginService(): PluginService {
  globalHolder[SERVICE_KEY] ??= createPluginService();

  return globalHolder[SERVICE_KEY];
}

/** Безопасное состояние для layout и plugin manager; не раскрывает пути. */
export async function getPluginManagerState(): Promise<PluginManagerState> {
  try {
    return await getPluginService().getState();
  } catch {
    return createFallbackState();
  }
}
