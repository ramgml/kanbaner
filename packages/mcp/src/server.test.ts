// @vitest-environment node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import type { UniversalMcpConfig } from "./config.ts";
import { createUniversalMcpServer } from "./server.ts";
import {
  ARRAY_OUTPUT_SCHEMA,
  createFetchHarness,
  discoveryEnvelope,
  rawOperation,
  TEST_CONFIG,
  TEST_TOKEN,
  type FetchHarness,
} from "./testing/fixtures.ts";

const CREATE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    projectId: { type: "string" },
    title: { type: "string" },
    expectedVersion: { type: "integer" },
  },
  required: ["projectId", "title"],
  additionalProperties: false,
};

interface HttpStub {
  readonly harness: FetchHarness;
  operations: unknown[];
  readonly resultForCall?: (url: string, body: unknown) => Response;
}

function createHttpStub(operations: unknown[]): HttpStub {
  const state: HttpStub = {
    harness: undefined as unknown as FetchHarness,
    operations,
  };

  Object.assign(state, {
    harness: createFetchHarness((request) => {
      if (request.url.endsWith("/api/v1/discovery")) {
        return Response.json(discoveryEnvelope(state.operations));
      }

      if (state.resultForCall !== undefined) {
        return state.resultForCall(request.url, request.body);
      }

      return Response.json({ ok: true, data: { value: "ok" } });
    }),
  });

  return state;
}

interface Harness {
  readonly client: Client;
  readonly server: Server;
  readonly http: HttpStub;
}

const open: Harness[] = [];

async function harness(options: {
  readonly operations?: unknown[];
  readonly allowDestructive?: boolean;
  readonly resultForCall?: (url: string, body: unknown) => Response;
}): Promise<Harness> {
  const http = createHttpStub(options.operations ?? []);

  if (options.resultForCall !== undefined) {
    Object.assign(http, { resultForCall: options.resultForCall });
  }

  const config: UniversalMcpConfig = {
    ...TEST_CONFIG,
    allowDestructive: options.allowDestructive ?? false,
  };
  const { server } = createUniversalMcpServer({
    config,
    fetchImpl: http.harness.fetchImpl,
    instanceId: "instance-id",
    processId: "4321",
    onDiagnostic: () => undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = { client, server, http };

  open.push(opened);

  return opened;
}

interface ToolPayload {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: unknown;
  };
}

function resultText(result: CallToolResult): ToolPayload {
  const first = result.content[0];

  if (first === undefined || first.type !== "text") {
    throw new Error("нет текстового content");
  }

  return JSON.parse(first.text) as ToolPayload;
}

afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close();
    await server.close();
  }
});

const TASK_LIST = rawOperation({
  id: "kanbaner.tasks.task.list",
  description: "Список задач",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" } },
    additionalProperties: false,
  },
});
const TASK_CREATE = rawOperation({
  id: "kanbaner.tasks.task.create",
  kind: "mutation",
  idempotency: "supported",
  inputSchema: CREATE_INPUT_SCHEMA,
});
const TASK_DELETE = rawOperation({
  id: "kanbaner.tasks.task.delete",
  kind: "mutation",
  risk: "destructive",
  exposure: { ui: true, http: true, mcp: true },
});
const NOTE_CREATE = rawOperation({
  id: "kanbaner.notes.note.create",
  kind: "mutation",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    additionalProperties: false,
  },
});

describe("universal MCP server", () => {
  it("публикует подмножество discovery без статического числа tools", async () => {
    const { client } = await harness({
      operations: [
        TASK_LIST,
        TASK_CREATE,
        TASK_DELETE,
        rawOperation({ id: "kanbaner.tasks.task.moveMany", kind: "mutation" }),
        rawOperation({
          id: "kanbaner.private.operation",
          exposure: { ui: true, http: true, mcp: false },
        }),
      ],
    });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("kanbaner_tasks_task_list");
    expect(names).toContain("kanbaner_tasks_task_create");
    expect(names).not.toContain("kanbaner_tasks_task_delete");
    expect(names).not.toContain("kanbaner_private_operation");
    expect(names).not.toContain("kanbaner_tasks_task_move_many");

    const listTool = tools.find((tool) => tool.name === "kanbaner_tasks_task_list");

    expect(listTool?.description).toContain("Operation: kanbaner.tasks.task.list");
    expect(listTool?.inputSchema).toMatchObject({ type: "object" });
    expect(listTool?.annotations?.readOnlyHint).toBe(true);
  });

  it("видит новый synthetic descriptor без правок пакета", async () => {
    const { client, http } = await harness({ operations: [TASK_LIST] });
    const first = await client.listTools();

    expect(first.tools.map((tool) => tool.name)).toEqual(["kanbaner_tasks_task_list"]);

    http.operations = [
      TASK_LIST,
      rawOperation({ id: "kanbaner.search.query", description: "Глобальный поиск" }),
    ];

    const second = await client.listTools();

    expect(second.tools.map((tool) => tool.name)).toEqual([
      "kanbaner_search_query",
      "kanbaner_tasks_task_list",
    ]);
  });

  it("вызывает query и возвращает structuredContent для object output", async () => {
    const { client, http } = await harness({
      operations: [TASK_LIST],
      resultForCall: () => Response.json({ ok: true, data: { value: "ok" } }),
    });
    const result = (await client.callTool({
      name: "kanbaner_tasks_task_list",
      arguments: { limit: 5 },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toEqual({ ok: true, data: { value: "ok" } });
    expect(result.structuredContent).toEqual({ value: "ok" });
    expect(http.harness.requests.at(-1)?.url).toBe(
      "http://kanbaner.test/api/v1/queries/kanbaner.tasks.task.list",
    );
    expect(http.harness.requests.at(-1)?.body).toEqual({ limit: 5 });
  });

  it("вызывает mutation с Idempotency-Key и expectedVersion как есть", async () => {
    const { client, http } = await harness({
      operations: [TASK_CREATE],
      resultForCall: () => Response.json({ ok: true, data: { value: "created" } }),
    });
    const result = (await client.callTool({
      name: "kanbaner_tasks_task_create",
      arguments: { projectId: "p1", title: "Задача", expectedVersion: 7 },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(http.harness.requests.at(-1)?.url).toBe(
      "http://kanbaner.test/api/v1/commands/kanbaner.tasks.task.create",
    );
    expect(http.harness.requests.at(-1)?.headers.get("idempotency-key")).toMatch(
      /^kanbaner-mcp-[0-9a-f]{64}$/u,
    );
    expect(http.harness.requests.at(-1)?.body).toEqual({
      projectId: "p1",
      title: "Задача",
      expectedVersion: 7,
    });
  });

  it("не вызывает HTTP при невалидном input", async () => {
    const { client, http } = await harness({
      operations: [TASK_CREATE],
      resultForCall: () => Response.json({ ok: true, data: { value: "created" } }),
    });
    const result = (await client.callTool({
      name: "kanbaner_tasks_task_create",
      arguments: { title: "Без проекта" },
    })) as CallToolResult;
    const payload = resultText(result);

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("VALIDATION_ERROR");
    expect(
      http.harness.requests.filter((request) => request.url.includes("/api/v1/commands/")),
    ).toHaveLength(0);
  });

  it("возвращает InvalidParams для неизвестного tool", async () => {
    const { client } = await harness({ operations: [TASK_LIST] });

    await expect(
      client.callTool({ name: "kanbaner_unknown_tool", arguments: {} }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: { code: "UNKNOWN_TOOL", retryable: false },
    });
  });

  it("передаёт стабильную ошибку сервера как isError", async () => {
    const { client } = await harness({
      operations: [TASK_CREATE],
      resultForCall: () =>
        Response.json(
          {
            ok: false,
            error: {
              code: "VERSION_CONFLICT",
              message: "Версия устарела",
              retryable: false,
              details: { currentVersion: 9 },
            },
          },
          { status: 409 },
        ),
    });
    const result = (await client.callTool({
      name: "kanbaner_tasks_task_create",
      arguments: { projectId: "p1", title: "Задача" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT", retryable: false, details: { currentVersion: 9 } },
    });
  });

  it("не публикует destructive без явного флага и публикует с ним", async () => {
    const hidden = await harness({ operations: [TASK_DELETE] });
    const hiddenList = await hidden.client.listTools();

    expect(hiddenList.tools).toEqual([]);

    const allowed = await harness({ operations: [TASK_DELETE], allowDestructive: true });
    const allowedList = await allowed.client.listTools();
    const [tool] = allowedList.tools;

    expect(tool?.name).toBe("kanbaner_tasks_task_delete");
    expect(tool?.description?.startsWith("DESTRUCTIVE.")).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it("даёт структурированную DEPENDENCY_UNAVAILABLE для выключенного API", async () => {
    const harnessInstance = createFetchHarness(() =>
      Response.json(
        {
          ok: false,
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "HTTP API token не настроен на сервере",
            retryable: true,
          },
        },
        { status: 503 },
      ),
    );
    const { server } = createUniversalMcpServer({
      config: TEST_CONFIG,
      fetchImpl: harnessInstance.fetchImpl,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-test", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    open.push({ client, server, http: { harness: harnessInstance, operations: [] } });

    const error = await client.listTools().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: ErrorCode.InternalError,
      data: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
    });
  });

  it("оставляет массивы только в text content", async () => {
    const { client } = await harness({
      operations: [
        rawOperation({
          id: "kanbaner.search.query",
          outputSchema: ARRAY_OUTPUT_SCHEMA,
        }),
      ],
      resultForCall: () => Response.json({ ok: true, data: ["a", "b"] }),
    });
    const { tools } = await client.listTools();
    const tool = tools[0];

    expect(tool?.outputSchema).toBeUndefined();

    const result = (await client.callTool({
      name: "kanbaner_search_query",
      arguments: {},
    })) as CallToolResult;

    expect(result.structuredContent).toBeUndefined();
    expect(resultText(result)).toEqual({ ok: true, data: ["a", "b"] });
  });

  it("не подставляет expectedVersion в mutation", async () => {
    const { client, http } = await harness({
      operations: [NOTE_CREATE],
      resultForCall: () => Response.json({ ok: true, data: { value: "ok" } }),
    });

    await client.callTool({ name: "kanbaner_notes_note_create", arguments: { title: "Заметка" } });

    expect(http.harness.requests.at(-1)?.body).toEqual({ title: "Заметка" });
    expect(http.harness.requests.at(-1)?.headers.get("idempotency-key")).toMatch(/^kanbaner-mcp-/u);
  });

  it("не раскрывает токен и исходный ответ в ошибках", async () => {
    const { client } = await harness({
      operations: [TASK_LIST],
      resultForCall: () => new Response(`<html>${TEST_TOKEN} raw upstream</html>`, { status: 401 }),
    });
    const result = (await client.callTool({
      name: "kanbaner_tasks_task_list",
      arguments: {},
    })) as CallToolResult;

    expect(resultText(result).error?.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(result)).not.toContain("raw upstream");
  });
});
