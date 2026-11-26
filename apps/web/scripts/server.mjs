#!/usr/bin/env node
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

process.env.NODE_ENV ??= "production";

const hostname = process.env.KANBANER_HOST ?? "127.0.0.1";
const port = Number(process.env.KANBANER_PORT ?? process.env.PORT ?? 3000);
const dev = process.env.NODE_ENV !== "production";
const shutdownTimeoutMs = Number(process.env.KANBANER_SHUTDOWN_TIMEOUT_MS ?? 30_000);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Invalid port:", process.env.KANBANER_PORT ?? process.env.PORT);
  process.exit(1);
}

const { default: next } = await import("next");
const app = next({ dev, hostname, port });

await app.prepare();

const handle = app.getRequestHandler();
const upgradeHandler = app.getUpgradeHandler();

let shuttingDown = false;
let activeRequests = 0;
const idleWaiters = new Set();

function notifyIdle() {
  if (activeRequests !== 0) {
    return;
  }

  for (const resolve of idleWaiters) {
    resolve();
  }

  idleWaiters.clear();
}

function waitForActiveRequests() {
  if (activeRequests === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    idleWaiters.add(resolve);
  });
}

const server = createServer((request, response) => {
  if (shuttingDown) {
    response.statusCode = 503;
    response.setHeader("Connection", "close");
    response.end("Server is shutting down");
    return;
  }

  activeRequests += 1;

  const responseFinished = new Promise((resolve) => {
    if (response.writableEnded) {
      resolve();
      return;
    }

    response.once("finish", resolve);
    response.once("close", resolve);
  });

  Promise.allSettled([Promise.resolve(handle(request, response)), responseFinished]).finally(() => {
    activeRequests -= 1;
    notifyIdle();
  });
});

server.on("upgrade", (request, socket, head) => {
  if (shuttingDown) {
    socket.destroy();
    return;
  }

  Promise.resolve(upgradeHandler(request, socket, head)).catch(() => {
    socket.destroy();
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, hostname, () => {
    server.off("error", reject);
    resolve();
  });
});

console.log(`> Kanbaner ready on http://${hostname}:${port}`);

const testHook = process.env.KANBANER_SERVER_TEST_HOOK;

if (testHook !== undefined && process.env.KANBANER_ENABLE_TEST_HOOKS === "1") {
  const { default: hook } = await import(pathToFileURL(testHook).href);

  if (typeof hook !== "function") {
    throw new Error("Test hook must export a default function");
  }

  await hook({ server, port, hostname });
}

async function withTimeout(promise, label) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${shutdownTimeoutMs}ms`)),
          shutdownTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function writeLine(stream, message) {
  return new Promise((resolve) => {
    stream.write(`${message}\n`, resolve);
  });
}

let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  shuttingDown = true;
  console.log(`> ${signal}: stop accepting requests, active=${activeRequests}`);

  try {
    await withTimeout(
      (async () => {
        const closed = new Promise((resolve) => {
          server.close(() => resolve());
        });

        server.closeIdleConnections?.();
        await waitForActiveRequests();
        server.closeIdleConnections?.();
        await closed;
      })(),
      "request drain",
    );

    const storageShutdown = globalThis.__kanbanerStorageShutdown;

    if (typeof storageShutdown === "function") {
      await withTimeout(Promise.resolve(storageShutdown()), "storage shutdown");
    }

    await writeLine(process.stdout, "> shutdown complete");
    process.exit(0);
  } catch (error) {
    await writeLine(
      process.stderr,
      `> shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    server.closeAllConnections?.();
    process.exit(1);
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
