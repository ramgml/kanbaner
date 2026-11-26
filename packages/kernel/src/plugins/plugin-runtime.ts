import { stat } from "node:fs/promises";

import {
  isPluginId,
  type JsonValue,
  type PluginHostServices,
  type PluginManifest,
} from "@kanbaner/plugin-sdk";

import type {
  PluginActivationContext,
  PluginDeactivationContext,
  PluginDiagnostic,
  PluginDiagnosticCode,
  PluginLifecycleHooks,
  PluginLifecyclePhase,
  PluginMigrationContext,
  PluginProblem,
  PluginProblemStatus,
  PluginRuntimeLogger,
  PluginRuntimeSnapshot,
  PluginServerModule,
  PluginStateSnapshot,
  PluginStatus,
} from "../lifecycle/index.ts";
import { summarizePluginManifest } from "../lifecycle/index.ts";
import {
  bindPluginServices,
  createUnavailableHostServices,
  type BoundPluginServices,
} from "./activation-services.ts";
import { buildPluginGraph, type DependencyNode } from "./dependency-graph.ts";
import { compareStrings, createDiagnostic, deepFreeze, cloneJson } from "./diagnostics.ts";
import {
  discoverPluginManifests,
  type DiscoveredPluginFailure,
  type DiscoveredPluginManifest,
} from "./discovery.ts";
import { loadPluginServerModule } from "./loader.ts";
import { resolveLocalPluginPath } from "./local-path.ts";
import { parsePluginManifest } from "./manifest.ts";
import { DEFAULT_HOST_API_VERSION, isHostApiVersion, versionSatisfies } from "./version.ts";

export interface PluginRuntimeOptions {
  /** Корневые каталоги, в подкаталогах которых лежат `plugin.json`. */
  readonly pluginDirectories: readonly string[];
  /** Конкретная версия Host API; по умолчанию `1.0.0`. */
  readonly hostApiVersion?: string;
  /** Plugin ID, отключённые конфигурацией до активации. */
  readonly disabledPlugins?: readonly string[];
  /** Запустить ядро без активации плагинов. */
  readonly safeMode?: boolean;
  readonly hooks?: PluginLifecycleHooks;
  readonly logger?: PluginRuntimeLogger;
  /**
   * Общие сервисы composition root: commands/queries/resources/events/storage/ui.
   *
   * Если не переданы, runtime использует безопасные unavailable defaults:
   * регистрация завершается ошибкой активации, а не молчаливым успехом.
   */
  readonly services?: PluginHostServices;
}

/** Публичный интерфейс runtime для composition root и plugin manager. */
export interface PluginRuntime {
  /** Обнаруживает, проверяет и активирует плагины. Идемпотентен при запуске. */
  start(): Promise<PluginRuntimeSnapshot>;
  /** Деактивирует активные плагины в обратном порядке. */
  stop(): Promise<PluginRuntimeSnapshot>;
  /** Публичный снимок состояния; не содержит внутренних структур. */
  getSnapshot(): PluginRuntimeSnapshot;
  getState(pluginId: string): PluginStateSnapshot | undefined;
  getDiagnostics(): readonly PluginDiagnostic[];
  getActivationOrder(): readonly string[];
  getDeactivationOrder(): readonly string[];
  isSafeMode(): boolean;
}

interface PluginRecord {
  readonly key: string;
  readonly directory: string;
  readonly source: string;
  pluginId: string | null;
  manifest: PluginManifest | null;
  status: PluginStatus;
  diagnostics: PluginDiagnostic[];
  serverEntrypointPath: string | null;
  migrationsPath: string | null;
  module: PluginServerModule | null;
  activated: boolean;
  deactivated: boolean;
  activationIndex: number | null;
  /** Привязанные сервисы активации; создаются один раз и освобождаются. */
  boundServices: BoundPluginServices | null;
}

interface ResolvedPluginRuntimeOptions {
  readonly pluginDirectories: readonly string[];
  readonly hostApiVersion: string;
  readonly disabledPlugins: ReadonlySet<string>;
  readonly safeMode: boolean;
  readonly hooks: PluginLifecycleHooks;
  readonly logger: PluginRuntimeLogger;
  readonly services: PluginHostServices;
}

interface DependencyBlock {
  readonly status: "missing_dependency" | "incompatible";
  readonly code: PluginDiagnosticCode;
  readonly message: string;
  readonly details: Readonly<Record<string, JsonValue>>;
}

const PROBLEM_STATUS_SET = new Set<PluginStatus>([
  "failed",
  "incompatible",
  "missing_dependency",
  "safe_mode",
]);

const NOOP_LOGGER: PluginRuntimeLogger = {
  log: () => {
    // Логирование включается вызывающей стороной; по умолчанию runtime молчит.
  },
};

function recordSortKey(record: PluginRecord): string {
  return `${record.pluginId ?? ""}\u0000${record.source}\u0000${record.key}`;
}

function isNeutralStatus(status: PluginStatus): boolean {
  return status === "manifest_validated";
}

/** Поглощает rejected Promise от логгера/наблюдателя, не создавая unhandled rejection. */
function consumeAsyncResult(result: void | Promise<void>): void {
  void Promise.resolve(result).catch(() => {
    // Ошибка наблюдателя не влияет на lifecycle плагинов.
  });
}

function baseDiagnostic(
  record: PluginRecord,
  code: PluginDiagnosticCode,
  phase: PluginLifecyclePhase,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): PluginDiagnostic {
  return details === undefined
    ? createDiagnostic({
        code,
        severity: "error",
        phase,
        pluginId: record.pluginId,
        source: record.source,
        message,
      })
    : createDiagnostic({
        code,
        severity: "error",
        phase,
        pluginId: record.pluginId,
        source: record.source,
        message,
        details,
      });
}

class PluginRuntimeImpl implements PluginRuntime {
  private readonly options: ResolvedPluginRuntimeOptions;
  private records: PluginRecord[] = [];
  private recordsById = new Map<string, PluginRecord>();
  private diagnostics: PluginDiagnostic[] = [];
  private activationOrder: string[] = [];
  private deactivationOrder: string[] = [];
  private runtimeProblems: PluginProblem[] = [];
  private started = false;
  private runtimeFailed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: PluginRuntimeOptions) {
    this.options = resolveOptions(options);
  }

  start(): Promise<PluginRuntimeSnapshot> {
    return this.enqueue(async () => {
      if (this.started) {
        return this.getSnapshot();
      }

      return this.runStart();
    });
  }

  stop(): Promise<PluginRuntimeSnapshot> {
    return this.enqueue(() => this.runStop());
  }

  /**
   * Сериализует lifecycle-операции.
   *
   * `await stop()` всегда ждёт завершения деактивации, даже если `start()` ещё
   * выполняется. `start()` во время `stop()` запускается после деактивации.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  getSnapshot(): PluginRuntimeSnapshot {
    const plugins = [...this.records]
      .sort((left, right) => compareStrings(recordSortKey(left), recordSortKey(right)))
      .map((record) => this.toStateSnapshot(record));
    const problems: PluginProblem[] = [];

    for (const plugin of plugins) {
      if (!PROBLEM_STATUS_SET.has(plugin.status)) {
        continue;
      }

      const lastDiagnostic = plugin.diagnostics[plugin.diagnostics.length - 1];

      problems.push({
        pluginId: plugin.pluginId,
        source: plugin.source,
        status: plugin.status as PluginProblemStatus,
        code: lastDiagnostic?.code ?? "runtime_failed",
        message: lastDiagnostic?.message ?? "Плагин не активирован",
      });
    }

    problems.push(...this.runtimeProblems.map((problem) => ({ ...problem })));

    const safeMode =
      this.options.safeMode ||
      this.runtimeFailed ||
      this.runtimeProblems.length > 0 ||
      problems.length > 0;

    return deepFreeze({
      mode: safeMode ? "safe_mode" : "normal",
      safeMode,
      started: this.started,
      activationOrder: [...this.activationOrder],
      deactivationOrder: [...this.deactivationOrder],
      plugins,
      problems,
      diagnostics: this.diagnostics.map((diagnostic) => cloneJson(diagnostic)),
    });
  }

  getState(pluginId: string): PluginStateSnapshot | undefined {
    return this.getSnapshot().plugins.find((plugin) => plugin.pluginId === pluginId);
  }

  getDiagnostics(): readonly PluginDiagnostic[] {
    return this.getSnapshot().diagnostics;
  }

  getActivationOrder(): readonly string[] {
    return deepFreeze([...this.activationOrder]);
  }

  getDeactivationOrder(): readonly string[] {
    return deepFreeze([...this.deactivationOrder]);
  }

  isSafeMode(): boolean {
    return this.getSnapshot().safeMode;
  }

  private async runStart(): Promise<PluginRuntimeSnapshot> {
    this.resetState();

    try {
      const discovery = await discoverPluginManifests(this.options.pluginDirectories);

      const failureDiagnostics = new Set(discovery.failures.map((failure) => failure.diagnostic));

      for (const diagnostic of discovery.diagnostics) {
        if (failureDiagnostics.has(diagnostic)) {
          continue;
        }

        this.addDiagnostic(null, diagnostic);
        this.runtimeProblems.push({
          pluginId: null,
          source: diagnostic.source ?? "runtime",
          status: "failed",
          code: diagnostic.code,
          message: diagnostic.message,
        });
      }

      this.records = [
        ...discovery.manifests.map((manifest) => this.createRecord(manifest)),
        ...discovery.failures.map((failure) => this.createFailureRecord(failure)),
      ];

      const duplicateIds = this.markDuplicateIds();

      for (const record of this.records) {
        if (record.manifest === null || duplicateIds.has(record.manifest.id)) {
          continue;
        }

        this.recordsById.set(record.manifest.id, record);
      }

      for (const record of this.records) {
        if (record.manifest === null || !isNeutralStatus(record.status)) {
          continue;
        }

        if (this.options.disabledPlugins.has(record.manifest.id)) {
          record.status = "disabled";
          this.addDiagnostic(
            record,
            baseDiagnostic(
              record,
              "plugin_disabled",
              "dependency_resolution",
              "Плагин отключён конфигурацией",
            ),
          );
          continue;
        }

        const incompatible = this.checkHostApi(record);

        if (incompatible) {
          continue;
        }

        await this.resolveLocalPaths(record);
      }

      const graphNodes: DependencyNode[] = [];

      for (const record of this.records) {
        if (record.manifest === null || !isNeutralStatus(record.status)) {
          continue;
        }

        graphNodes.push({
          id: record.manifest.id,
          version: record.manifest.version,
          requires: record.manifest.requires,
        });
      }

      const graph = buildPluginGraph(graphNodes);

      this.markCycles(graph.cycles);
      this.resolveDependencies(graph.order, graph.nodesById);

      const ready = graph.order.filter((id) => {
        const record = this.recordsById.get(id);

        return record !== undefined && isNeutralStatus(record.status);
      });

      if (this.options.safeMode) {
        for (const id of ready) {
          const record = this.recordsById.get(id);

          if (record === undefined) {
            continue;
          }

          record.status = "safe_mode";
          this.addDiagnostic(
            record,
            baseDiagnostic(
              record,
              "safe_mode",
              "runtime",
              "Плагин не активирован: ядро запущено в safe mode",
            ),
          );
        }
      } else {
        for (const id of ready) {
          const record = this.recordsById.get(id);

          if (record === undefined) {
            continue;
          }

          const block = this.findActivationDependencyBlock(record);

          if (block !== null) {
            record.status = block.status;
            this.addDiagnostic(
              record,
              baseDiagnostic(record, block.code, "server_activation", block.message, block.details),
            );
            continue;
          }

          await this.activateRecord(record);
        }
      }

      this.started = true;
    } catch {
      this.addDiagnostic(
        null,
        createDiagnostic({
          code: "runtime_failed",
          severity: "error",
          phase: "runtime",
          pluginId: null,
          source: null,
          message: "Runtime плагинов завершился с ошибкой",
        }),
      );
      this.runtimeFailed = true;
      this.started = true;
    }

    return this.getSnapshot();
  }

  private async runStop(): Promise<PluginRuntimeSnapshot> {
    const order = [...this.activationOrder].reverse();
    this.deactivationOrder = [];

    for (const pluginId of order) {
      const record = this.recordsById.get(pluginId);

      if (record === undefined || !record.activated) {
        continue;
      }

      this.deactivationOrder.push(pluginId);
      await this.deactivateRecord(record);
    }

    this.started = false;

    return this.getSnapshot();
  }

  private resetState(): void {
    this.records = [];
    this.recordsById = new Map();
    this.diagnostics = [];
    this.activationOrder = [];
    this.deactivationOrder = [];
    this.runtimeProblems = [];
    this.started = false;
    this.runtimeFailed = false;
  }

  private createRecord(manifest: DiscoveredPluginManifest): PluginRecord {
    const parsed = parsePluginManifest(manifest.text, manifest.source);
    const record: PluginRecord = {
      key: `${manifest.rootIndex}\u0000${manifest.source}`,
      directory: manifest.directory,
      source: manifest.source,
      pluginId: parsed.pluginId,
      manifest: parsed.manifest,
      status: parsed.manifest === null ? "failed" : "manifest_validated",
      diagnostics: [],
      serverEntrypointPath: null,
      migrationsPath: null,
      module: null,
      activated: false,
      deactivated: false,
      activationIndex: null,
      boundServices: null,
    };

    if (parsed.diagnostic !== null) {
      this.addDiagnostic(record, parsed.diagnostic);
    }

    return record;
  }

  private createFailureRecord(failure: DiscoveredPluginFailure): PluginRecord {
    const record: PluginRecord = {
      key: `failure\u0000${failure.rootIndex}\u0000${failure.source}`,
      directory: failure.directory,
      source: failure.source,
      pluginId: null,
      manifest: null,
      status: "failed",
      diagnostics: [],
      serverEntrypointPath: null,
      migrationsPath: null,
      module: null,
      activated: false,
      deactivated: false,
      activationIndex: null,
      boundServices: null,
    };

    this.addDiagnostic(record, failure.diagnostic);

    return record;
  }

  private markDuplicateIds(): ReadonlySet<string> {
    const duplicateIds = new Set<string>();
    const groups = new Map<string, PluginRecord[]>();

    for (const record of this.records) {
      if (record.manifest === null || !isNeutralStatus(record.status)) {
        continue;
      }

      const group = groups.get(record.manifest.id) ?? [];
      group.push(record);
      groups.set(record.manifest.id, group);
    }

    for (const [pluginId, group] of groups) {
      if (group.length < 2) {
        continue;
      }

      const sources = group.map((record) => record.source).sort(compareStrings);

      duplicateIds.add(pluginId);

      for (const record of group) {
        record.status = "failed";
        this.addDiagnostic(
          record,
          baseDiagnostic(
            record,
            "duplicate_plugin_id",
            "manifest_validation",
            "Plugin ID объявлен более одного раза",
            { pluginId, sources },
          ),
        );
      }
    }

    return duplicateIds;
  }

  private checkHostApi(record: PluginRecord): boolean {
    const manifest = record.manifest;

    if (manifest === null) {
      return true;
    }

    if (versionSatisfies(this.options.hostApiVersion, manifest.hostApi)) {
      return false;
    }

    record.status = "incompatible";
    this.addDiagnostic(
      record,
      baseDiagnostic(
        record,
        "host_api_incompatible",
        "dependency_resolution",
        "Плагин несовместим с версией Host API",
        {
          hostApiVersion: this.options.hostApiVersion,
          requiredRange: manifest.hostApi,
        },
      ),
    );

    return true;
  }

  private async resolveLocalPaths(record: PluginRecord): Promise<void> {
    const manifest = record.manifest;

    if (manifest === null) {
      return;
    }

    const serverEntrypoint = manifest.entrypoints.server;

    if (serverEntrypoint !== undefined) {
      const resolved = await resolveLocalPluginPath(record.directory, serverEntrypoint);

      if (!resolved.ok) {
        this.failRecord(
          record,
          resolved.reason === "not_found" ? "entrypoint_not_found" : "entrypoint_invalid",
          resolved.reason === "not_found"
            ? "Серверная точка входа не найдена"
            : "Серверная точка входа должна быть локальным файлом плагина",
          "manifest_validation",
          { reason: resolved.reason },
        );
        return;
      }

      try {
        const info = await stat(resolved.path);

        if (!info.isFile()) {
          this.failRecord(
            record,
            "entrypoint_not_found",
            "Серверная точка входа не является файлом",
            "manifest_validation",
          );
          return;
        }
      } catch {
        this.failRecord(
          record,
          "entrypoint_not_found",
          "Серверная точка входа не найдена",
          "manifest_validation",
        );
        return;
      }

      record.serverEntrypointPath = resolved.path;
    }

    if (manifest.migrations !== undefined) {
      const resolved = await resolveLocalPluginPath(record.directory, manifest.migrations);

      if (!resolved.ok) {
        this.failRecord(
          record,
          "migrations_path_invalid",
          "Каталог миграций должен находиться внутри каталога плагина",
          "manifest_validation",
          { reason: resolved.reason },
        );
        return;
      }

      try {
        const info = await stat(resolved.path);

        if (!info.isDirectory()) {
          this.failRecord(
            record,
            "migrations_path_invalid",
            "Каталог миграций должен быть каталогом",
            "manifest_validation",
            { reason: "not_directory" },
          );
          return;
        }
      } catch {
        this.failRecord(
          record,
          "migrations_path_invalid",
          "Каталог миграций не найден",
          "manifest_validation",
          { reason: "not_found" },
        );
        return;
      }

      record.migrationsPath = resolved.path;
    }
  }

  private markCycles(cycles: readonly (readonly string[])[]): void {
    for (const cycle of cycles) {
      for (const pluginId of cycle) {
        const record = this.recordsById.get(pluginId);

        if (record === undefined || !isNeutralStatus(record.status)) {
          continue;
        }

        record.status = "failed";
        this.addDiagnostic(
          record,
          baseDiagnostic(
            record,
            "dependency_cycle",
            "dependency_resolution",
            "Обнаружен цикл зависимостей плагинов",
            { participants: [...cycle] },
          ),
        );
      }
    }
  }

  private resolveDependencies(
    order: readonly string[],
    nodesById: ReadonlyMap<string, DependencyNode>,
  ): void {
    for (const pluginId of order) {
      const record = this.recordsById.get(pluginId);

      if (record === undefined || !isNeutralStatus(record.status)) {
        continue;
      }

      const block = this.findDependencyBlock(record, nodesById);

      if (block === null) {
        continue;
      }

      record.status = block.status;
      this.addDiagnostic(
        record,
        baseDiagnostic(record, block.code, "dependency_resolution", block.message, block.details),
      );
    }
  }

  private findDependencyBlock(
    record: PluginRecord,
    nodesById: ReadonlyMap<string, DependencyNode>,
  ): DependencyBlock | null {
    const manifest = record.manifest;

    if (manifest === null) {
      return null;
    }

    const dependencies = Object.entries(manifest.requires).sort((left, right) =>
      compareStrings(left[0], right[0]),
    );

    for (const [dependency, requiredRange] of dependencies) {
      const dependencyNode = nodesById.get(dependency);

      if (dependencyNode === undefined) {
        const known = this.recordsById.get(dependency);

        return known === undefined
          ? {
              status: "missing_dependency",
              code: "missing_dependency",
              message: "Обязательный плагин не найден",
              details: { dependency, requiredRange },
            }
          : {
              status: "missing_dependency",
              code: "dependency_unavailable",
              message: "Обязательный плагин недоступен",
              details: {
                dependency,
                requiredRange,
                dependencyStatus: known.status,
              },
            };
      }

      if (!versionSatisfies(dependencyNode.version, requiredRange)) {
        return {
          status: "incompatible",
          code: "dependency_version_unsatisfied",
          message: "Версия обязательного плагина не удовлетворяет диапазону",
          details: {
            dependency,
            requiredRange,
            actualVersion: dependencyNode.version,
          },
        };
      }

      const dependencyRecord = this.recordsById.get(dependency);

      if (dependencyRecord === undefined || !isNeutralStatus(dependencyRecord.status)) {
        return {
          status: "missing_dependency",
          code: "dependency_unavailable",
          message: "Обязательный плагин недоступен",
          details: {
            dependency,
            requiredRange,
            dependencyStatus: dependencyRecord?.status ?? "unknown",
          },
        };
      }
    }

    return null;
  }

  private findActivationDependencyBlock(record: PluginRecord): DependencyBlock | null {
    const manifest = record.manifest;

    if (manifest === null) {
      return null;
    }

    const dependencies = Object.entries(manifest.requires).sort((left, right) =>
      compareStrings(left[0], right[0]),
    );

    for (const [dependency, requiredRange] of dependencies) {
      const dependencyRecord = this.recordsById.get(dependency);

      if (dependencyRecord === undefined || dependencyRecord.manifest === null) {
        return {
          status: "missing_dependency",
          code: "missing_dependency",
          message: "Обязательный плагин не найден",
          details: { dependency, requiredRange },
        };
      }

      if (!versionSatisfies(dependencyRecord.manifest.version, requiredRange)) {
        return {
          status: "incompatible",
          code: "dependency_version_unsatisfied",
          message: "Версия обязательного плагина не удовлетворяет диапазону",
          details: {
            dependency,
            requiredRange,
            actualVersion: dependencyRecord.manifest.version,
          },
        };
      }

      if (dependencyRecord.status !== "active") {
        return {
          status: "missing_dependency",
          code: "dependency_unavailable",
          message: "Обязательный плагин недоступен",
          details: {
            dependency,
            requiredRange,
            dependencyStatus: dependencyRecord.status,
          },
        };
      }
    }

    return null;
  }

  private async activateRecord(record: PluginRecord): Promise<void> {
    const manifest = record.manifest;

    if (manifest === null || record.pluginId === null) {
      return;
    }

    record.status = "dependencies_resolved";

    const migrationContext: PluginMigrationContext = {
      pluginId: record.pluginId,
      manifest,
      directory: record.directory,
      hostApiVersion: this.options.hostApiVersion,
      manifestVersion: manifest.version,
      migrationsPath: record.migrationsPath,
    };

    try {
      await this.options.hooks.migrate?.(migrationContext);
    } catch {
      this.failRecord(record, "migration_failed", "Hook миграций завершился ошибкой", "migration");
      return;
    }

    record.status = "migrated";

    const activationContext = this.activationContext(record);

    try {
      await this.options.hooks.beforeActivate?.(activationContext);
    } catch {
      this.failRecord(
        record,
        "hook_failed",
        "Hook перед активацией завершился ошибкой",
        "server_activation",
        { hook: "beforeActivate" },
      );
      this.releaseServices(record);
      return;
    }

    if (record.serverEntrypointPath !== null) {
      let loaded;

      try {
        loaded = await loadPluginServerModule(record.serverEntrypointPath);
      } catch {
        this.failRecord(
          record,
          "entrypoint_invalid_module",
          "Серверный модуль плагина не загрузился",
          "server_activation",
        );
        this.releaseServices(record);
        return;
      }

      if (!loaded.ok) {
        this.failRecord(
          record,
          loaded.reason === "import_failed" ? "module_import_failed" : "entrypoint_invalid_module",
          loaded.reason === "import_failed"
            ? "Серверный модуль плагина не загрузился"
            : "Серверный модуль не экспортирует activate/deactivate",
          "server_activation",
        );
        this.releaseServices(record);
        return;
      }

      record.module = loaded.module;

      if (loaded.module.activate !== undefined) {
        try {
          await loaded.module.activate(activationContext);
        } catch {
          this.failRecord(
            record,
            "activation_failed",
            "Серверная активация плагина завершилась ошибкой",
            "server_activation",
            { stage: "activate" },
          );
          await this.rollbackRecord(record);
          return;
        }
      }

      record.status = "server_activated";
    }

    try {
      await this.options.hooks.afterActivate?.(activationContext);
    } catch {
      this.failRecord(
        record,
        "hook_failed",
        "Hook после активации завершился ошибкой",
        "server_activation",
        { hook: "afterActivate" },
      );
      await this.rollbackRecord(record);
      return;
    }

    record.status = "active";
    record.activated = true;
    record.activationIndex = this.activationOrder.length;
    this.activationOrder.push(record.pluginId);
  }

  private async rollbackRecord(record: PluginRecord): Promise<void> {
    if (record.module?.deactivate !== undefined) {
      try {
        await record.module.deactivate(this.deactivationContext(record));
      } catch {
        this.addDiagnostic(
          record,
          baseDiagnostic(
            record,
            "rollback_failed",
            "server_activation",
            "Откат серверной активации завершился ошибкой",
            { stage: "rollback" },
          ),
        );
      }
    }

    // Регистрации могли произойти до падения activate/afterActivate, поэтому
    // очистка не зависит от наличия deactivate.
    this.releaseServices(record);
  }

  /**
   * Снимает все регистрации плагина в общих сервисах.
   *
   * Данные и связи не удаляются: деактивация не является удалением.
   */
  private releaseServices(record: PluginRecord): void {
    const services = record.boundServices;

    record.boundServices = null;

    if (services === undefined || services === null) {
      return;
    }

    try {
      services.dispose();
    } catch {
      this.addDiagnostic(
        record,
        baseDiagnostic(
          record,
          "rollback_failed",
          "deactivation",
          "Освобождение сервисов плагина завершилось ошибкой",
        ),
      );
    }
  }

  private async deactivateRecord(record: PluginRecord): Promise<void> {
    const context = this.deactivationContext(record);
    let failed = false;

    try {
      await this.options.hooks.beforeDeactivate?.(context);
    } catch {
      failed = true;
      this.addDiagnostic(
        record,
        baseDiagnostic(
          record,
          "hook_failed",
          "deactivation",
          "Hook перед деактивацией завершился ошибкой",
          { hook: "beforeDeactivate" },
        ),
      );
    }

    if (record.module?.deactivate !== undefined) {
      try {
        await record.module.deactivate(context);
      } catch {
        failed = true;
        this.addDiagnostic(
          record,
          baseDiagnostic(
            record,
            "deactivation_failed",
            "deactivation",
            "Серверная деактивация плагина завершилась ошибкой",
            { stage: "deactivate" },
          ),
        );
      }
    }

    try {
      await this.options.hooks.afterDeactivate?.(context);
    } catch {
      failed = true;
      this.addDiagnostic(
        record,
        baseDiagnostic(
          record,
          "hook_failed",
          "deactivation",
          "Hook после деактивации завершился ошибкой",
          { hook: "afterDeactivate" },
        ),
      );
    }

    record.activated = false;
    record.deactivated = true;
    this.releaseServices(record);

    if (failed) {
      record.status = "failed";
      return;
    }

    record.status = "disabled";
    this.addDiagnostic(
      record,
      createDiagnostic({
        code: "plugin_stopped",
        severity: "info",
        phase: "stopped",
        pluginId: record.pluginId,
        source: record.source,
        message: "Плагин деактивирован",
      }),
    );
  }

  private activationContext(record: PluginRecord): PluginActivationContext {
    const manifest = record.manifest;

    if (manifest === null || record.pluginId === null) {
      throw new TypeError("Контекст активации недоступен без манифеста");
    }

    record.boundServices ??= bindPluginServices(this.options.services, record.pluginId);

    return {
      pluginId: record.pluginId,
      manifest: cloneJson(manifest),
      directory: record.directory,
      hostApiVersion: this.options.hostApiVersion,
      logger: this.options.logger,
      ...record.boundServices,
    };
  }

  private deactivationContext(record: PluginRecord): PluginDeactivationContext {
    return this.activationContext(record);
  }

  private failRecord(
    record: PluginRecord,
    code: PluginDiagnosticCode,
    message: string,
    phase: PluginLifecyclePhase,
    details?: Readonly<Record<string, JsonValue>>,
  ): void {
    record.status = "failed";
    this.addDiagnostic(record, baseDiagnostic(record, code, phase, message, details));
  }

  private addDiagnostic(record: PluginRecord | null, diagnostic: PluginDiagnostic): void {
    const safeDiagnostic = deepFreeze(cloneJson(diagnostic));

    this.diagnostics.push(safeDiagnostic);

    if (record !== null) {
      record.diagnostics.push(safeDiagnostic);
    }

    try {
      consumeAsyncResult(this.options.hooks.onDiagnostic?.(safeDiagnostic));
    } catch {
      // Ошибка наблюдателя не влияет на lifecycle плагинов.
    }

    try {
      consumeAsyncResult(
        this.options.logger.log(
          safeDiagnostic.severity === "error"
            ? "error"
            : safeDiagnostic.severity === "warning"
              ? "warn"
              : "info",
          safeDiagnostic.message,
          safeDiagnostic.details,
        ),
      );
    } catch {
      // Ошибка логгера не влияет на lifecycle плагинов.
    }
  }

  private toStateSnapshot(record: PluginRecord): PluginStateSnapshot {
    return {
      pluginId: record.pluginId,
      source: record.source,
      status: record.status,
      manifest: record.manifest === null ? null : summarizePluginManifest(record.manifest),
      diagnostics: record.diagnostics.map((diagnostic) => cloneJson(diagnostic)),
      activated: record.activated,
      deactivated: record.deactivated,
      activationIndex: record.activationIndex,
    };
  }
}

function resolveOptions(options: PluginRuntimeOptions): ResolvedPluginRuntimeOptions {
  if (!Array.isArray(options.pluginDirectories)) {
    throw new TypeError("pluginDirectories должен быть массивом путей");
  }

  for (const directory of options.pluginDirectories) {
    if (typeof directory !== "string" || directory.length === 0) {
      throw new TypeError("Путь к каталогу плагинов должен быть непустой строкой");
    }
  }

  const hostApiVersion = options.hostApiVersion ?? DEFAULT_HOST_API_VERSION;

  if (!isHostApiVersion(hostApiVersion)) {
    throw new TypeError("hostApiVersion должен быть конкретной SemVer-версией");
  }

  const disabledPlugins = new Set<string>();

  if (options.disabledPlugins !== undefined && !Array.isArray(options.disabledPlugins)) {
    throw new TypeError("disabledPlugins должен быть массивом Plugin ID");
  }

  for (const pluginId of options.disabledPlugins ?? []) {
    if (!isPluginId(pluginId)) {
      throw new TypeError("disabledPlugins содержит неверный Plugin ID");
    }

    disabledPlugins.add(pluginId);
  }

  return {
    pluginDirectories: [...options.pluginDirectories],
    hostApiVersion,
    disabledPlugins,
    safeMode: options.safeMode ?? false,
    hooks: options.hooks ?? {},
    logger: options.logger ?? NOOP_LOGGER,
    services: options.services ?? createUnavailableHostServices(),
  };
}

/** Создаёт runtime плагинов без выполнения I/O до вызова `start()`. */
export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  return new PluginRuntimeImpl(options);
}
