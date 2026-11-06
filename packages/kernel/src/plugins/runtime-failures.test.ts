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

describe("PluginRuntime failure isolation", () => {
  it("не роняет ядро и unrelated плагины при ошибке активации", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("failure")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.boom")).toBe("failed");
    expect(statusOf(snapshot, "fixture.healthy")).toBe("active");
    expect(statusOf(snapshot, "fixture.dependent")).toBe("missing_dependency");
    expect(snapshot.activationOrder).toEqual(["fixture.healthy"]);
    expect(snapshot.safeMode).toBe(true);
    expect(snapshot.mode).toBe("safe_mode");
    expect(snapshot.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "fixture.boom",
          status: "failed",
          code: "activation_failed",
        }),
        expect.objectContaining({
          pluginId: "fixture.dependent",
          status: "missing_dependency",
        }),
      ]),
    );
  });

  it("откатывает собственный lifecycle при ошибке активации", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("rollback")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.partial")).toBe("failed");
    expect(snapshot.activationOrder).toEqual([]);
    expect(fixtureEvents()).toEqual([
      "activate:fixture.broken-rollback",
      "deactivate:fixture.broken-rollback",
      "activate:fixture.partial",
      "deactivate:fixture.partial",
    ]);
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.partial" && diagnostic.code === "activation_failed",
      ),
    ).toBe(true);
  });

  it("изолирует ошибку деактивации и продолжает обратный порядок", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("deactivation-broken")],
    });

    await runtime.start();
    const snapshot = await runtime.stop();

    expect(snapshot.deactivationOrder).toEqual([
      "fixture.db-top",
      "fixture.db-broken",
      "fixture.db-base",
    ]);
    expect(statusOf(snapshot, "fixture.db-top")).toBe("disabled");
    expect(statusOf(snapshot, "fixture.db-broken")).toBe("failed");
    expect(statusOf(snapshot, "fixture.db-base")).toBe("disabled");
    expect(snapshot.safeMode).toBe(true);
    expect(fixtureEvents()).toEqual([
      "activate:fixture.db-base",
      "activate:fixture.db-broken",
      "activate:fixture.db-top",
      "deactivate:fixture.db-top",
      "deactivate:fixture.db-broken",
      "deactivate:fixture.db-base",
    ]);
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.db-broken" && diagnostic.code === "deactivation_failed",
      ),
    ).toBe(true);
  });

  it("запускается в safe mode без импорта кода плагинов", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("safe-mode")],
      safeMode: true,
    });

    const snapshot = await runtime.start();

    expect(snapshot.mode).toBe("safe_mode");
    expect(snapshot.safeMode).toBe(true);
    expect(snapshot.activationOrder).toEqual([]);
    expect(statusOf(snapshot, "fixture.safe-a")).toBe("safe_mode");
    expect(statusOf(snapshot, "fixture.safe-b")).toBe("safe_mode");
    expect(snapshot.problems).toHaveLength(2);
    expect(fixtureEvents()).toEqual([]);
  });

  it("не импортирует серверный код невалидного манифеста", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("manifest")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.valid")).toBe("active");
    expect(snapshot.activationOrder).toEqual(["fixture.valid"]);
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.invalid-schema" &&
          diagnostic.code === "manifest_invalid",
      ),
    ).toBe(true);
    expect(
      snapshot.diagnostics.filter((diagnostic) => diagnostic.code === "manifest_invalid").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === "module_import_failed"),
    ).toBe(false);
    expect(fixtureEvents()).toEqual(["activate:fixture.valid"]);
  });

  it("отклоняет удалённые, абсолютные и выходящие за каталог entrypoints", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("paths")],
    });

    const snapshot = await runtime.start();
    const pathDiagnostics = snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === "entrypoint_invalid",
    );

    expect(snapshot.activationOrder).toEqual([]);
    expect(snapshot.plugins).toHaveLength(4);
    expect(snapshot.plugins.every((plugin) => plugin.status === "failed")).toBe(true);
    expect(pathDiagnostics).toHaveLength(4);
    expect(
      pathDiagnostics.map((diagnostic) => diagnostic.details).map((details) => details?.reason),
    ).toEqual(expect.arrayContaining(["remote", "absolute", "escape", "invalid"]));
    expect(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === "module_import_failed"),
    ).toBe(false);
    expect(fixtureEvents()).toEqual([]);
  });
});
