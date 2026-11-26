#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, McpConfigError } from "./config.ts";
import { createUniversalMcpServer } from "./server.ts";

/** Только stderr: stdout принадлежит JSON-RPC транспорту. */
function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Запускает stdio MCP-сервер.
 *
 * Конфигурация проверяется до подключения транспорта: при ошибке процесс
 * завершается с кодом 2 и безопасным сообщением без значения токена.
 */
export async function runUniversalMcpCli(): Promise<void> {
  let config;

  try {
    config = loadConfig(process.env);
  } catch (error) {
    const message =
      error instanceof McpConfigError
        ? error.message
        : "не удалось загрузить конфигурацию MCP-адаптера";

    writeStderr(`kanbaner-mcp-universal: ${message}`);
    process.exitCode = 2;
    return;
  }

  const { server } = createUniversalMcpServer({ config });
  const transport = new StdioServerTransport();
  let closing = false;

  async function shutdown(): Promise<void> {
    if (closing) {
      return;
    }

    closing = true;

    try {
      await server.close();
    } catch {
      // Процесс всё равно завершается: транспорту уже нечего обслуживать.
    }

    process.exit(0);
  }

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await server.connect(transport);
}

runUniversalMcpCli().catch(() => {
  writeStderr("kanbaner-mcp-universal: не удалось запустить stdio MCP-сервер");
  process.exitCode = 1;
});
