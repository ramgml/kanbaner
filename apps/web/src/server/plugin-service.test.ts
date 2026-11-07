// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginRuntimeLogger } from "@kanbaner/kernel";

import type { PluginManagerState } from "../lib/plugin-manager-types";
import {
  createPluginService,
  PluginServiceError,
  sanitizeDiagnosticDetails,
  sanitizeOutboundString,
  type PluginServiceOptions,
} from "./plugin-service";

interface FixturePlugin {
  readonly directory: string;
  readonly id: string;
  readonly version?: string;
  readonly requires?: Readonly<Record<string, string>>;
  readonly activateSource?: string;
  readonly serverSource?: string;
}

const temporaryDirectories: string[] = [];
const services: Array<ReturnType<typeof createPluginService>> = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kanbaner-kan007-"));
  temporaryDirectories.push(root);

  return root;
}

async function createPlugin(root: string, plugin: FixturePlugin): Promise<void> {
  const directory = path.join(root, plugin.directory);
  await mkdir(directory, { recursive: true });

  const manifest = {
    id: plugin.id,
    name: `Плагин ${plugin.id}`,
    version: plugin.version ?? "1.0.0",
    hostApi: "^1.0.0",
    entrypoints: { server: "./server.mjs" },
    requires: plugin.requires ?? {},
    consumes: [],
    provides: [],
    permissions: ["events"],
  };

  await writeFile(path.join(directory, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(directory, "server.mjs"),
    plugin.serverSource ??
      plugin.activateSource ??
      "export function activate() {}\nexport function deactivate() {}\n",
  );
}

function createService(
  pluginDirectories: readonly string[],
  options: Omit<PluginServiceOptions, "pluginDirectories"> = {},
) {
  const service = createPluginService({ pluginDirectories, ...options });
  services.push(service);

  return service;
}

async function captureServiceError(promise: Promise<unknown>): Promise<PluginServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PluginServiceError);

    return error as PluginServiceError;
  }

  throw new Error("Ожидалась PluginServiceError");
}

function requireState(error: PluginServiceError): PluginManagerState {
  if (error.state === null) {
    throw new Error("Ожидался безопасный snapshot вместе с ошибкой");
  }

  return error.state;
}

type GlobalWithActivationLog = typeof globalThis & {
  __kanbanerTestActivationLog?: string[];
};

function resetActivationLog(): void {
  (globalThis as GlobalWithActivationLog).__kanbanerTestActivationLog = [];
}

function activationLog(): readonly string[] {
  return (globalThis as GlobalWithActivationLog).__kanbanerTestActivationLog ?? [];
}

function journalSource(pluginId: string, deactivateThrows: boolean): string {
  const deactivate = deactivateThrows
    ? "throw new Error('/secret/deactivate');"
    : "return undefined;";

  return [
    "globalThis.__kanbanerTestActivationLog ??= [];",
    `export function activate() { globalThis.__kanbanerTestActivationLog.push(${JSON.stringify(pluginId)}); }`,
    `export function deactivate() { ${deactivate} }`,
    "",
  ].join("\n");
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("plugin service", () => {
  it("запускает публичный runtime и отдаёт безопасное состояние", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const service = createService([root]);
    const state = await service.getState();

    expect(state.started).toBe(true);
    expect(state.safeMode).toBe(false);
    expect(state.plugins).toHaveLength(1);
    expect(state.plugins[0]).toMatchObject({
      id: "example.one",
      name: "Плагин example.one",
      version: "1.0.0",
      hostApi: "^1.0.0",
      status: "active",
      activated: true,
      configuredEnabled: true,
    });
    expect(state.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const serialized = JSON.stringify(state);

    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("server.mjs");
    expect(serialized).not.toContain("entrypoints");
    expect(serialized).not.toContain("migrations");
  });

  it("отключает и включает плагин через stop + новый start", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const service = createService([root]);
    await service.getState();

    const disabled = await service.setPluginEnabled("example.one", false);

    expect(disabled.disabledPluginIds).toEqual(["example.one"]);
    expect(disabled.plugins[0]).toMatchObject({
      status: "disabled",
      configuredEnabled: false,
      activated: false,
    });
    expect(disabled.started).toBe(true);

    const refreshed = await service.refresh();
    expect(refreshed.plugins[0]?.status).toBe("disabled");
    expect(refreshed.disabledPluginIds).toEqual(["example.one"]);

    const enabled = await service.setPluginEnabled("example.one", true);

    expect(enabled.disabledPluginIds).toEqual([]);
    expect(enabled.plugins[0]).toMatchObject({
      status: "active",
      configuredEnabled: true,
      activated: true,
    });
  });

  it("показывает safe mode и безопасную причину падения плагина", async () => {
    const root = await createRoot();
    await createPlugin(root, {
      directory: "broken",
      id: "example.broken",
      activateSource:
        "export function activate() { throw new Error('/secret/path'); }\nexport function deactivate() {}\n",
    });

    const service = createService([root]);
    const state = await service.getState();

    expect(state.safeMode).toBe(true);
    expect(state.mode).toBe("safe_mode");
    expect(state.problems).toHaveLength(1);
    expect(state.problems[0]).toMatchObject({
      pluginId: "example.broken",
      status: "failed",
      code: "activation_failed",
    });

    const serialized = JSON.stringify(state);

    expect(serialized).not.toContain("/secret/path");
    expect(serialized).not.toContain(root);
    expect(serialized).toContain("Серверная активация плагина завершилась ошибкой");
  });

  it("не применяет отключение к неизвестному Plugin ID", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const service = createService([root]);

    await expect(service.setPluginEnabled("example.unknown", false)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("идемпотентно возвращает состояние без изменения конфигурации", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const service = createService([root]);

    await service.getState();

    const same = await service.setPluginEnabled("example.one", true);

    expect(same.disabledPluginIds).toEqual([]);
    expect(same.plugins[0]?.status).toBe("active");
  });

  it("изолирует rejected logger и не создаёт unhandled rejection", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const logger: PluginRuntimeLogger = {
      log: vi.fn().mockRejectedValue(new Error("logger failure")),
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const service = createService([root], { logger, disabledPlugins: ["example.one"] });
      const state = await service.getState();

      // Ждём macrotask: rejected Promise логгера должен быть поглощён до
      // снятия listener-а unhandledRejection.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(state.plugins[0]?.status).toBe("disabled");
      expect(unhandled).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("возвращает safe mode вместо исключения при недоступном корне", async () => {
    const service = createService([path.join(os.tmpdir(), "kanbaner-kan007-missing-root")]);
    const state = await service.getState();

    expect(state.safeMode).toBe(true);
    expect(state.problems[0]).toMatchObject({
      pluginId: null,
      status: "failed",
      code: "plugin_root_unavailable",
    });
    expect(state.problems[0]?.message).not.toContain(os.tmpdir());
  });

  it("сериализует конкурентные действия", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const service = createService([root]);

    await service.getState();

    const [first, second] = await Promise.all([
      service.setPluginEnabled("example.one", false),
      service.setPluginEnabled("example.one", true),
    ]);

    expect(first.disabledPluginIds).toEqual(["example.one"]);
    expect(second.disabledPluginIds).toEqual([]);
    expect(second.plugins[0]?.status).toBe("active");
  });

  it("обнаруживает новый плагин после refresh без пересоздания сервиса", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const service = createService([root]);
    const initial = await service.getState();

    expect(initial.plugins.map((plugin) => plugin.id)).toEqual(["example.one"]);

    await createPlugin(root, { directory: "two", id: "example.two", version: "2.0.0" });

    const refreshed = await service.refresh();

    expect(refreshed.plugins.map((plugin) => plugin.id)).toEqual(["example.one", "example.two"]);
    expect(refreshed.plugins[1]?.version).toBe("2.0.0");
    expect(refreshed.started).toBe(true);
  });

  it("не запускает новый runtime при ошибке деактивации и возвращает stopped snapshot", async () => {
    const root = await createRoot();
    await createPlugin(root, {
      directory: "one",
      id: "example.one",
      serverSource:
        "export function activate() {}\nexport function deactivate() { throw new Error('/secret/deactivate'); }\n",
    });

    const service = createService([root]);
    await service.getState();

    const error = await captureServiceError(service.setPluginEnabled("example.one", false));
    const state = requireState(error);

    expect(error.code).toBe("DEACTIVATION_FAILED");
    expect(state.started).toBe(false);
    expect(state.plugins[0]).toMatchObject({
      id: "example.one",
      status: "failed",
      activated: false,
      configuredEnabled: true,
    });
    expect(state.plugins[0]?.diagnostics.map((item) => item.code)).toContain("deactivation_failed");
    expect(state.problems[0]?.message).toBe("Серверная деактивация плагина завершилась ошибкой");
    expect(JSON.stringify(state)).not.toContain("/secret/deactivate");
    expect(JSON.stringify(state)).not.toContain(root);

    // getState не перезапускает runtime и сохраняет stopped snapshot.
    const stopped = await service.getState();

    expect(stopped.started).toBe(false);
    expect(stopped.plugins[0]?.status).toBe("failed");

    // Без подтверждённой очистки любая lifecycle-операция требует перезапуска процесса.
    const repeated = await captureServiceError(service.setPluginEnabled("example.one", true));
    const repeatedState = requireState(repeated);

    expect(repeated.code).toBe("PROCESS_RESTART_REQUIRED");
    expect(repeatedState.started).toBe(false);
    expect(repeatedState.plugins[0]?.activated).toBe(false);
  });

  it("повторный refresh не реактивирует плагин без подтверждённой деактивации", async () => {
    resetActivationLog();

    const root = await createRoot();
    await createPlugin(root, {
      directory: "one",
      id: "example.one",
      serverSource: journalSource("example.one", true),
    });

    const service = createService([root]);
    const initial = await service.getState();

    expect(initial.plugins[0]).toMatchObject({ status: "active", activated: true });
    expect(activationLog()).toEqual(["example.one"]);

    const failure = await captureServiceError(service.setPluginEnabled("example.one", false));

    expect(failure.code).toBe("DEACTIVATION_FAILED");
    expect(activationLog()).toEqual(["example.one"]);

    const firstRefresh = await captureServiceError(service.refresh());
    const firstState = requireState(firstRefresh);

    expect(firstRefresh.code).toBe("PROCESS_RESTART_REQUIRED");
    expect(firstState.started).toBe(false);
    expect(firstState.plugins[0]).toMatchObject({ status: "failed", activated: false });
    expect(firstState.plugins[0]?.diagnostics.map((item) => item.code)).toContain(
      "deactivation_failed",
    );
    expect(activationLog()).toEqual(["example.one"]);

    const secondRefresh = await captureServiceError(service.refresh());
    const secondState = requireState(secondRefresh);

    expect(secondRefresh.code).toBe("PROCESS_RESTART_REQUIRED");
    expect(secondState.started).toBe(false);
    expect(secondState.plugins[0]?.activated).toBe(false);
    expect(activationLog()).toEqual(["example.one"]);

    // Даже чтение состояния не запускает старый Plugin ID повторно.
    const stopped = await service.getState();

    expect(stopped.started).toBe(false);
    expect(activationLog()).toEqual(["example.one"]);
  });

  it("не запускает healthy plugins, пока деактивация не подтверждена", async () => {
    resetActivationLog();

    const root = await createRoot();
    await createPlugin(root, {
      directory: "bad",
      id: "example.bad",
      serverSource: journalSource("example.bad", true),
    });
    await createPlugin(root, {
      directory: "healthy",
      id: "example.healthy",
      serverSource: journalSource("example.healthy", false),
    });

    const service = createService([root]);
    const initial = await service.getState();

    expect(initial.plugins.map((plugin) => plugin.status)).toEqual(["active", "active"]);
    expect([...activationLog()].sort()).toEqual(["example.bad", "example.healthy"]);

    // Деактивация идёт в обратном порядке: healthy отключается первым,
    // затем bad падает. После этого новый runtime не должен запускаться.
    const failure = await captureServiceError(service.setPluginEnabled("example.bad", false));

    expect(failure.code).toBe("DEACTIVATION_FAILED");

    const refresh = await captureServiceError(service.refresh());
    const state = requireState(refresh);

    expect(refresh.code).toBe("PROCESS_RESTART_REQUIRED");
    expect(state.started).toBe(false);
    expect(state.plugins.find((plugin) => plugin.id === "example.bad")).toMatchObject({
      status: "failed",
      activated: false,
    });
    expect(activationLog().filter((id) => id === "example.bad")).toHaveLength(1);
    expect(activationLog().filter((id) => id === "example.healthy")).toHaveLength(1);
  });

  it("обнаруживает ошибку hook деактивации", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const service = createService([root], {
      hooks: {
        beforeDeactivate: () => {
          throw new Error("/secret/hook");
        },
      },
    });

    await service.getState();

    const error = await captureServiceError(service.setPluginEnabled("example.one", false));
    const state = requireState(error);

    expect(error.code).toBe("DEACTIVATION_FAILED");
    expect(state.started).toBe(false);
    expect(state.plugins[0]?.diagnostics.map((item) => item.code)).toContain("hook_failed");
    expect(JSON.stringify(state)).not.toContain("/secret/hook");
  });

  it("refresh возвращает stopped snapshot и не выдаёт себя за восстановление", async () => {
    const root = await createRoot();
    await createPlugin(root, { directory: "one", id: "example.one" });

    const beforeDeactivate = vi
      .fn()
      .mockRejectedValueOnce(new Error("/secret/refresh-hook"))
      .mockResolvedValue(undefined);

    const service = createService([root], { hooks: { beforeDeactivate } });
    await service.getState();

    const error = await captureServiceError(service.refresh());
    const state = requireState(error);

    expect(error.code).toBe("DEACTIVATION_FAILED");
    expect(state.started).toBe(false);
    expect(state.plugins[0]?.status).toBe("failed");
    expect(JSON.stringify(state)).not.toContain("/secret/refresh-hook");

    const retried = await captureServiceError(service.refresh());
    const retriedState = requireState(retried);

    expect(retried.code).toBe("PROCESS_RESTART_REQUIRED");
    expect(retriedState.started).toBe(false);
    expect(retriedState.plugins[0]?.status).toBe("failed");
    expect(JSON.stringify(retriedState)).not.toContain("/secret/refresh-hook");
  });

  it("санитизирует POSIX, Windows, UNC и встроенные пути в исходящих строках", () => {
    const sanitized = sanitizeOutboundString(
      "posix /home/aero/secret/plugin.json windows C:\\Users\\aero\\secret\\plugin.json unc \\\\server\\share\\secret embedded /srv/data/plugin.json",
    );

    expect(sanitized).toContain("[redacted]");
    expect(sanitized).not.toContain("home");
    expect(sanitized).not.toContain("Users");
    expect(sanitized).not.toContain("server");
    expect(sanitized).not.toContain("share");
    expect(sanitized).not.toContain("/srv/data");
  });

  it("оставляет только разрешённые ключи деталей и санитизирует их значения", () => {
    const sanitized = sanitizeDiagnosticDetails({
      stage: "deactivate",
      dependency: "example.base",
      rootIndex: 0,
      apiToken: "/home/aero/token",
      accessToken: "secret-access-token",
      filePath: "/home/aero/plugin.json",
      stackTrace: "at C:\\Users\\aero\\plugin.js:1",
      issues: [
        {
          path: "/home/aero/plugin.json",
          keyword: "type",
          message: "Путь /home/aero/plugin.json",
        },
      ],
    });

    expect(sanitized).toEqual({
      stage: "deactivate",
      dependency: "example.base",
      rootIndex: 0,
      issues: [{ keyword: "type", message: "Путь [redacted]" }],
    });
    expect(JSON.stringify(sanitized)).not.toContain("apiToken");
    expect(JSON.stringify(sanitized)).not.toContain("accessToken");
    expect(JSON.stringify(sanitized)).not.toContain("filePath");
    expect(JSON.stringify(sanitized)).not.toContain("stackTrace");
    expect(JSON.stringify(sanitized)).not.toContain("aero");
  });
});

type GlobalWithBootstrapOrder = typeof globalThis & {
  __kanbanerTestBootstrapOrder?: string[];
};

function resetBootstrapOrder(): void {
  (globalThis as GlobalWithBootstrapOrder).__kanbanerTestBootstrapOrder = [];
}

function bootstrapOrder(): readonly string[] {
  return (globalThis as GlobalWithBootstrapOrder).__kanbanerTestBootstrapOrder ?? [];
}

function orderedActivationSource(): string {
  return [
    "globalThis.__kanbanerTestBootstrapOrder ??= [];",
    "export function activate() { globalThis.__kanbanerTestBootstrapOrder.push('activate'); }",
    "export function deactivate() { return undefined; }",
    "",
  ].join("\n");
}

describe("plugin service: Storage bootstrap hook", () => {
  it("выполняет bootstrap ровно один раз до старта runtime", async () => {
    resetBootstrapOrder();

    const root = await createRoot();
    await createPlugin(root, {
      directory: "one",
      id: "example.one",
      serverSource: orderedActivationSource(),
    });

    const bootstrap = vi.fn(async () => {
      (globalThis as GlobalWithBootstrapOrder).__kanbanerTestBootstrapOrder?.push("bootstrap");
    });
    const service = createService([root], { bootstrap });

    const state = await service.getState();

    expect(state.started).toBe(true);
    expect(bootstrapOrder()).toEqual(["bootstrap", "activate"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    await service.getState();
    await service.refresh();

    expect(bootstrapOrder()).toEqual(["bootstrap", "activate", "activate"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("не стартует runtime при ошибке bootstrap и повторяет попытку", async () => {
    resetBootstrapOrder();

    const root = await createRoot();
    await createPlugin(root, {
      directory: "one",
      id: "example.one",
      serverSource: orderedActivationSource(),
    });

    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage is not ready"))
      .mockResolvedValue(undefined);
    const service = createService([root], { bootstrap });

    await expect(service.getState()).rejects.toThrow("storage is not ready");
    expect(bootstrapOrder()).toEqual([]);

    const state = await service.getState();

    expect(state.started).toBe(true);
    expect(bootstrapOrder()).toEqual(["activate"]);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});
