import path from "node:path";

import {
  createPluginRuntime,
  type PluginDiagnostic,
  type PluginDiagnosticCode,
  type PluginLifecycleHooks,
  type PluginRuntime,
  type PluginRuntimeLogger,
  type PluginRuntimeSnapshot,
} from "@kanbaner/kernel";
import type {
  JsonValue,
  OperationResult,
  PluginHostServices,
  PluginLogger,
} from "@kanbaner/plugin-sdk";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
  type PluginUiContributionRecord,
} from "./application-composition";

import { sanitizeUiOperationOptions, type UiOperationInvokeOptions } from "../ui/operation-types";
import type {
  PluginManagerDiagnostic,
  PluginManagerEntry,
  PluginManagerProblem,
  PluginManagerState,
} from "../lib/plugin-manager-types";
import { getApplicationStorage, type ApplicationStorageRuntime } from "./application-storage";
import { migratePluginWithSqlite } from "./sqlite-plugin-migrations";

const SERVICE_KEY = "__kanbanerWebPluginServiceV1";

/**
 * Стабильные сообщения сервиса. Клиент получает текст только по коду,
 * поэтому внутренние исключения и произвольные строки не утекают наружу.
 */
const SERVICE_ERROR_MESSAGES = {
  NOT_FOUND: "Плагин не найден",
  DEACTIVATION_FAILED: "Плагин не удалось безопасно деактивировать",
  PROCESS_RESTART_REQUIRED:
    "Требуется перезапуск процесса: плагин не удалось безопасно деактивировать",
  INTERNAL_ERROR: "Не удалось изменить состояние плагина",
} as const;

export type PluginServiceErrorCode = keyof typeof SERVICE_ERROR_MESSAGES;

/** Стабильные сообщения диагностик: текст не зависит от состояния runtime. */
const PLUGIN_DIAGNOSTIC_MESSAGES: Readonly<Record<PluginDiagnosticCode, string>> = {
  plugin_root_unavailable: "Каталог плагинов недоступен",
  manifest_read_failed: "Манифест плагина не удалось прочитать",
  manifest_invalid_json: "Манифест не является корректным JSON",
  manifest_invalid: "Манифест не соответствует Plugin Contract v1",
  duplicate_plugin_id: "Plugin ID уже занят другим плагином",
  plugin_disabled: "Плагин отключён конфигурацией",
  host_api_incompatible: "Плагин несовместим с Host API",
  missing_dependency: "Обязательный плагин не найден",
  dependency_version_unsatisfied: "Версия обязательного плагина не удовлетворяет диапазону",
  dependency_unavailable: "Обязательный плагин недоступен",
  dependency_cycle: "Обнаружен цикл зависимостей плагинов",
  entrypoint_invalid: "Entrypoint плагина не соответствует контракту",
  entrypoint_not_found: "Entrypoint плагина не найден",
  migrations_path_invalid: "Путь миграций плагина недопустим",
  module_import_failed: "Серверный модуль плагина не загрузился",
  entrypoint_invalid_module: "Серверный модуль не экспортирует activate/deactivate",
  migration_failed: "Hook миграций завершился ошибкой",
  hook_failed: "Hook жизненного цикла завершился ошибкой",
  activation_failed: "Серверная активация плагина завершилась ошибкой",
  rollback_failed: "Откат серверной активации завершился ошибкой",
  deactivation_failed: "Серверная деактивация плагина завершилась ошибкой",
  plugin_stopped: "Плагин деактивирован",
  safe_mode: "Плагин переведён в safe mode",
  runtime_failed: "Не удалось запустить runtime плагинов",
};

/**
 * Whitelist ключей диагностических деталей. Всё остальное, включая пути,
 * токены и стеки, отбрасывается до сериализации в клиентский снимок.
 */
const SAFE_DETAIL_KEYS = new Set([
  "rootIndex",
  "reason",
  "issues",
  "dependency",
  "requiredRange",
  "dependencyStatus",
  "actualVersion",
  "hook",
  "stage",
  "keyword",
  "message",
  "code",
  "status",
  "version",
  "range",
  "id",
]);

const REDACTED = "[redacted]";

const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]+/g;
const UNC_PATH = /\\\\[\w.@+-]+\\[\w.@+-]+(?:\\[\w.@+-]+)*/g;
const POSIX_MULTI_SEGMENT_PATH = /(?<![\w.-])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g;
const POSIX_SINGLE_SEGMENT_PATH = /(?<![\w.-])\/[\w.@+-]+(?=$|[\s"'),;:.])/g;

/** Удаляет POSIX/Windows/UNC-пути, в том числе внутри произвольного текста. */
function sanitizeString(value: string): string {
  return value
    .replace(WINDOWS_ABSOLUTE_PATH, REDACTED)
    .replace(UNC_PATH, REDACTED)
    .replace(POSIX_MULTI_SEGMENT_PATH, REDACTED)
    .replace(POSIX_SINGLE_SEGMENT_PATH, REDACTED);
}

function sanitizeOptionalString(value: string | null): string | null {
  return value === null ? null : sanitizeString(value);
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
      if (SAFE_DETAIL_KEYS.has(key)) {
        sanitized[key] = sanitizeJsonValue(nested);
      }
    }

    return sanitized;
  }

  return value;
}

/** @internal Проверяется unit-тестами санитизации исходящих строк. */
export function sanitizeOutboundString(value: string): string {
  return sanitizeString(value);
}

/** @internal Проверяется unit-тестами whitelist деталей диагностики. */
export function sanitizeDiagnosticDetails(
  value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return sanitizeJsonValue(value) as Readonly<Record<string, JsonValue>>;
}

function stableDiagnosticMessage(code: PluginDiagnosticCode): string {
  return sanitizeString(PLUGIN_DIAGNOSTIC_MESSAGES[code]);
}

function sanitizeDiagnostic(diagnostic: PluginDiagnostic): PluginManagerDiagnostic {
  if (diagnostic.details === undefined) {
    return {
      code: diagnostic.code,
      severity: diagnostic.severity,
      phase: diagnostic.phase,
      message: stableDiagnosticMessage(diagnostic.code),
    };
  }

  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    phase: diagnostic.phase,
    message: stableDiagnosticMessage(diagnostic.code),
    details: sanitizeJsonValue(diagnostic.details) as Readonly<Record<string, JsonValue>>,
  };
}

function sanitizeSource(source: string | null): string {
  if (source === null || source.length === 0) {
    return "runtime";
  }

  return sanitizeString(source);
}

function sanitizeStringList(values: readonly string[]): readonly string[] {
  return values.map((value) => sanitizeString(value));
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
    .map(([id, range]) => ({ id: sanitizeString(id), range: sanitizeString(range) }));

  return {
    id: plugin.pluginId,
    source: sanitizeSource(plugin.source),
    name: sanitizeString(manifest?.name ?? plugin.pluginId ?? "Неизвестный плагин"),
    version: sanitizeOptionalString(manifest?.version ?? null),
    hostApi: sanitizeOptionalString(manifest?.hostApi ?? null),
    status: plugin.status,
    configuredEnabled: plugin.pluginId === null ? false : !disabledPlugins.has(plugin.pluginId),
    activated: plugin.activated,
    canToggle: plugin.pluginId !== null,
    requires,
    consumes: sanitizeStringList(manifest?.consumes ?? []),
    provides: sanitizeStringList(manifest?.provides ?? []),
    permissions: sanitizeStringList(manifest?.permissions ?? []),
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
    message: stableDiagnosticMessage(problem.code),
  }));

  return {
    mode: snapshot.mode,
    safeMode: snapshot.safeMode,
    started: snapshot.started,
    plugins,
    problems,
    disabledPluginIds: sanitizeStringList(
      [...disabledPlugins].sort((left, right) => left.localeCompare(right)),
    ),
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
        message: stableDiagnosticMessage("runtime_failed"),
      },
    ],
    disabledPluginIds: [],
    checkedAt: new Date().toISOString(),
  };
}

export class PluginServiceError extends Error {
  readonly code: PluginServiceErrorCode;
  /** Безопасный снимок, который нужно показать вместе с ошибкой. */
  readonly state: PluginManagerState | null;

  constructor(code: PluginServiceErrorCode, state: PluginManagerState | null = null) {
    super(SERVICE_ERROR_MESSAGES[code]);
    this.name = "PluginServiceError";
    this.code = code;
    this.state = state;
  }
}

export interface PluginServiceOptions {
  readonly pluginDirectories?: readonly string[];
  readonly disabledPlugins?: readonly string[];
  readonly hostApiVersion?: string;
  readonly logger?: PluginRuntimeLogger;
  readonly hooks?: PluginLifecycleHooks;
  /**
   * Bootstrap Storage-слоя до старта runtime.
   *
   * Composition root приложения передаёт инициализацию SQLite provider-а;
   * тесты и независимые экземпляры могут не подключать Storage.
   */
  readonly bootstrap?: () => Promise<void>;
  /** Общие сервисы composition root; вызывается после bootstrap. */
  readonly getServices?: () => PluginHostServices | undefined;
  /** Уведомление после каждого успешного `start()`. */
  readonly onSnapshot?: (snapshot: PluginRuntimeSnapshot) => void;
  /** UI-метаданные активных плагинов для серверного рендера. */
  readonly getUiContributions?: () => readonly PluginUiContributionRecord[];
  /** Выполнение UI-операции через общий OperationBus. */
  readonly executeOperation?: (
    operationId: string,
    input: JsonValue,
    options?: UiOperationInvokeOptions,
  ) => Promise<OperationResult<unknown>>;
}

interface StopResult {
  readonly snapshot: PluginRuntimeSnapshot | null;
  readonly faults: readonly PluginDiagnostic[];
  readonly failedPluginIds: readonly string[];
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

/** Считает ошибки деактивации по Plugin ID до и после `stop()`. */
function countDeactivationErrors(snapshot: PluginRuntimeSnapshot): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const plugin of snapshot.plugins) {
    if (plugin.pluginId === null) {
      continue;
    }

    counts.set(
      plugin.pluginId,
      plugin.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error" && diagnostic.phase === "deactivation",
      ).length,
    );
  }

  return counts;
}

/**
 * Новые ошибки деактивации — единственный признак того, что `stop()`
 * завершился не штатно. Информационная диагностика `plugin_stopped` не
 * считается ошибкой.
 */
function collectDeactivationFaults(
  before: PluginRuntimeSnapshot,
  after: PluginRuntimeSnapshot,
): { faults: PluginDiagnostic[]; failedPluginIds: string[] } {
  const beforeCounts = countDeactivationErrors(before);
  const faults: PluginDiagnostic[] = [];
  const failedPluginIds: string[] = [];

  for (const plugin of after.plugins) {
    if (plugin.pluginId === null) {
      continue;
    }

    const beforeCount = beforeCounts.get(plugin.pluginId) ?? 0;
    const errors = plugin.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.phase === "deactivation",
    );

    if (errors.length > beforeCount) {
      faults.push(...errors.slice(beforeCount));
      failedPluginIds.push(plugin.pluginId);
    }
  }

  return { faults, failedPluginIds };
}

class PluginService {
  private readonly pluginDirectories: readonly string[];
  private readonly hostApiVersion: string;
  private readonly logger: PluginRuntimeLogger;
  private readonly hooks: PluginLifecycleHooks;
  private readonly disabledPlugins: Set<string>;
  private readonly blockedPluginIds = new Set<string>();
  private readonly bootstrap: (() => Promise<void>) | undefined;
  private readonly getServices: (() => PluginHostServices | undefined) | undefined;
  private readonly onSnapshot: ((snapshot: PluginRuntimeSnapshot) => void) | undefined;
  private readonly uiContributionsProvider:
    (() => readonly PluginUiContributionRecord[]) | undefined;
  private readonly operationExecutor:
    | ((
        operationId: string,
        input: JsonValue,
        options?: UiOperationInvokeOptions,
      ) => Promise<OperationResult<unknown>>)
    | undefined;
  private runtime: PluginRuntime | null = null;
  private snapshot: PluginRuntimeSnapshot | null = null;
  private bootstrapDone = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PluginServiceOptions = {}) {
    this.pluginDirectories = options.pluginDirectories ?? configuredPluginDirectories();
    this.hostApiVersion = options.hostApiVersion ?? "1.0.0";
    this.logger = options.logger ?? createDefaultLogger();
    this.hooks = options.hooks ?? {};
    this.disabledPlugins = new Set(options.disabledPlugins ?? configuredDisabledPlugins());
    this.bootstrap = options.bootstrap;
    this.getServices = options.getServices;
    this.onSnapshot = options.onSnapshot;
    this.uiContributionsProvider = options.getUiContributions;
    this.operationExecutor = options.executeOperation;

    const providedHooks = options.hooks ?? {};

    // Плагин с объявленным каталогом миграций не должен активироваться
    // молча, если composition root забыл подключить Storage hook.
    this.hooks = {
      ...providedHooks,
      migrate:
        providedHooks.migrate ??
        (async (context) => {
          if (context.migrationsPath !== null) {
            throw new Error("Storage migrations hook не настроен");
          }
        }),
    };
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

      // Пока деактивация не подтверждена, новые lifecycle-операции не должны
      // реактивировать ни сбойный, ни остальные плагины: старый экземпляр мог
      // остаться активным. Восстановление — только перезапуск процесса.
      if (this.blockedPluginIds.size > 0) {
        throw this.processRestartRequired(this.snapshot);
      }

      if (!snapshot.plugins.some((plugin) => plugin.pluginId === pluginId)) {
        throw new PluginServiceError("NOT_FOUND");
      }

      const currentlyEnabled = !this.disabledPlugins.has(pluginId);

      if (currentlyEnabled === enabled) {
        return toManagerState(snapshot, this.disabledPlugins);
      }

      const stopResult = await this.stopCurrentRuntime();

      if (stopResult.faults.length > 0) {
        throw this.failDeactivation(stopResult);
      }

      if (enabled) {
        this.disabledPlugins.delete(pluginId);
      } else {
        this.disabledPlugins.add(pluginId);
      }

      return this.restartInternal();
    });
  }

  /**
   * Повторное обнаружение плагинов.
   *
   * Если предыдущая деактивация не подтверждена, refresh не является retry:
   * blockedPluginIds не очищаются, новый runtime не создаётся, а клиент
   * получает stopped snapshot и требование перезапустить процесс. KAN-003 не
   * предоставляет API подтверждённой очистки старого экземпляра, поэтому
   * выдавать refresh за восстановление нельзя.
   */
  /** UI-метаданные активных плагинов для серверного layout. */
  getUiContributions(): Promise<readonly PluginUiContributionRecord[]> {
    return this.enqueue(async () => {
      await this.ensureStarted();

      return this.uiContributionsProvider?.() ?? [];
    });
  }

  /**
   * Выполняет UI-операцию через общий OperationBus.
   *
   * Composition root проверяет `exposure.ui`; сервис только сериализует
   * lifecycle и не создаёт отдельную реализацию для UI.
   */
  executeUiOperation(
    operationId: string,
    input: JsonValue,
    options?: UiOperationInvokeOptions,
  ): Promise<OperationResult<unknown>> {
    return this.enqueue(async () => {
      await this.ensureStarted();

      if (this.operationExecutor === undefined) {
        return {
          ok: false,
          error: {
            code: "PLUGIN_UNAVAILABLE",
            message: "OperationBus не подключён к composition root",
            retryable: true,
          },
        };
      }

      return this.operationExecutor(operationId, input, sanitizeUiOperationOptions(options));
    });
  }

  refresh(): Promise<PluginManagerState> {
    return this.enqueue(async () => {
      if (this.blockedPluginIds.size > 0) {
        throw this.processRestartRequired(this.snapshot);
      }

      if (this.runtime !== null && this.snapshot !== null) {
        const stopResult = await this.stopCurrentRuntime();

        if (stopResult.faults.length > 0) {
          throw this.failDeactivation(stopResult);
        }
      }

      return this.restartInternal();
    });
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await this.runtime?.stop();
      } catch {
        // Завершение процесса не должно падать из-за ошибки деактивации.
      }

      this.runtime = null;
      this.snapshot = null;
      this.blockedPluginIds.clear();
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

    // Storage bootstrap выполняется до старта runtime плагинов и только один
    // раз. Ошибка оставляет флаг сброшенным: следующий запрос повторит
    // инициализацию, а runtime не будет запущен на неготовом хранилище.
    if (!this.bootstrapDone && this.bootstrap !== undefined) {
      await this.bootstrap();
      this.bootstrapDone = true;
    }

    this.runtime ??= this.createRuntime();
    this.snapshot = await this.runtime.start();
    this.onSnapshot?.(this.snapshot);

    return this.snapshot;
  }

  private async stopCurrentRuntime(): Promise<StopResult> {
    const runtime = this.runtime;

    if (runtime === null) {
      return { snapshot: this.snapshot, faults: [], failedPluginIds: [] };
    }

    const before = this.snapshot ?? runtime.getSnapshot();

    try {
      const stopped = await runtime.stop();

      this.snapshot = stopped;

      const { faults, failedPluginIds } = collectDeactivationFaults(before, stopped);

      return { snapshot: stopped, faults, failedPluginIds };
    } catch {
      // stop() публичного runtime сам не бросает при ошибке deactivate:
      // плагин получает диагностику `deactivation_failed`. Ветка страхует
      // интеграцию с другим runtime и не позволяет выдать остановку за успех.
      const failedPluginIds = before.plugins
        .filter((plugin) => plugin.activated && plugin.pluginId !== null)
        .map((plugin) => plugin.pluginId as string);

      this.snapshot = before;

      return {
        snapshot: before,
        faults: failedPluginIds.map((pluginId) => ({
          code: "deactivation_failed",
          severity: "error",
          phase: "deactivation",
          pluginId,
          source: null,
          message: PLUGIN_DIAGNOSTIC_MESSAGES.deactivation_failed,
        })),
        failedPluginIds,
      };
    }
  }

  private deactivationError(snapshot: PluginRuntimeSnapshot | null): PluginServiceError {
    return new PluginServiceError(
      "DEACTIVATION_FAILED",
      snapshot === null ? null : toManagerState(snapshot, this.disabledPlugins),
    );
  }

  /**
   * Без подтверждённой очистки старого экземпляра никакой in-process retry
   * невозможен. Возвращаем stopped snapshot и стабильное требование
   * перезапуска процесса.
   */
  private processRestartRequired(snapshot: PluginRuntimeSnapshot | null): PluginServiceError {
    return new PluginServiceError(
      "PROCESS_RESTART_REQUIRED",
      snapshot === null ? null : toManagerState(snapshot, this.disabledPlugins),
    );
  }

  private failDeactivation(stopResult: StopResult): PluginServiceError {
    for (const pluginId of stopResult.failedPluginIds) {
      this.blockedPluginIds.add(pluginId);
    }

    // Runtime остановлен и не пересоздаётся до явного retry.
    this.runtime = null;
    this.snapshot = stopResult.snapshot;

    return this.deactivationError(stopResult.snapshot);
  }

  private async restartInternal(): Promise<PluginManagerState> {
    this.runtime = this.createRuntime();
    this.snapshot = await this.runtime.start();
    this.onSnapshot?.(this.snapshot);

    return toManagerState(this.snapshot, this.disabledPlugins);
  }

  private createRuntime(): PluginRuntime {
    const services = this.getServices?.();

    return createPluginRuntime({
      pluginDirectories: this.pluginDirectories,
      hostApiVersion: this.hostApiVersion,
      disabledPlugins: [...this.disabledPlugins],
      hooks: this.hooks,
      logger: this.logger,
      ...(services === undefined ? {} : { services }),
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
  globalHolder[SERVICE_KEY] ??= createDefaultPluginService();

  return globalHolder[SERVICE_KEY];
}

function createCompositionLogger(): PluginLogger {
  return {
    debug(): void {
      // Debug-шум не нужен production composition.
    },
    info(): void {
      // Намеренно пусто.
    },
    warn(message, fields): void {
      if (process.env.NODE_ENV === "development") {
        console.warn(`[kanbaner] ${message}`, fields ?? {});
      }
    },
    error(message, fields): void {
      if (process.env.NODE_ENV === "development") {
        console.error(`[kanbaner] ${message}`, fields ?? {});
      }
    },
  };
}

function createDefaultPluginService(): PluginService {
  let storage: ApplicationStorageRuntime | null = null;
  let composition: ApplicationPluginComposition | null = null;

  return createPluginService({
    bootstrap: async () => {
      const runtime = await getApplicationStorage();

      storage = runtime;
      composition = createApplicationPluginComposition({
        storage: runtime.provider,
        logger: createCompositionLogger(),
      });
    },
    getServices: () => composition?.services,
    onSnapshot: (snapshot) => {
      composition?.bindPlugins(
        snapshot.plugins
          .filter((plugin) => plugin.activated && plugin.pluginId !== null)
          .map((plugin) => plugin.pluginId as string),
      );
    },
    getUiContributions: () => composition?.listUiContributions() ?? [],
    executeOperation: async (operationId, input, options) => {
      if (composition === null) {
        return {
          ok: false,
          error: {
            code: "PLUGIN_UNAVAILABLE",
            message: "Composition root не инициализирован",
            retryable: true,
          },
        };
      }

      return composition.executeUiOperation(operationId, input, options);
    },
    hooks: {
      migrate: async (context) => {
        const runtime = storage ?? (await getApplicationStorage());

        storage = runtime;

        await migratePluginWithSqlite(context, {
          provider: runtime.provider,
          health: runtime.health,
        });
      },
    },
  });
}

/** Безопасное состояние для layout и plugin manager; не раскрывает пути. */
export async function getPluginManagerState(): Promise<PluginManagerState> {
  try {
    return await getPluginService().getState();
  } catch {
    return createFallbackState();
  }
}

/** UI-метаданные активных плагинов; ошибка не роняет layout. */
export async function getPluginUiContributions(): Promise<readonly PluginUiContributionRecord[]> {
  try {
    return await getPluginService().getUiContributions();
  } catch {
    return [];
  }
}

/** UI-вызов операции через общий bus; возвращает единый конверт. */
export async function executeUiPluginOperation(
  operationId: string,
  input: JsonValue,
  options?: UiOperationInvokeOptions,
): Promise<OperationResult<unknown>> {
  try {
    return await getPluginService().executeUiOperation(
      operationId,
      input,
      sanitizeUiOperationOptions(options),
    );
  } catch {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Не удалось выполнить операцию",
        retryable: false,
      },
    };
  }
}
