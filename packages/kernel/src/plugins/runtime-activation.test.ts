import { beforeEach, describe, expect, it } from "vitest";

import { createPluginRuntime } from "./plugin-runtime.ts";
import type { PluginRuntimeSnapshot } from "../lifecycle/index.ts";
import { fixtureEvents, fixturePath, resetFixtures } from "./test-support.ts";

function statusOf(snapshot: PluginRuntimeSnapshot, pluginId: string): string | undefined {
  return snapshot.plugins.find((plugin) => plugin.pluginId === pluginId)?.status;
}

beforeEach(() => {
  resetFixtures();
});

describe("PluginRuntime discovery and activation", () => {
  it("активирует зависимости раньше зависимых в детерминированном порядке", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
    });

    const snapshot = await runtime.start();

    expect(snapshot.activationOrder).toEqual(["fixture.zeta", "fixture.alpha", "fixture.mid"]);
    expect(snapshot.safeMode).toBe(false);
    expect(snapshot.mode).toBe("normal");
    expect(snapshot.problems).toEqual([]);
    expect(fixtureEvents()).toEqual([
      "activate:fixture.zeta",
      "activate:fixture.alpha",
      "activate:fixture.mid",
    ]);

    const second = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
    });
    const secondSnapshot = await second.start();

    expect(secondSnapshot.activationOrder).toEqual(snapshot.activationOrder);
    expect(secondSnapshot.plugins.map((plugin) => [plugin.pluginId, plugin.status])).toEqual(
      snapshot.plugins.map((plugin) => [plugin.pluginId, plugin.status]),
    );
  });

  it("деактивирует плагины в обратном порядке", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("deactivation")],
    });

    const started = await runtime.start();

    expect(started.activationOrder).toEqual([
      "fixture.deactivation-base",
      "fixture.deactivation-middle",
      "fixture.deactivation-top",
    ]);

    const stopped = await runtime.stop();

    expect(stopped.deactivationOrder).toEqual([
      "fixture.deactivation-top",
      "fixture.deactivation-middle",
      "fixture.deactivation-base",
    ]);
    expect(fixtureEvents()).toEqual([
      "activate:fixture.deactivation-base",
      "activate:fixture.deactivation-middle",
      "activate:fixture.deactivation-top",
      "deactivate:fixture.deactivation-top",
      "deactivate:fixture.deactivation-middle",
      "deactivate:fixture.deactivation-base",
    ]);
    expect(stopped.started).toBe(false);
    expect(statusOf(stopped, "fixture.deactivation-top")).toBe("disabled");
    expect(stopped.safeMode).toBe(false);
  });

  it("активирует плагин без server entrypoint", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("module")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.module-client-only")).toBe("active");
    expect(statusOf(snapshot, "fixture.module-default")).toBe("active");
    expect(statusOf(snapshot, "fixture.module-no-functions")).toBe("failed");
    expect(snapshot.activationOrder).toContain("fixture.module-client-only");
    expect(fixtureEvents()).toContain("activate:fixture.module-default");
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.module-no-functions" &&
          diagnostic.code === "entrypoint_invalid_module",
      ),
    ).toBe(true);
  });

  it("работает с путями, содержащими пробелы и не-ASCII символы", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("unicode plugins")],
    });

    const snapshot = await runtime.start();

    expect(snapshot.activationOrder).toEqual(["fixture.unicode"]);
    expect(statusOf(snapshot, "fixture.unicode")).toBe("active");
    expect(fixtureEvents()).toEqual(["activate:fixture.unicode"]);
  });

  it("запускается с пустым набором плагинов", async () => {
    const runtime = createPluginRuntime({ pluginDirectories: [] });
    const snapshot = await runtime.start();

    expect(snapshot.started).toBe(true);
    expect(snapshot.mode).toBe("normal");
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.activationOrder).toEqual([]);
  });

  it("использует переданную версию Host API", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("host-api")],
      hostApiVersion: "2.0.0",
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.future")).toBe("active");
    expect(statusOf(snapshot, "fixture.host-healthy")).toBe("incompatible");
    expect(statusOf(snapshot, "fixture.host-dependent")).toBe("incompatible");
  });
});

describe("PluginRuntime dependency failures", () => {
  it("блокирует только плагин с отсутствующей зависимостью", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("missing")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.missing-dependent")).toBe("missing_dependency");
    expect(statusOf(snapshot, "fixture.missing-healthy")).toBe("active");
    expect(snapshot.activationOrder).toEqual(["fixture.missing-healthy"]);
    expect(snapshot.safeMode).toBe(true);
    expect(snapshot.problems).toContainEqual(
      expect.objectContaining({
        pluginId: "fixture.missing-dependent",
        status: "missing_dependency",
      }),
    );
  });

  it("блокирует несовместимый Host API", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("host-api")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.future")).toBe("incompatible");
    expect(statusOf(snapshot, "fixture.host-dependent")).toBe("missing_dependency");
    expect(statusOf(snapshot, "fixture.host-healthy")).toBe("active");
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.future" && diagnostic.code === "host_api_incompatible",
      ),
    ).toBe(true);
  });

  it("блокирует зависимость с несовпадающей версией", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("dependency-version")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.provider")).toBe("active");
    expect(statusOf(snapshot, "fixture.needs2")).toBe("incompatible");
    expect(statusOf(snapshot, "fixture.version-healthy")).toBe("active");
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.needs2" &&
          diagnostic.code === "dependency_version_unsatisfied",
      ),
    ).toBe(true);
  });

  it("обнаруживает цикл с перечнем участников", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("cycle")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.cycle-alpha")).toBe("failed");
    expect(statusOf(snapshot, "fixture.cycle-beta")).toBe("failed");
    expect(statusOf(snapshot, "fixture.cycle-dependent")).toBe("missing_dependency");
    expect(statusOf(snapshot, "fixture.cycle-healthy")).toBe("active");
    expect(
      snapshot.diagnostics.find((diagnostic) => diagnostic.code === "dependency_cycle")?.details,
    ).toEqual({
      participants: ["fixture.cycle-alpha", "fixture.cycle-beta"],
    });
  });

  it("блокирует дублирующийся Plugin ID", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("duplicate/root-a"), fixturePath("duplicate/root-b")],
    });

    const snapshot = await runtime.start();
    const duplicates = snapshot.plugins.filter((plugin) => plugin.pluginId === "fixture.dup");

    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((plugin) => plugin.status === "failed")).toBe(true);
    expect(statusOf(snapshot, "fixture.dup-dependent")).toBe("missing_dependency");
    expect(statusOf(snapshot, "fixture.dup-healthy")).toBe("active");
    expect(
      snapshot.diagnostics.filter((diagnostic) => diagnostic.code === "duplicate_plugin_id"),
    ).toHaveLength(2);
  });

  it("не активирует плагин, отключённый конфигурацией", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
      disabledPlugins: ["fixture.zeta"],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.zeta")).toBe("disabled");
    expect(statusOf(snapshot, "fixture.alpha")).toBe("missing_dependency");
    expect(statusOf(snapshot, "fixture.mid")).toBe("missing_dependency");
    expect(snapshot.activationOrder).toEqual([]);
    expect(fixtureEvents()).toEqual([]);
  });
});
