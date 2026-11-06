import { beforeEach, describe, expect, it } from "vitest";

import type { PluginRuntimeLogger } from "../lifecycle/index.ts";
import { createPluginRuntime } from "./plugin-runtime.ts";
import { fixtureEvents, fixturePath, resetFixtures } from "./test-support.ts";

beforeEach(() => {
  resetFixtures();
});

describe("PluginRuntime public state", () => {
  it("отдаёт неизменяемый снимок без внутренних структур", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
    });

    const snapshot = await runtime.start();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.plugins)).toBe(true);
    expect(Object.isFrozen(snapshot.plugins[0])).toBe(true);
    expect(Object.isFrozen(snapshot.plugins[0]?.manifest)).toBe(true);
    expect(snapshot.plugins[0]).not.toBeInstanceOf(Map);
    expect(snapshot.plugins[0]).not.toBeInstanceOf(Set);

    const mutable = snapshot as unknown as {
      plugins: Array<{ status: string }>;
    };

    expect(() => {
      const plugin = mutable.plugins[0];

      if (plugin !== undefined) {
        plugin.status = "failed";
      }
    }).toThrow(TypeError);

    const fresh = runtime.getSnapshot();

    expect(fresh.plugins[0]?.status).toBe("active");
  });

  it("позволяет читать состояние плагина через публичный API", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
    });

    await runtime.start();

    const state = runtime.getState("fixture.alpha");

    expect(state?.pluginId).toBe("fixture.alpha");
    expect(state?.status).toBe("active");
    expect(state?.manifest?.requires).toEqual({ "fixture.zeta": "^1.0.0" });
    expect(runtime.getState("fixture.absent")).toBeUndefined();
    expect(runtime.getActivationOrder()).toEqual(["fixture.zeta", "fixture.alpha", "fixture.mid"]);
    expect(runtime.isSafeMode()).toBe(false);
  });

  it("сериализуется как JSON без функций и циклических ссылок", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
    });

    const snapshot = await runtime.start();

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain("function");
  });
});

describe("PluginRuntime diagnostics", () => {
  it("не раскрывает стеки, секреты и абсолютные пути", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("failure")],
    });

    const snapshot = await runtime.start();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("/home/private");
    expect(serialized).not.toContain("Error:");
    expect(serialized).not.toContain("at Object.");
    expect(serialized).not.toContain(fixturePath("failure"));
    expect(serialized).not.toContain("stack");
    expect(snapshot.diagnostics.length).toBeGreaterThan(0);
  });

  it("передаёт безопасные диагностики логгеру и наблюдателю", async () => {
    const logged: string[] = [];
    const observed: string[] = [];
    const logger: PluginRuntimeLogger = {
      log: (level, message, details) => {
        logged.push(`${level}:${message}:${JSON.stringify(details ?? {})}`);
      },
    };
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("failure")],
      logger,
      hooks: {
        onDiagnostic: (diagnostic) => {
          observed.push(`${diagnostic.code}:${diagnostic.message}`);
        },
      },
    });

    const snapshot = await runtime.start();
    const serialized = logged.join("\n");

    expect(logged.length).toBe(snapshot.diagnostics.length);
    expect(observed.length).toBe(snapshot.diagnostics.length);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("/home/private");
  });

  it("изолирует ошибки логгера и наблюдателя", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
      logger: {
        log: () => {
          throw new Error("logger failed");
        },
      },
      hooks: {
        onDiagnostic: () => {
          throw new Error("observer failed");
        },
      },
    });

    const snapshot = await runtime.start();

    expect(snapshot.activationOrder).toEqual(["fixture.zeta", "fixture.alpha", "fixture.mid"]);
    expect(snapshot.safeMode).toBe(false);
  });
});

describe("PluginRuntime lifecycle hooks", () => {
  it("вызывает migrate до активации и хуки вокруг lifecycle", async () => {
    const hooks: string[] = [];
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("deactivation")],
      hooks: {
        migrate: (context) => {
          hooks.push(`migrate:${context.pluginId}`);
        },
        beforeActivate: (context) => {
          hooks.push(`beforeActivate:${context.pluginId}`);
        },
        afterActivate: (context) => {
          hooks.push(`afterActivate:${context.pluginId}`);
        },
        beforeDeactivate: (context) => {
          hooks.push(`beforeDeactivate:${context.pluginId}`);
        },
        afterDeactivate: (context) => {
          hooks.push(`afterDeactivate:${context.pluginId}`);
        },
      },
    });

    await runtime.start();
    await runtime.stop();

    expect(hooks.slice(0, 6)).toEqual([
      "migrate:fixture.deactivation-base",
      "beforeActivate:fixture.deactivation-base",
      "afterActivate:fixture.deactivation-base",
      "migrate:fixture.deactivation-middle",
      "beforeActivate:fixture.deactivation-middle",
      "afterActivate:fixture.deactivation-middle",
    ]);
    expect(hooks.slice(-6)).toEqual([
      "beforeDeactivate:fixture.deactivation-top",
      "afterDeactivate:fixture.deactivation-top",
      "beforeDeactivate:fixture.deactivation-middle",
      "afterDeactivate:fixture.deactivation-middle",
      "beforeDeactivate:fixture.deactivation-base",
      "afterDeactivate:fixture.deactivation-base",
    ]);
  });

  it("изолирует ошибку migrate и блокирует зависимые плагины", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("deactivation")],
      hooks: {
        migrate: (context) => {
          if (context.pluginId === "fixture.deactivation-middle") {
            throw new Error("migration token=super-secret");
          }
        },
      },
    });

    const snapshot = await runtime.start();

    expect(snapshot.activationOrder).toEqual(["fixture.deactivation-base"]);
    expect(
      snapshot.plugins.find((plugin) => plugin.pluginId === "fixture.deactivation-middle")?.status,
    ).toBe("failed");
    expect(
      snapshot.plugins.find((plugin) => plugin.pluginId === "fixture.deactivation-top")?.status,
    ).toBe("missing_dependency");
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.deactivation-middle" &&
          diagnostic.code === "migration_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("super-secret");
    expect(fixtureEvents()).toEqual(["activate:fixture.deactivation-base"]);
  });

  it("вызывает deactivate при ошибке afterActivate как откат", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
      hooks: {
        afterActivate: (context) => {
          if (context.pluginId === "fixture.zeta") {
            throw new Error("afterActivate failed");
          }
        },
      },
    });

    const snapshot = await runtime.start();

    expect(snapshot.activationOrder).toEqual([]);
    expect(fixtureEvents()).toEqual(["activate:fixture.zeta", "deactivate:fixture.zeta"]);
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.zeta" &&
          diagnostic.code === "hook_failed" &&
          diagnostic.details?.hook === "afterActivate",
      ),
    ).toBe(true);
    expect(
      snapshot.plugins
        .filter((plugin) => plugin.pluginId !== "fixture.zeta")
        .every((plugin) => plugin.status === "missing_dependency"),
    ).toBe(true);
  });
});
