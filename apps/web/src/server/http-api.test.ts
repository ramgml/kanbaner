// @vitest-environment node

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntime, InMemoryStorageProvider, type PluginRuntime } from "@kanbaner/kernel";
import {
  createJsonObjectSchema,
  type OperationResult,
  type ResourceRef,
} from "@kanbaner/plugin-sdk";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "./application-composition.ts";
import { createHttpApi, type HttpApiBackend } from "./http-api.ts";

const PACKAGES_DIRECTORY = path.resolve(import.meta.dirname, "../../../../packages");
const TOKEN = "test-api-token";
const PROJECT_CREATE = "kanbaner.tasks.project.create";
const PROJECT_LIST = "kanbaner.tasks.project.list";
const PROJECT_UPDATE = "kanbaner.tasks.project.update";
const TASK_CREATE = "kanbaner.tasks.task.create";
const SEARCH_QUERY = "kanbaner.search.query";

interface Project {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}

interface ProjectMutation {
  readonly project: Project;
  readonly resource: ResourceRef;
  readonly eventId: string;
}

interface Harness {
  readonly api: ReturnType<typeof createHttpApi>;
  readonly composition: ApplicationPluginComposition;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const provider = new InMemoryStorageProvider({
    backendId: `http-api-${globalThis.crypto.randomUUID()}`,
  });

  await provider.open();

  const composition = createApplicationPluginComposition({ storage: provider });
  const runtime: PluginRuntime = createPluginRuntime({
    pluginDirectories: [PACKAGES_DIRECTORY],
    disabledPlugins: ["kanbaner.fixture", "kanbaner.notes", "kanbaner.projects"],
    services: composition.services,
  });
  const snapshot = await runtime.start();
  const tasks = snapshot.plugins.find((plugin) => plugin.pluginId === "kanbaner.tasks");

  if (tasks === undefined || !tasks.activated) {
    throw new Error(`Плагин задач не активировался: ${JSON.stringify(snapshot.problems)}`);
  }

  composition.bindPlugins(["kanbaner.tasks"]);

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
    executeHttpOperation: (operationId, input, options) =>
      composition.executeHttpOperation(operationId, input, options),
    resolveHttpResource: (ref) => composition.resolveHttpResource(ref),
  };

  let closed = false;
  const harness: Harness = {
    api: createHttpApi(backend, { getToken: () => TOKEN }),
    composition,
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

  harnesses.push(harness);

  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close();
  }
});

function operationRequest(
  kind: "commands" | "queries",
  operationId: string,
  body: unknown,
  options: { readonly token?: string; readonly headers?: Readonly<Record<string, string>> } = {},
): Request {
  return new Request(`http://localhost/api/v1/${kind}/${operationId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token ?? TOKEN}`,
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

async function resultOf<T>(response: Response): Promise<OperationResult<T>> {
  return (await response.json()) as OperationResult<T>;
}

function dataOf<T>(result: OperationResult<T>): T {
  if (!result.ok) {
    throw new Error(`Операция упала: ${result.error.code} (${result.error.message})`);
  }

  return result.data;
}

describe("HTTP API", () => {
  it("открывает health без токена и защищает discovery", { timeout: 20_000 }, async () => {
    const harness = await startHarness();
    const health = await harness.api.health(new Request("http://localhost/api/v1/health"));

    expect(health.status).toBe(200);
    expect(
      dataOf(await resultOf<{ readonly status: string; readonly started: boolean }>(health)),
    ).toMatchObject({ status: "ok", started: true });
    expect(health.headers.get("x-request-id")).not.toBeNull();

    const denied = await harness.api.discovery(new Request("http://localhost/api/v1/discovery"));

    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");

    const response = await harness.api.discovery(
      new Request("http://localhost/api/v1/discovery", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    const discovery = dataOf(
      await resultOf<{
        readonly apiVersion: number;
        readonly operations: readonly {
          readonly id: string;
          readonly inputSchema: Readonly<Record<string, unknown>>;
        }[];
      }>(response),
    );

    expect(discovery.apiVersion).toBe(1);
    expect(discovery.operations.some((operation) => operation.id === PROJECT_CREATE)).toBe(true);
    expect(discovery.operations.some((operation) => operation.id === SEARCH_QUERY)).toBe(true);
    expect(
      discovery.operations.find((operation) => operation.id === PROJECT_CREATE)?.inputSchema,
    ).toMatchObject({ type: "object" });
  });

  it(
    "выполняет команду, query и resource через один bus с идемпотентностью",
    { timeout: 20_000 },
    async () => {
      const harness = await startHarness();
      const firstResponse = await harness.api.command(
        operationRequest(
          "commands",
          PROJECT_CREATE,
          { title: "API project" },
          {
            headers: { "idempotency-key": "create-project-1", "x-request-id": "agent-request-1" },
          },
        ),
        PROJECT_CREATE,
      );
      const first = dataOf(await resultOf<ProjectMutation>(firstResponse));

      expect(firstResponse.status).toBe(200);
      expect(firstResponse.headers.get("x-request-id")).toBe("agent-request-1");

      const repeatedResponse = await harness.api.command(
        operationRequest(
          "commands",
          PROJECT_CREATE,
          { title: "API project" },
          {
            headers: { "idempotency-key": "create-project-1" },
          },
        ),
        PROJECT_CREATE,
      );
      const repeated = dataOf(await resultOf<ProjectMutation>(repeatedResponse));

      expect(repeated).toEqual(first);

      const listResponse = await harness.api.query(
        operationRequest("queries", PROJECT_LIST, {}),
        PROJECT_LIST,
      );
      const list = dataOf(
        await resultOf<{ readonly items: readonly Project[]; readonly total: number }>(
          listResponse,
        ),
      );

      expect(list.total).toBe(1);
      expect(list.items[0]?.id).toBe(first.project.id);

      const resourceResponse = await harness.api.resource(
        new Request(`http://localhost/api/v1/resources/${encodeURIComponent(first.resource)}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
        first.resource,
      );
      const resource = dataOf(
        await resultOf<{ readonly ref: string; readonly title: string }>(resourceResponse),
      );

      expect(resource).toMatchObject({ ref: first.resource, title: "API project" });
    },
  );

  it("выдаёт search query по HTTP только с Bearer token", { timeout: 20_000 }, async () => {
    const harness = await startHarness();
    const project = dataOf(
      await resultOf<ProjectMutation>(
        await harness.api.command(
          operationRequest("commands", PROJECT_CREATE, { title: "Поисковый проект" }),
          PROJECT_CREATE,
        ),
      ),
    );
    const marker = `http-search-${globalThis.crypto.randomUUID()}`;

    const task = dataOf(
      await resultOf<{ readonly task: { readonly id: string }; readonly resource: ResourceRef }>(
        await harness.api.command(
          operationRequest("commands", TASK_CREATE, {
            projectId: project.project.id,
            title: `${marker} задача`,
          }),
          TASK_CREATE,
        ),
      ),
    );

    const denied = await harness.api.query(
      operationRequest("queries", SEARCH_QUERY, { text: marker }, { token: "wrong-token" }),
      SEARCH_QUERY,
    );

    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");

    const unauthorized = await harness.api.query(
      new Request(`http://localhost/api/v1/queries/${SEARCH_QUERY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: marker }),
      }),
      SEARCH_QUERY,
    );

    expect(unauthorized.status).toBe(401);

    const response = await harness.api.query(
      operationRequest("queries", SEARCH_QUERY, { text: marker }),
      SEARCH_QUERY,
    );
    const result = dataOf(
      await resultOf<{
        readonly hits: readonly { readonly ref: string; readonly title: string }[];
        readonly hasMore: boolean;
        readonly warnings: readonly unknown[];
      }>(response),
    );

    expect(response.status).toBe(200);
    expect(result.hits.map((hit) => hit.ref)).toContain(task.resource);
    expect(result.hits.some((hit) => hit.title === `${marker} задача`)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it(
    "сохраняет доменные ошибки и не выполняет неэкспортированную операцию",
    { timeout: 20_000 },
    async () => {
      const harness = await startHarness();
      const created = dataOf(
        await resultOf<ProjectMutation>(
          await harness.api.command(
            operationRequest("commands", PROJECT_CREATE, { title: "Versions" }),
            PROJECT_CREATE,
          ),
        ),
      );
      const conflictResponse = await harness.api.command(
        operationRequest("commands", PROJECT_UPDATE, {
          id: created.project.id,
          expectedVersion: created.project.version + 1,
          title: "Conflict",
        }),
        PROJECT_UPDATE,
      );
      const conflict = await resultOf(conflictResponse);

      expect(conflictResponse.status).toBe(409);
      expect(conflict.ok).toBe(false);

      if (!conflict.ok) {
        expect(conflict.error.code).toBe("VERSION_CONFLICT");
      }

      const malformed = await harness.api.command(
        new Request(`http://localhost/api/v1/commands/${PROJECT_CREATE}`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: "{not-json",
        }),
        PROJECT_CREATE,
      );

      expect(malformed.status).toBe(400);

      let called = false;
      harness.composition.operations.registerQuery({
        metadata: {
          id: "kanbaner.test.internal.query",
          contract: "kanbaner.test.queries.v1",
          version: 1,
          kind: "query",
          risk: "read",
          exposure: { ui: false, http: false, mcp: false },
          inputSchema: createJsonObjectSchema(),
          outputSchema: createJsonObjectSchema(),
        },
        handler: () => {
          called = true;

          return {};
        },
      });
      const hidden = await harness.api.query(
        operationRequest("queries", "kanbaner.test.internal.query", {}),
        "kanbaner.test.internal.query",
      );

      expect(hidden.status).toBe(404);
      expect(called).toBe(false);
    },
  );

  it(
    "не смешивает command и query transport даже для экспортированного ID",
    { timeout: 20_000 },
    async () => {
      const harness = await startHarness();
      const mutationViaQuery = await harness.api.query(
        operationRequest("queries", PROJECT_CREATE, { title: "Must not exist" }),
        PROJECT_CREATE,
      );
      const queryViaCommand = await harness.api.command(
        operationRequest("commands", PROJECT_LIST, {}),
        PROJECT_LIST,
      );

      expect(mutationViaQuery.status).toBe(404);
      expect(queryViaCommand.status).toBe(404);

      const list = dataOf(
        await resultOf<{ readonly total: number }>(
          await harness.api.query(operationRequest("queries", PROJECT_LIST, {}), PROJECT_LIST),
        ),
      );

      expect(list.total).toBe(0);
    },
  );

  it("возвращает 503 при отключённом серверном token", async () => {
    const disabled = createHttpApi(
      {
        getState: async () => {
          throw new Error("not used");
        },
        listHttpOperations: async () => [],
        executeHttpOperation: async () => {
          throw new Error("not used");
        },
        resolveHttpResource: async () => {
          throw new Error("not used");
        },
      },
      { getToken: () => "" },
    );
    const response = await disabled.discovery(
      new Request("http://localhost/api/v1/discovery", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );

    expect(response.status).toBe(503);
  });
});
