// @vitest-environment node

import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStorageProvider, createPluginRuntime, type PluginRuntime } from "@kanbaner/kernel";
import type { JsonValue, PluginLogger, ResourceRef } from "@kanbaner/plugin-sdk";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "../../apps/web/src/server/application-composition.ts";
import { createHttpApi, type HttpApiBackend } from "../../apps/web/src/server/http-api.ts";
import {
  buildToolCatalog,
  createUniversalMcpServer,
  type FetchLike,
  type UniversalMcpConfig,
} from "../../packages/mcp/src/index.ts";

const PACKAGES_DIRECTORY = path.resolve(import.meta.dirname, "../../packages");
const API_URL = "http://kanbaner.test";
const TOKEN = "universal-mcp-integration-token";

const TASKS_PLUGIN_ID = "kanbaner.tasks";
const NOTES_PLUGIN_ID = "kanbaner.notes";
const SEARCH_PLUGIN_ID = "kanbaner.search";

const PROJECT_CREATE = "kanbaner.tasks.project.create";
const PROJECT_LIST = "kanbaner.tasks.project.list";
const TASK_CREATE = "kanbaner.tasks.task.create";
const TASK_UPDATE = "kanbaner.tasks.task.update";
const SEARCH_QUERY = "kanbaner.search.query";

/** Точный MCP allowlist домена задач из KAN-069. */
const TASKS_MCP_IDS = [
  PROJECT_LIST,
  "kanbaner.tasks.project.get",
  "kanbaner.tasks.column.list",
  "kanbaner.tasks.task.list",
  "kanbaner.tasks.task.get",
  PROJECT_CREATE,
  "kanbaner.tasks.project.update",
  TASK_CREATE,
  TASK_UPDATE,
  "kanbaner.tasks.task.complete",
  "kanbaner.tasks.task.move",
] as const;

const REQUIRED_TOOL_NAMES = [
  "kanbaner_tasks_project_list",
  "kanbaner_tasks_project_get",
  "kanbaner_tasks_column_list",
  "kanbaner_tasks_task_list",
  "kanbaner_tasks_task_get",
  "kanbaner_tasks_project_create",
  "kanbaner_tasks_project_update",
  "kanbaner_tasks_task_create",
  "kanbaner_tasks_task_update",
  "kanbaner_tasks_task_complete",
  "kanbaner_tasks_task_move",
  "kanbaner_notes_note_create",
  "kanbaner_notes_note_get",
  "kanbaner_search_query",
] as const;

const FORBIDDEN_TOOL_NAMES = [
  "kanbaner_tasks_task_delete",
  "kanbaner_tasks_task_deletemany",
  "kanbaner_tasks_task_movemany",
  "kanbaner_tasks_project_delete",
  "kanbaner_tasks_column_delete",
  "kanbaner_tasks_project_summary",
  "kanbaner_notes_note_delete",
  "kanbaner_notes_note_visit",
  "kanbaner_notes_note_attachment_delete",
] as const;

/** Заметки не сужаются: перечисленные операции остаются доступны через metadata. */
const NOTES_MCP_IDS = [
  "kanbaner.notes.note.move",
  "kanbaner.notes.note.favorite.set",
  "kanbaner.notes.note.link",
  "kanbaner.notes.note.unlink",
  "kanbaner.notes.note.attachment.create",
  "kanbaner.notes.note.subtree",
  "kanbaner.notes.note.search",
  "kanbaner.notes.note.links",
] as const;

const NOOP_LOGGER: PluginLogger = Object.freeze({
  debug(): void {
    // Намеренно пусто.
  },
  info(): void {
    // Намеренно пусто.
  },
  warn(): void {
    // Намеренно пусто.
  },
  error(): void {
    // Намеренно пусто.
  },
});

interface BackendHarness {
  readonly provider: InMemoryStorageProvider;
  readonly composition: ApplicationPluginComposition;
  readonly runtime: PluginRuntime;
  readonly fetchImpl: FetchLike;
  /** Значения audit source, реально переданные HTTP transport-ом. */
  readonly sources: readonly unknown[];
  close(): Promise<void>;
}

interface McpSession {
  readonly client: Client;
  readonly server: ReturnType<typeof createUniversalMcpServer>;
  close(): Promise<void>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

function testConfig(overrides: Partial<UniversalMcpConfig> = {}): UniversalMcpConfig {
  return {
    apiUrl: API_URL,
    apiToken: TOKEN,
    timeoutMs: 5_000,
    allowDestructive: false,
    ...overrides,
  };
}

function pathnameOf(input: string | URL | Request): string {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  return new URL(href).pathname;
}

async function startBackend(token: string | null = TOKEN): Promise<BackendHarness> {
  const provider = new InMemoryStorageProvider({
    backendId: `mcp-universal-${globalThis.crypto.randomUUID()}`,
  });

  await provider.open();

  const composition = createApplicationPluginComposition({
    storage: provider,
    logger: NOOP_LOGGER,
  });
  const runtime = createPluginRuntime({
    pluginDirectories: [PACKAGES_DIRECTORY],
    disabledPlugins: ["kanbaner.fixture", "kanbaner.projects", "kanbaner.opencode"],
    services: composition.services,
  });
  const snapshot = await runtime.start();

  for (const pluginId of [TASKS_PLUGIN_ID, NOTES_PLUGIN_ID, SEARCH_PLUGIN_ID]) {
    const plugin = snapshot.plugins.find((candidate) => candidate.pluginId === pluginId);

    if (plugin === undefined || !plugin.activated) {
      throw new Error(`Плагин ${pluginId} не активировался: ${JSON.stringify(snapshot.problems)}`);
    }
  }

  composition.bindPlugins(
    snapshot.plugins
      .filter((plugin) => plugin.activated && plugin.pluginId !== null)
      .map((plugin) => plugin.pluginId as string),
  );

  const sources: unknown[] = [];
  const backend: HttpApiBackend = {
    async getState() {
      return {
        mode: "normal",
        safeMode: false,
        started: true,
        plugins: [],
        problems: [],
        disabledPluginIds: [],
        checkedAt: new Date().toISOString(),
      };
    },
    listHttpOperations: async () => composition.listHttpOperations(),
    async executeHttpOperation(operationId, input, options) {
      sources.push(options.source ?? null);

      return composition.executeHttpOperation(operationId, input, options);
    },
    resolveHttpResource: (ref) => composition.resolveHttpResource(ref),
  };
  const api = createHttpApi(backend, {
    getToken: () => token ?? undefined,
  });

  const fetchImpl: FetchLike = async (input, init) => {
    const pathname = pathnameOf(input);
    const request = new Request(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    );

    if (pathname === "/api/v1/discovery") {
      return api.discovery(request);
    }

    const match = /^\/api\/v1\/(commands|queries)\/([^/]+)$/u.exec(pathname);

    if (match !== null) {
      const operationId = decodeURIComponent(match[2] as string);

      return match[1] === "commands"
        ? api.command(request, operationId)
        : api.query(request, operationId);
    }

    return Response.json({ ok: false }, { status: 404 });
  };

  let closed = false;
  const harness: BackendHarness = {
    provider,
    composition,
    runtime,
    fetchImpl,
    sources,
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await runtime.stop();
      composition.dispose();
      await provider.close();
    },
  };

  closers.push(() => harness.close());

  return harness;
}

async function connectMcp(config: UniversalMcpConfig, fetchImpl: FetchLike): Promise<McpSession> {
  const server = createUniversalMcpServer({
    config,
    fetchImpl,
    instanceId: "test-instance",
    processId: "test-process",
    onDiagnostic: () => undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "kanbaner-universal-integration", version: "1.0.0" },
    { capabilities: {} },
  );

  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);

  let closed = false;
  const session: McpSession = {
    client,
    server,
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await client.close();
      await server.server.close();
    },
  };

  closers.push(() => session.close());

  return session;
}

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface ToolContentBlock {
  readonly type: string;
  readonly text?: string;
}

/**
 * `Client.callTool` типизирован как union с legacy-формой `{ toolResult }`.
 * Нам нужен только стандартный `content`; сужаем форму явно.
 */
function textOf(result: ClientToolResult): string {
  const content = (result as { readonly content?: readonly ToolContentBlock[] }).content;
  const block = content?.find((item) => item.type === "text" && typeof item.text === "string");

  if (block?.text === undefined) {
    throw new Error("MCP tool не вернул текстовый content");
  }

  return block.text;
}

function dataOf<Data>(result: ClientToolResult): Data {
  const payload = JSON.parse(textOf(result)) as { readonly ok: boolean; readonly data: Data };

  expect(payload.ok).toBe(true);

  return payload.data;
}

function failureOf(result: ClientToolResult): {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
} {
  expect(result.isError).toBe(true);

  const payload = JSON.parse(textOf(result)) as {
    readonly ok: boolean;
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly retryable?: boolean;
    };
  };

  expect(payload.ok).toBe(false);

  return payload.error;
}

interface CreatedProject {
  readonly project: { readonly id: string };
}

interface CreatedTask {
  readonly task: { readonly id: string; readonly version: number };
  readonly resource: ResourceRef;
}

interface CreatedNote {
  readonly view: { readonly note: { readonly id: string; readonly version: number } };
}

interface SearchResult {
  readonly hits: readonly { readonly ref: ResourceRef; readonly title: string }[];
}

async function createProject(session: McpSession, title: string): Promise<string> {
  const created = dataOf<CreatedProject>(
    await session.client.callTool({
      name: "kanbaner_tasks_project_create",
      arguments: { title },
    }),
  );

  return created.project.id;
}

async function createTask(
  session: McpSession,
  projectId: string,
  title: string,
): Promise<CreatedTask> {
  return dataOf<CreatedTask>(
    await session.client.callTool({
      name: "kanbaner_tasks_task_create",
      arguments: { projectId, title, status: "todo" },
    }),
  );
}

describe("универсальный MCP поверх реальной HTTP composition", () => {
  it(
    "публикует только allowlist задач, не сужает notes и не публикует delete/bulk",
    { timeout: 30_000 },
    async () => {
      const backend = await startBackend();
      const session = await connectMcp(testConfig(), backend.fetchImpl);

      const { tools } = await session.client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(new Set(names).size).toBe(names.length);

      for (const name of REQUIRED_TOOL_NAMES) {
        expect(names).toContain(name);
      }

      for (const name of FORBIDDEN_TOOL_NAMES) {
        expect(names).not.toContain(name);
      }

      const operations = backend.composition.listHttpOperations();
      const tasksMcp = operations
        .filter((operation) => operation.pluginId === TASKS_PLUGIN_ID && operation.exposure.mcp)
        .map((operation) => operation.id);

      expect(new Set(tasksMcp)).toEqual(new Set(TASKS_MCP_IDS));

      const notesMcp = new Set(
        operations
          .filter((operation) => operation.pluginId === NOTES_PLUGIN_ID && operation.exposure.mcp)
          .map((operation) => operation.id),
      );

      for (const id of NOTES_MCP_IDS) {
        expect(notesMcp).toContain(id);
      }

      const search = operations.find((operation) => operation.id === SEARCH_QUERY);

      expect(search?.exposure).toEqual({ ui: true, http: true, mcp: true });

      // Контракт MCP: операция публикуется только если доступна и по HTTP.
      for (const operation of operations) {
        if (operation.exposure.mcp) {
          expect(operation.exposure.http).toBe(true);
        }
      }
    },
  );

  it(
    "создаёт проект, задачу и заметку, находит их через search и помечает source mcp",
    { timeout: 30_000 },
    async () => {
      const backend = await startBackend();
      const session = await connectMcp(testConfig(), backend.fetchImpl);
      const marker = `mcp-${globalThis.crypto.randomUUID()}`;
      const projectId = await createProject(session, `Проект ${marker}`);
      const task = await createTask(session, projectId, `${marker} задача`);

      const note = dataOf<CreatedNote>(
        await session.client.callTool({
          name: "kanbaner_notes_note_create",
          arguments: { title: `${marker} заметка`, contentMarkdown: "Текст заметки" },
        }),
      );

      expect(note.view.note.id.length).toBeGreaterThan(0);

      const search = dataOf<SearchResult>(
        await session.client.callTool({
          name: "kanbaner_search_query",
          arguments: { text: marker },
        }),
      );

      expect(search.hits.map((hit) => hit.ref)).toEqual(expect.arrayContaining([task.resource]));
      expect(search.hits.some((hit) => hit.ref.startsWith(`${NOTES_PLUGIN_ID}:`))).toBe(true);
      expect(search.hits.some((hit) => hit.title.includes(marker))).toBe(true);

      const listed = dataOf<{ readonly items: readonly { readonly id: string }[] }>(
        await session.client.callTool({
          name: "kanbaner_tasks_task_list",
          arguments: { text: marker },
        }),
      );

      expect(listed.items.map((item) => item.id)).toEqual([task.task.id]);

      expect(backend.sources.length).toBeGreaterThanOrEqual(5);
      expect(backend.sources).toEqual(backend.sources.map(() => ({ type: "mcp", id: "mcp" })));
    },
  );

  it(
    "сохраняет expectedVersion, VERSION_CONFLICT и идемпотентность mutation",
    { timeout: 30_000 },
    async () => {
      const backend = await startBackend();
      const session = await connectMcp(testConfig(), backend.fetchImpl);
      const marker = `mcp-version-${globalThis.crypto.randomUUID()}`;
      const projectId = await createProject(session, `Проект ${marker}`);
      const task = await createTask(session, projectId, `${marker} задача`);

      const conflict = failureOf(
        await session.client.callTool({
          name: "kanbaner_tasks_task_update",
          arguments: { id: task.task.id, expectedVersion: task.task.version + 10, title: "Чужое" },
        }),
      );

      expect(conflict.code).toBe("VERSION_CONFLICT");
      expect(conflict.retryable).toBe(false);
      expect(conflict.message).not.toContain(TOKEN);

      const updated = dataOf<CreatedTask>(
        await session.client.callTool({
          name: "kanbaner_tasks_task_update",
          arguments: {
            id: task.task.id,
            expectedVersion: task.task.version,
            title: `${marker} обновлена`,
          },
        }),
      );

      expect(updated.task.version).toBe(task.task.version + 1);

      const operations = await session.server.discovery.load();
      const tool = buildToolCatalog(operations, { allowDestructive: false }).find(
        (candidate) => candidate.operation.id === TASK_CREATE,
      );

      if (tool === undefined) {
        throw new Error("task.create не попал в MCP-каталог");
      }

      const identity = {
        requestId: "idempotent-request",
        sessionId: "idempotent-session",
        instanceId: "test-instance",
        processId: "test-process",
      };
      const input = { projectId, title: `${marker} идемпотентная` } as unknown as JsonValue;
      const first = await session.server.invoker.invoke(tool, input, identity);
      const second = await session.server.invoker.invoke(tool, input, identity);

      expect(first.ok).toBe(true);
      expect(second).toEqual(first);

      const listed = dataOf<{ readonly items: readonly { readonly id: string }[] }>(
        await session.client.callTool({
          name: "kanbaner_tasks_task_list",
          arguments: { text: `${marker} идемпотентная` },
        }),
      );

      expect(listed.items).toHaveLength(1);
    },
  );

  it(
    "видит synthetic descriptor из discovery без изменения кода адаптера",
    { timeout: 30_000 },
    async () => {
      const syntheticId = "acme.synthetic.echo";
      const fetchImpl: FetchLike = async (input, init) => {
        const pathname = pathnameOf(input);

        expect(new Headers(init?.headers).get("x-kanbaner-client")).toBe("mcp");

        if (pathname === "/api/v1/discovery") {
          return Response.json({
            ok: true,
            data: {
              apiVersion: 1,
              contractVersion: 1,
              operations: [
                {
                  id: syntheticId,
                  kind: "query",
                  risk: "read",
                  exposure: { ui: false, http: true, mcp: true },
                  inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { text: { type: "string", minLength: 1 } },
                    required: ["text"],
                  },
                  outputSchema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { echo: { type: "string" } },
                    required: ["echo"],
                  },
                  description: "Synthetic discovery-driven operation",
                },
              ],
            },
          });
        }

        if (pathname === `/api/v1/queries/${syntheticId}`) {
          const body = JSON.parse(String(init?.body)) as { readonly text: string };

          return Response.json({ ok: true, data: { echo: body.text } });
        }

        return Response.json({ ok: false }, { status: 404 });
      };
      const session = await connectMcp(testConfig(), fetchImpl);

      const { tools } = await session.client.listTools();

      expect(tools.map((tool) => tool.name)).toContain("acme_synthetic_echo");

      const result = dataOf<{ readonly echo: string }>(
        await session.client.callTool({
          name: "acme_synthetic_echo",
          arguments: { text: "hello" },
        }),
      );

      expect(result).toEqual({ echo: "hello" });
    },
  );

  it(
    "возвращает стабильную ошибку, если HTTP API отключён без токена",
    { timeout: 30_000 },
    async () => {
      const backend = await startBackend(null);
      const session = await connectMcp(testConfig(), backend.fetchImpl);

      await expect(session.client.listTools()).rejects.toThrow(/token/iu);

      const call = await session.client.callTool({
        name: "kanbaner_tasks_task_list",
        arguments: {},
      });
      const failure = failureOf(call);

      expect(failure.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(failure.message).not.toContain(TOKEN);
      expect(failure.retryable).toBe(true);
    },
  );
});

// Ссылка на project.list держит контракт: query-операция обязана оставаться
// доступной через MCP, даже если её не вызывает ни один тест выше.
void PROJECT_LIST;
