import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { PluginRuntimeSnapshot } from "../lifecycle/index.ts";
import { createPluginRuntime } from "./plugin-runtime.ts";
import {
  createFixtureGate,
  fixtureEvents,
  fixturePath,
  resetFixtures,
  waitForFixtureEvent,
} from "./test-support.ts";

function statusOf(snapshot: PluginRuntimeSnapshot, pluginId: string): string | undefined {
  return snapshot.plugins.find((plugin) => plugin.pluginId === pluginId)?.status;
}

function codesOf(snapshot: PluginRuntimeSnapshot, pluginId: string): readonly string[] {
  return (
    snapshot.plugins
      .find((plugin) => plugin.pluginId === pluginId)
      ?.diagnostics.map((diagnostic) => diagnostic.code) ?? []
  );
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "kanbaner-kan003-runtime-"));

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isSymlinkUnsupported(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";

  return code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "EINVAL";
}

beforeEach(() => {
  resetFixtures();
});

describe("PluginRuntime loader isolation", () => {
  it("изолирует top-level throw, throwing getter и Proxy без runtime_failed", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("loader-isolation")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.loader-healthy")).toBe("active");
    expect(statusOf(snapshot, "fixture.import-throw")).toBe("failed");
    expect(statusOf(snapshot, "fixture.loader-dependent")).toBe("missing_dependency");
    expect(statusOf(snapshot, "fixture.throwing-getter")).toBe("failed");
    expect(statusOf(snapshot, "fixture.throwing-proxy")).toBe("failed");
    expect(codesOf(snapshot, "fixture.import-throw")).toContain("module_import_failed");
    expect(codesOf(snapshot, "fixture.throwing-getter")).toContain("entrypoint_invalid_module");
    expect(codesOf(snapshot, "fixture.throwing-proxy")).toContain("entrypoint_invalid_module");
    expect(codesOf(snapshot, "fixture.loader-dependent")).toContain("dependency_unavailable");
    expect(snapshot.activationOrder).toEqual(["fixture.loader-healthy"]);
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "runtime_failed")).toBe(
      false,
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("IMPORT_THROW_MARKER");
    expect(serialized).not.toContain("GETTER_MARKER");
    expect(serialized).not.toContain("PROXY_MARKER");
    expect(fixtureEvents()).toEqual(["activate:fixture.loader-healthy"]);
  });
});

describe("PluginRuntime local path failures", () => {
  it("фиксирует entrypoint_not_found без импорта", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("module")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.module-entrypoint-not-found")).toBe("failed");
    expect(codesOf(snapshot, "fixture.module-entrypoint-not-found")).toContain(
      "entrypoint_not_found",
    );
    expect(fixtureEvents()).not.toContain("activate:fixture.module-entrypoint-not-found");
  });

  it("фиксирует migrations_path_invalid для escape и не-каталога", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("migrations")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.migrations-path-invalid")).toBe("failed");
    expect(statusOf(snapshot, "fixture.migrations-not-directory")).toBe("failed");
    expect(codesOf(snapshot, "fixture.migrations-path-invalid")).toContain(
      "migrations_path_invalid",
    );
    expect(codesOf(snapshot, "fixture.migrations-not-directory")).toContain(
      "migrations_path_invalid",
    );
    expect(
      snapshot.plugins
        .find((plugin) => plugin.pluginId === "fixture.migrations-path-invalid")
        ?.diagnostics.find((diagnostic) => diagnostic.code === "migrations_path_invalid")?.details,
    ).toEqual({ reason: "escape" });
    expect(
      snapshot.plugins
        .find((plugin) => plugin.pluginId === "fixture.migrations-not-directory")
        ?.diagnostics.find((diagnostic) => diagnostic.code === "migrations_path_invalid")?.details,
    ).toEqual({ reason: "not_directory" });
    expect(fixtureEvents()).toEqual([]);
  });

  it("фиксирует rollback_failed и не раскрывает текст исключения", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("rollback")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.broken-rollback")).toBe("failed");
    expect(codesOf(snapshot, "fixture.broken-rollback")).toEqual(
      expect.arrayContaining(["activation_failed", "rollback_failed"]),
    );
    expect(snapshot.activationOrder).toEqual([]);
    expect(fixtureEvents()).toEqual([
      "activate:fixture.broken-rollback",
      "deactivate:fixture.broken-rollback",
      "activate:fixture.partial",
      "deactivate:fixture.partial",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("super-secret");
  });

  it("запрещает symlink-выход за каталог плагина", async (context) => {
    await withTempRoot(async (root) => {
      const pluginDirectory = join(root, "plugin");
      const outsideFile = join(root, "outside.mjs");
      await mkdir(pluginDirectory);
      await writeFile(
        join(pluginDirectory, "plugin.json"),
        `${JSON.stringify({
          id: "fixture.symlink-escape",
          name: "Symlink escape",
          version: "1.0.0",
          hostApi: "^1.0.0",
          entrypoints: { server: "./escape.mjs" },
          requires: {},
          consumes: [],
          provides: [],
          permissions: [],
        })}\n`,
      );
      await writeFile(outsideFile, "globalThis.__kanbanerSymlinkEscapeImported = true;\n");

      try {
        await symlink(outsideFile, join(pluginDirectory, "escape.mjs"), "file");
      } catch (error) {
        if (isSymlinkUnsupported(error)) {
          context.skip(`symlink недоступен в окружении: ${String(error)}`);
          return;
        }

        throw error;
      }

      const runtime = createPluginRuntime({ pluginDirectories: [root] });
      const snapshot = await runtime.start();
      const record = snapshot.plugins.find(
        (plugin) => plugin.pluginId === "fixture.symlink-escape",
      );

      expect(record?.status).toBe("failed");
      expect(record?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "entrypoint_invalid",
      );
      expect(
        record?.diagnostics.find((diagnostic) => diagnostic.code === "entrypoint_invalid")?.details,
      ).toEqual({ reason: "symlink_escape" });
      expect(
        (globalThis as unknown as Record<string, unknown>).__kanbanerSymlinkEscapeImported,
      ).toBeUndefined();
    });
  });
});

describe("PluginRuntime manifest read failures", () => {
  it("материализует failed-запись для plugin.json-каталога", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("discovery-read-failure")],
    });

    const snapshot = await runtime.start();
    const record = snapshot.plugins.find((plugin) => plugin.source === "root#0/broken/plugin.json");

    expect(record?.pluginId).toBeNull();
    expect(record?.status).toBe("failed");
    expect(record?.manifest).toBeNull();
    expect(record?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "manifest_read_failed",
    ]);
    expect(record?.diagnostics[0]?.details).toEqual({
      rootIndex: 0,
      reason: "not_file",
    });
    expect(snapshot.problems).toContainEqual(
      expect.objectContaining({
        pluginId: null,
        source: "root#0/broken/plugin.json",
        status: "failed",
        code: "manifest_read_failed",
      }),
    );
    expect(snapshot.safeMode).toBe(true);
    expect(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === "module_import_failed"),
    ).toBe(false);
  });

  it("превращает невалидный UTF-8 в diagnostic без импорта", async () => {
    await withTempRoot(async (root) => {
      const directory = join(root, "broken");
      await mkdir(directory);
      await writeFile(join(directory, "plugin.json"), Buffer.from([0x7b, 0xff, 0x7d]));
      await writeFile(
        join(directory, "server.mjs"),
        'throw new Error("INVALID_UTF8_IMPORT_MARKER");\n',
      );

      const runtime = createPluginRuntime({ pluginDirectories: [root] });
      const snapshot = await runtime.start();
      const record = snapshot.plugins.find(
        (plugin) => plugin.source === "root#0/broken/plugin.json",
      );

      expect(record?.status).toBe("failed");
      expect(record?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "manifest_read_failed",
      ]);
      expect(record?.diagnostics[0]?.details).toEqual({
        rootIndex: 0,
        reason: "invalid_utf8",
      });
      expect(
        snapshot.diagnostics.some((diagnostic) => diagnostic.code === "module_import_failed"),
      ).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain(root);
    });
  });

  it("учитывает недоступный root в problems и safeMode, не блокируя healthy", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("does-not-exist"), fixturePath("order")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.zeta")).toBe("active");
    expect(snapshot.activationOrder).toEqual(["fixture.zeta", "fixture.alpha", "fixture.mid"]);
    expect(snapshot.safeMode).toBe(true);
    expect(snapshot.problems).toContainEqual(
      expect.objectContaining({
        pluginId: null,
        source: "root#0",
        code: "plugin_root_unavailable",
      }),
    );
    expect(
      snapshot.diagnostics.find((diagnostic) => diagnostic.code === "plugin_root_unavailable")
        ?.details,
    ).toEqual({ rootIndex: 0 });
  });
});

describe("PluginRuntime prerelease ranges", () => {
  it("не считает prerelease зависимости совместимыми со стабильным диапазоном", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("prerelease", "dependency")],
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.prerelease-provider")).toBe("active");
    expect(statusOf(snapshot, "fixture.needs-stable")).toBe("incompatible");
    expect(statusOf(snapshot, "fixture.needs-prerelease")).toBe("active");
    expect(codesOf(snapshot, "fixture.needs-stable")).toContain("dependency_version_unsatisfied");
  });

  it("различает hostApi ^1.0.0 и ^1.0.0-0 для prerelease Host API", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("prerelease", "host")],
      hostApiVersion: "1.0.0-beta.1",
    });

    const snapshot = await runtime.start();

    expect(statusOf(snapshot, "fixture.host-stable")).toBe("incompatible");
    expect(statusOf(snapshot, "fixture.host-prerelease")).toBe("active");
    expect(codesOf(snapshot, "fixture.host-stable")).toContain("host_api_incompatible");
  });
});

describe("PluginRuntime async observers and hooks", () => {
  it("изолирует rejected Promise логгера и наблюдателя без unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      const runtime = createPluginRuntime({
        pluginDirectories: [fixturePath("order")],
        logger: {
          log: async () => {
            throw new Error("async logger rejected");
          },
        },
        hooks: {
          onDiagnostic: async () => {
            throw new Error("async observer rejected");
          },
        },
      });

      const snapshot = await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(snapshot.activationOrder).toEqual(["fixture.zeta", "fixture.alpha", "fixture.mid"]);
      expect(snapshot.safeMode).toBe(false);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("изолирует ошибку beforeActivate и блокирует зависимых", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("order")],
      hooks: {
        beforeActivate: (context) => {
          if (context.pluginId === "fixture.zeta") {
            throw new Error("beforeActivate failed");
          }
        },
      },
    });

    const snapshot = await runtime.start();

    expect(snapshot.activationOrder).toEqual([]);
    expect(statusOf(snapshot, "fixture.zeta")).toBe("failed");
    expect(statusOf(snapshot, "fixture.alpha")).toBe("missing_dependency");
    expect(statusOf(snapshot, "fixture.mid")).toBe("missing_dependency");
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.zeta" &&
          diagnostic.code === "hook_failed" &&
          diagnostic.details?.hook === "beforeActivate",
      ),
    ).toBe(true);
  });

  it("изолирует ошибку beforeDeactivate и продолжает деактивацию", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("deactivation")],
      hooks: {
        beforeDeactivate: (context) => {
          if (context.pluginId === "fixture.deactivation-middle") {
            throw new Error("beforeDeactivate failed");
          }
        },
      },
    });

    await runtime.start();
    const snapshot = await runtime.stop();

    expect(snapshot.deactivationOrder).toEqual([
      "fixture.deactivation-top",
      "fixture.deactivation-middle",
      "fixture.deactivation-base",
    ]);
    expect(statusOf(snapshot, "fixture.deactivation-middle")).toBe("failed");
    expect(statusOf(snapshot, "fixture.deactivation-top")).toBe("disabled");
    expect(statusOf(snapshot, "fixture.deactivation-base")).toBe("disabled");
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.deactivation-middle" &&
          diagnostic.code === "hook_failed" &&
          diagnostic.details?.hook === "beforeDeactivate",
      ),
    ).toBe(true);
  });

  it("изолирует ошибку afterDeactivate и продолжает деактивацию", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("deactivation")],
      hooks: {
        afterDeactivate: (context) => {
          if (context.pluginId === "fixture.deactivation-base") {
            throw new Error("afterDeactivate failed");
          }
        },
      },
    });

    await runtime.start();
    const snapshot = await runtime.stop();

    expect(statusOf(snapshot, "fixture.deactivation-base")).toBe("failed");
    expect(statusOf(snapshot, "fixture.deactivation-middle")).toBe("disabled");
    expect(statusOf(snapshot, "fixture.deactivation-top")).toBe("disabled");
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.pluginId === "fixture.deactivation-base" &&
          diagnostic.code === "hook_failed" &&
          diagnostic.details?.hook === "afterDeactivate",
      ),
    ).toBe(true);
  });
});

describe("PluginRuntime concurrency", () => {
  it("await stop() гарантирует деактивацию после незавершённого start()", async () => {
    const releaseActivation = createFixtureGate("activate");
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("concurrency")],
    });

    const startPromise = runtime.start();
    await waitForFixtureEvent("activate:fixture.concurrency");
    const stopPromise = runtime.stop();
    releaseActivation();

    const [started, stopped] = await Promise.all([startPromise, stopPromise]);

    expect(started.activationOrder).toEqual(["fixture.concurrency"]);
    expect(stopped.started).toBe(false);
    expect(stopped.deactivationOrder).toEqual(["fixture.concurrency"]);
    expect(fixtureEvents()).toEqual([
      "activate:fixture.concurrency",
      "deactivate:fixture.concurrency",
    ]);
  });

  it("start() во время stop() выполняется после деактивации", async () => {
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("concurrency")],
    });

    await runtime.start();

    const releaseDeactivation = createFixtureGate("deactivate");
    const stopPromise = runtime.stop();
    await waitForFixtureEvent("deactivate:fixture.concurrency");
    const restartPromise = runtime.start();
    releaseDeactivation();

    const [stopped, restarted] = await Promise.all([stopPromise, restartPromise]);

    expect(stopped.started).toBe(false);
    expect(stopped.deactivationOrder).toEqual(["fixture.concurrency"]);
    expect(restarted.started).toBe(true);
    expect(restarted.activationOrder).toEqual(["fixture.concurrency"]);
    expect(statusOf(restarted, "fixture.concurrency")).toBe("active");
    expect(fixtureEvents()).toEqual([
      "activate:fixture.concurrency",
      "deactivate:fixture.concurrency",
      "activate:fixture.concurrency",
    ]);
  });

  it("повторный start() во время start() не активирует плагин дважды", async () => {
    const releaseActivation = createFixtureGate("activate");
    const runtime = createPluginRuntime({
      pluginDirectories: [fixturePath("concurrency")],
    });

    const first = runtime.start();
    const second = runtime.start();
    releaseActivation();

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(firstSnapshot.activationOrder).toEqual(["fixture.concurrency"]);
    expect(secondSnapshot.activationOrder).toEqual(["fixture.concurrency"]);
    expect(fixtureEvents()).toEqual(["activate:fixture.concurrency"]);
  });
});
