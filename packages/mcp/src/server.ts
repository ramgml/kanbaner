import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createSchemaValidator } from "@kanbaner/plugin-sdk";

import type { UniversalMcpConfig } from "./config.ts";
import { createDiscoveryClient, type DiscoveryClient } from "./discovery.ts";
import { createFailure, failureFromError, protocolErrorData, type McpFailure } from "./errors.ts";
import { createOperationInvoker, type CallIdentity, type OperationInvoker } from "./http-client.ts";
import type { FetchLike } from "./http.ts";
import { isPlainObject } from "./json.ts";
import { buildToolCatalog, supportsStructuredOutput, type UniversalTool } from "./tools.ts";

export const SERVER_NAME = "kanbaner-universal";
export const SERVER_VERSION = "0.1.0-dev.0";

type SchemaParameter = Parameters<typeof createSchemaValidator>[0];

export interface UniversalMcpServerOptions {
  readonly config: UniversalMcpConfig;
  readonly fetchImpl?: FetchLike;
  readonly instanceId?: string;
  readonly processId?: string;
  /** Диагностика каталога; по умолчанию пишется только в stderr. */
  readonly onDiagnostic?: (message: string) => void;
}

function defaultDiagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}

function toProtocolTool(tool: UniversalTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.operation.inputSchema as unknown as Tool["inputSchema"],
    annotations: tool.annotations,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema as unknown as NonNullable<Tool["outputSchema"]> }),
  };
}

interface PublishedTool {
  readonly tool: UniversalTool;
  readonly descriptor: Tool;
}

/**
 * Проверяет готовый protocol descriptor установленной MCP SDK.
 *
 * Discovery JSON Schema может компилироваться Ajv, но не соответствовать
 * `ToolSchema` (например, boolean subschema в `properties`). Такой tool
 * отбрасывается целиком, не ломая остальной список.
 */
function publishTool(
  tool: UniversalTool,
  diagnostic: (message: string) => void,
): PublishedTool | null {
  const parsed = ToolSchema.safeParse(toProtocolTool(tool));

  if (!parsed.success) {
    diagnostic(`MCP: tool ${tool.name} пропущен: descriptor не соответствует MCP ToolSchema`);

    return null;
  }

  return { tool, descriptor: parsed.data as Tool };
}

function failureToolResult(failure: McpFailure): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: failure }, null, 2),
      },
    ],
  };
}

function successToolResult(tool: UniversalTool, data: unknown): CallToolResult {
  const structured =
    supportsStructuredOutput(tool) && isPlainObject(data) ? { structuredContent: data } : {};

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, data }, null, 2),
      },
    ],
    ...structured,
  };
}

function protocolFailure(error: unknown, secret: string): McpError {
  const failure = failureFromError(error, secret);
  const code =
    failure.code === "UNKNOWN_TOOL" || failure.code === "VALIDATION_ERROR"
      ? ErrorCode.InvalidParams
      : ErrorCode.InternalError;

  return new McpError(code, failure.message, protocolErrorData(failure));
}

/** Создаёт низкоуровневый MCP `Server`, публикующий актуальный discovery. */
export function createUniversalMcpServer(options: UniversalMcpServerOptions): {
  readonly server: Server;
  readonly discovery: DiscoveryClient;
  readonly invoker: OperationInvoker;
} {
  const { config } = options;
  const diagnostic = options.onDiagnostic ?? defaultDiagnostic;
  const instanceId = options.instanceId ?? randomUUID();
  const processId = options.processId ?? String(process.pid);
  const discoveryOptions = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };
  const discovery = createDiscoveryClient(config, discoveryOptions);
  const invokerOptions =
    options.fetchImpl === undefined ? { config } : { config, fetchImpl: options.fetchImpl };
  const invoker = createOperationInvoker(invokerOptions);

  async function loadCatalog(signal?: AbortSignal): Promise<readonly PublishedTool[]> {
    const operations = await discovery.load(signal === undefined ? {} : { signal });
    const tools = buildToolCatalog(operations, {
      allowDestructive: config.allowDestructive,
      onDiagnostic: diagnostic,
    });
    const published: PublishedTool[] = [];

    for (const tool of tools) {
      const candidate = publishTool(tool, diagnostic);

      if (candidate !== null) {
        published.push(candidate);
      }
    }

    return published;
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    try {
      const tools = await loadCatalog(extra.signal);

      return { tools: tools.map(({ descriptor }) => descriptor) };
    } catch (error) {
      throw protocolFailure(error, config.apiToken);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;

    let tools: readonly PublishedTool[];

    try {
      tools = await loadCatalog(extra.signal);
    } catch (error) {
      return failureToolResult(failureFromError(error, config.apiToken));
    }

    const published = tools.find((candidate) => candidate.tool.name === name);

    if (published === undefined) {
      const failure = createFailure("UNKNOWN_TOOL", "Неизвестный MCP tool", {
        secret: config.apiToken,
      });

      throw new McpError(ErrorCode.InvalidParams, failure.message, protocolErrorData(failure));
    }

    const tool = published.tool;

    const input = request.params.arguments ?? {};
    const validation = createSchemaValidator(
      tool.operation.inputSchema as unknown as SchemaParameter,
    ).validate(input);

    if (!validation.ok) {
      return failureToolResult(
        createFailure("VALIDATION_ERROR", "Некорректный вход MCP tool", {
          details: { issues: validation.errors },
          secret: config.apiToken,
        }),
      );
    }

    const identity: CallIdentity = {
      requestId: extra.requestId,
      instanceId,
      processId,
      ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    };
    const outcome = await invoker.invoke(tool, input, identity, extra.signal);

    return outcome.ok ? successToolResult(tool, outcome.data) : failureToolResult(outcome.error);
  });

  return { server, discovery, invoker };
}
