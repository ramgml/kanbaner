// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginRuntimeLogger } from "@kanbaner/kernel";

import { createPluginService, type PluginServiceOptions } from "./plugin-service";

interface FixturePlugin {
  readonly directory: string;
  readonly id: string;
  readonly version?: string;
  readonly requires?: Readonly<Record<string, string>>;
  readonly activateSource?: string;
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
    plugin.activateSource ?? "export function activate() {}\nexport function deactivate() {}\n",
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

      await Promise.resolve();
      await Promise.resolve();

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
});
