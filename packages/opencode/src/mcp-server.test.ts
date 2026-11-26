// @vitest-environment node

import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKanbanerMcpServer } from "./mcp-server.ts";
import { idempotencyKey, normalizeApiToken, stableJson } from "./mcp-support.ts";
import { OPENCODE_MCP_TOOLS } from "./tool-metadata.ts";

const clients: Client[] = [];
const servers: McpServer[] = [];
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function harness() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createKanbanerMcpServer({
    apiUrl: "http://kanbaner.test",
    apiToken: "test-token",
  });
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  clients.push(client);
  servers.push(server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

function success(data: unknown): Response {
  return Response.json({ ok: true, data });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});

describe("Kanbaner MCP", () => {
  it("манифест плагина является валидным JSON", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
    ) as { id?: string };
    expect(manifest.id).toBe("kanbaner.opencode");
  });

  it("публикует только allowlist и требует expectedVersion для updates", async () => {
    const { client } = await harness();
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      [
        "note_create",
        "note_get",
        "note_list",
        "note_update",
        "project_create",
        "project_get",
        "project_list",
        "project_update",
        "task_complete",
        "task_create",
        "task_get",
        "task_list",
        "task_move",
        "task_update",
      ].sort(),
    );
    expect(names.some((name) => /delete|shell|filesystem|read_file|write_file/u.test(name))).toBe(
      false,
    );
    const update = result.tools.find((tool) => tool.name === "task_update");
    expect(update?.inputSchema.required).toEqual(expect.arrayContaining(["id", "expectedVersion"]));
    expect(update?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

    expect(OPENCODE_MCP_TOOLS).toHaveLength(14);
    expect(result.tools).toHaveLength(OPENCODE_MCP_TOOLS.length);
    for (const tool of result.tools) {
      const metadata = OPENCODE_MCP_TOOLS.find((entry) => entry.name === `kanbaner_${tool.name}`);
      expect(metadata).toBeDefined();
      expect(metadata?.name.startsWith("kanbaner_")).toBe(true);
      expect(tool.description).toBe(metadata?.description);
      expect(tool.annotations?.readOnlyHint).toBe(metadata?.risk === "read");
      const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
      expect(required.includes("expectedVersion")).toBe(metadata?.requiresExpectedVersion);
    }
  });

  it("отклоняет unknown keys и нулевую task version до HTTP", async () => {
    const fetchMock = vi.fn<Fetch>(async () => success({}));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await harness();

    const unknownKey = await client.callTool({
      name: "project_create",
      arguments: { title: "Проект", descriptionMarkdwn: "Опечатка" },
    });
    const zeroVersion = await client.callTool({
      name: "task_update",
      arguments: { id: "task-1", expectedVersion: 0, title: "Недопустимо" },
    });

    expect(unknownKey.isError).toBe(true);
    expect(zeroVersion.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("передаёт expectedVersion, Bearer и Idempotency-Key через существующий HTTP API", async () => {
    const fetchMock = vi.fn<Fetch>(async () => success({ task: { id: "task-1", version: 4 } }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await harness();

    const result = await client.callTool({
      name: "task_update",
      arguments: { id: "task-1", expectedVersion: 3, title: "Новый заголовок" },
    });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (firstCall === undefined) throw new Error("HTTP call is missing");
    const [url, init] = firstCall;
    expect(url).toBe("http://kanbaner.test/api/v1/commands/kanbaner.tasks.task.update");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({ id: "task-1", expectedVersion: 3, title: "Новый заголовок" }),
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("idempotency-key")).toMatch(/^kanbaner-[a-f0-9]{64}$/u);
  });

  it("различает новые одинаковые create и сохраняет ключ повторной идентичности request", async () => {
    const fetchMock = vi.fn<Fetch>(async () => success({ project: { id: "project-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await harness();

    await client.callTool({ name: "project_create", arguments: { title: "Одинаковый" } });
    await client.callTool({ name: "project_create", arguments: { title: "Одинаковый" } });

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("idempotency-key"),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^kanbaner-/u);
    expect(keys[1]).toMatch(/^kanbaner-/u);
    expect(keys[0]).not.toBe(keys[1]);

    const identity = { requestId: 42, sessionId: "transport-1", openCodeSessionId: "ses-1" };
    expect(idempotencyKey("project.create", { title: "Одинаковый" }, identity)).toBe(
      idempotencyKey("project.create", { title: "Одинаковый" }, identity),
    );
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(
      idempotencyKey(
        "project.create",
        { title: "Одинаковый" },
        { ...identity, instanceId: "server-1" },
      ),
    ).not.toBe(
      idempotencyKey(
        "project.create",
        { title: "Одинаковый" },
        { ...identity, instanceId: "server-2" },
      ),
    );
  });

  it("возвращает структурированную недоступность API без скрытого fallback в домен", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("private endpoint"))),
    );
    const { client } = await harness();

    const result = await client.callTool({ name: "project_list", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as readonly { readonly type: string; readonly text?: string }[];
    expect(content[0]).toMatchObject({ type: "text" });
    const text = content[0]?.type === "text" ? (content[0].text ?? "") : "";
    expect(text).toContain("DEPENDENCY_UNAVAILABLE");
    expect(text).not.toContain("private endpoint");
  });

  it("поддерживает raw token и file substitution в dotenv-форме", () => {
    expect(normalizeApiToken(" test-token ")).toBe("test-token");
    expect(normalizeApiToken("KANBANER_API_TOKEN=test-token\n")).toBe("test-token");
    expect(normalizeApiToken("")).toBeUndefined();
  });
});
