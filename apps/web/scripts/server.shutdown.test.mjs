import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));
const appDirectory = dirname(here);
const serverPath = join(here, "server.mjs");
const hookPath = join(here, "__fixtures__", "deferred-shutdown.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      server.close(() => resolve(port));
    });
  });
}

function waitForMarker(getOutput, marker, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (getOutput().includes(marker)) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${marker}. Output:\n${getOutput()}`));
      }
    }, 20);
  });
}

test("SIGTERM дожидается deferred write и выполняет checkpoint", async () => {
  assert.ok(
    existsSync(join(appDirectory, ".next", "BUILD_ID")),
    "Production build is required: run pnpm --filter @kanbaner/web build first",
  );

  const dataDirectory = mkdtempSync(join(tmpdir(), "kanbaner-shutdown-"));
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: appDirectory,
    env: {
      ...process.env,
      NODE_ENV: "production",
      KANBANER_DATA_DIR: dataDirectory,
      KANBANER_PORT: String(port),
      KANBANER_ENABLE_TEST_HOOKS: "1",
      KANBANER_SERVER_TEST_HOOK: hookPath,
      KANBANER_SHUTDOWN_TIMEOUT_MS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let errorOutput = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });

  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    try {
      await waitForMarker(() => output, "TEST_DEFERRED_STARTED");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nstderr:\n${errorOutput}`,
      );
    }

    const startedAt = Date.now();

    child.kill("SIGTERM");

    const result = await Promise.race([
      exit,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Server did not exit after SIGTERM")), 20_000).unref();
      }),
    ]);
    const elapsed = Date.now() - startedAt;

    assert.equal(result.code, 0, `Exit code must be 0. stderr:\n${errorOutput}`);
    assert.equal(result.signal, null);
    assert.ok(elapsed >= 500, `Shutdown finished before deferred commit: ${elapsed}ms`);
    assert.match(output, /> shutdown complete/u);

    const databasePath = join(dataDirectory, "kanbaner.sqlite");

    // Проверяем sidecar-файлы до открытия проверочного соединения: read-only
    // SQLite может создать пустые -wal/-shm самостоятельно.
    assert.equal(existsSync(`${databasePath}-wal`), false, "WAL must be checkpointed");
    assert.equal(existsSync(`${databasePath}-shm`), false, "SHM must be removed");

    const database = new Database(databasePath, { readonly: true });

    try {
      const row = database
        .prepare(
          "SELECT data_json FROM core_documents WHERE plugin_id = ? AND collection = ? AND id = ?",
        )
        .get("test.shutdown", "deferred", "01JSHDN000000000000000000001");
      const integrity = database.pragma("integrity_check", { simple: true });

      assert.deepEqual(JSON.parse(row.data_json), { state: "written-before-shutdown" });
      assert.equal(integrity, "ok");
    } finally {
      database.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }

    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
