// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { UniversalMcpConfig } from "./config.ts";
import { createOperationInvoker, idempotencyKeyFor, type CallIdentity } from "./http-client.ts";
import type { FetchLike } from "./http.ts";
import {
  createFetchHarness,
  describeOperation,
  OBJECT_OUTPUT_SCHEMA,
  TEST_CONFIG,
  TEST_TOKEN,
} from "./testing/fixtures.ts";
import { buildToolCatalog, type UniversalTool } from "./tools.ts";

const IDENTITY: CallIdentity = {
  requestId: 1,
  instanceId: "instance-id",
  processId: "1234",
};

function toolFor(options: Parameters<typeof describeOperation>[0]): UniversalTool {
  const tool = buildToolCatalog([describeOperation(options)], { allowDestructive: true })[0];

  if (tool === undefined) {
    throw new Error("tool не построен");
  }

  return tool;
}

function invoke(
  tool: UniversalTool,
  input: unknown,
  options: {
    readonly config?: UniversalMcpConfig;
    readonly fetchImpl: FetchLike;
    readonly identity?: CallIdentity;
    readonly signal?: AbortSignal;
  },
) {
  return createOperationInvoker({
    config: options.config ?? TEST_CONFIG,
    fetchImpl: options.fetchImpl,
  }).invoke(tool, input, options.identity ?? IDENTITY, options.signal);
}

describe("HTTP operation client", () => {
  it("вызывает query по encoded path с Bearer и mcp-заголовком", async () => {
    const harness = createFetchHarness(() => Response.json({ ok: true, data: { value: "ok" } }));
    const outcome = await invoke(
      toolFor({ id: "kanbaner.tasks/task list" }),
      { limit: 10 },
      { fetchImpl: harness.fetchImpl },
    );

    expect(outcome).toEqual({ ok: true, data: { value: "ok" } });
    expect(harness.requests[0]).toMatchObject({
      url: "http://kanbaner.test/api/v1/queries/kanbaner.tasks%2Ftask%20list",
      method: "POST",
      body: { limit: 10 },
      redirect: "error",
    });
    expect(harness.requests[0]?.headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(harness.requests[0]?.headers.get("x-kanbaner-client")).toBe("mcp");
    expect(harness.requests[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("вызывает mutation через commands и ставит Idempotency-Key только supported", async () => {
    const harness = createFetchHarness(() => Response.json({ ok: true, data: { value: "ok" } }));
    const tool = toolFor({
      id: "kanbaner.tasks.task.create",
      kind: "mutation",
      idempotency: "supported",
    });
    const outcome = await invoke(tool, { title: "Задача" }, { fetchImpl: harness.fetchImpl });

    expect(outcome.ok).toBe(true);
    expect(harness.requests[0]?.url).toBe(
      "http://kanbaner.test/api/v1/commands/kanbaner.tasks.task.create",
    );
    expect(harness.requests[0]?.headers.get("idempotency-key")).toMatch(
      /^kanbaner-mcp-[0-9a-f]{64}$/u,
    );
  });

  it("не ставит ключ для mutation с idempotency none", async () => {
    const harness = createFetchHarness(() => Response.json({ ok: true, data: { value: "ok" } }));

    await invoke(
      toolFor({ id: "kanbaner.tasks.task.touch", kind: "mutation", idempotency: "none" }),
      {},
      { fetchImpl: harness.fetchImpl },
    );

    expect(harness.requests[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("делает ключ зависимым от operation/input/request/session/process", () => {
    const base = idempotencyKeyFor("kanbaner.tasks.task.create", { title: "a" }, IDENTITY);
    const same = idempotencyKeyFor("kanbaner.tasks.task.create", { title: "a" }, IDENTITY);

    expect(base).toBe(same);
    expect(idempotencyKeyFor("kanbaner.tasks.task.create", { title: "b" }, IDENTITY)).not.toBe(
      base,
    );
    expect(
      idempotencyKeyFor(
        "kanbaner.tasks.task.create",
        { title: "a" },
        {
          ...IDENTITY,
          requestId: 2,
        },
      ),
    ).not.toBe(base);
    expect(
      idempotencyKeyFor(
        "kanbaner.tasks.task.create",
        { title: "a" },
        {
          ...IDENTITY,
          sessionId: "session",
        },
      ),
    ).not.toBe(base);
    expect(
      idempotencyKeyFor(
        "kanbaner.tasks.task.create",
        { title: "a" },
        {
          ...IDENTITY,
          instanceId: "other",
        },
      ),
    ).not.toBe(base);
    expect(
      idempotencyKeyFor(
        "kanbaner.tasks.task.create",
        { title: "a" },
        {
          ...IDENTITY,
          processId: "999",
        },
      ),
    ).not.toBe(base);
  });

  it("передаёт expectedVersion как есть и не добавляет отсутствующий", async () => {
    const harness = createFetchHarness(() => Response.json({ ok: true, data: { value: "ok" } }));
    const tool = toolFor({ id: "kanbaner.tasks.task.update", kind: "mutation" });

    await invoke(tool, { id: "task-1", expectedVersion: 3 }, { fetchImpl: harness.fetchImpl });
    await invoke(tool, { id: "task-1" }, { fetchImpl: harness.fetchImpl });

    expect(harness.requests[0]?.body).toEqual({ id: "task-1", expectedVersion: 3 });
    expect(harness.requests[1]?.body).toEqual({ id: "task-1" });
  });

  it("маппит 401 и редактирует токен", async () => {
    const harness = createFetchHarness(() =>
      Response.json(
        {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: `Требуется Bearer ${TEST_TOKEN}`,
            retryable: false,
          },
        },
        { status: 401 },
      ),
    );
    const outcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.list" }),
      {},
      { fetchImpl: harness.fetchImpl },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(outcome)).not.toContain(TEST_TOKEN);
  });

  it("маппит 503 без тела ответа", async () => {
    const harness = createFetchHarness(() => new Response("unavailable", { status: 503 }));
    const outcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.list" }),
      {},
      { fetchImpl: harness.fetchImpl },
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
    });
    expect(JSON.stringify(outcome)).not.toContain("unavailable");
  });

  it("не возвращает сырое тело при невалидном JSON", async () => {
    const harness = createFetchHarness(
      () => new Response("<html>raw secret body</html>", { status: 200 }),
    );
    const outcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.list" }),
      {},
      { fetchImpl: harness.fetchImpl },
    );

    expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(outcome)).not.toContain("secret body");
  });

  it("проверяет outputSchema и не отдаёт несоответствующие данные", async () => {
    const harness = createFetchHarness(() => Response.json({ ok: true, data: { value: 42 } }));
    const outcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.list" }),
      {},
      { fetchImpl: harness.fetchImpl },
    );

    expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(outcome)).not.toContain("42");
  });

  it("сохраняет details безопасных кодов сервера", async () => {
    const harness = createFetchHarness(() =>
      Response.json(
        {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message: "Версия устарела",
            retryable: false,
            details: { currentVersion: 5 },
          },
        },
        { status: 409 },
      ),
    );
    const outcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.update", kind: "mutation" }),
      { id: "task-1", expectedVersion: 4 },
      { fetchImpl: harness.fetchImpl },
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        details: { currentVersion: 5 },
      },
    });
  });

  it("делает TIMEOUT retryable для query и не-retryable для mutation none", async () => {
    const hangingFetch: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const config: UniversalMcpConfig = { ...TEST_CONFIG, timeoutMs: 5 };
    const queryOutcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.list" }),
      {},
      { fetchImpl: hangingFetch, config },
    );
    const mutationOutcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.touch", kind: "mutation", idempotency: "none" }),
      {},
      { fetchImpl: hangingFetch, config },
    );

    expect(queryOutcome).toMatchObject({ ok: false, error: { code: "TIMEOUT", retryable: true } });
    expect(mutationOutcome).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", retryable: false },
    });
  });

  it("возвращает CANCELLED при отмене вызывающей стороной", async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          reject(new Error("aborted"));
        };

        if (init?.signal?.aborted === true) {
          abort();
          return;
        }

        init?.signal?.addEventListener("abort", abort, { once: true });
      });

    controller.abort();

    const outcome = await invoke(
      toolFor({ id: "kanbaner.tasks.task.list" }),
      {},
      { fetchImpl, signal: controller.signal },
    );

    expect(outcome).toMatchObject({ ok: false, error: { code: "CANCELLED", retryable: false } });
  });

  it("отдаёт массив без outputSchema как успешный результат", async () => {
    const harness = createFetchHarness(() => Response.json({ ok: true, data: ["a", "b"] }));
    const outcome = await invoke(
      toolFor({ id: "kanbaner.search.query", outputSchema: null }),
      {},
      { fetchImpl: harness.fetchImpl },
    );

    expect(outcome).toEqual({ ok: true, data: ["a", "b"] });
  });

  it("принимает object outputSchema только при соответствии", async () => {
    const harness = createFetchHarness(() => Response.json({ ok: true, data: { value: "ok" } }));
    const tool = toolFor({
      id: "kanbaner.tasks.task.list",
      outputSchema: OBJECT_OUTPUT_SCHEMA,
    });
    const outcome = await invoke(tool, {}, { fetchImpl: harness.fetchImpl });

    expect(outcome).toEqual({ ok: true, data: { value: "ok" } });
  });
});
