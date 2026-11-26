// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  TEST_CONFIG,
  createFetchHarness,
  discoveryEnvelope,
  rawOperation,
} from "./testing/fixtures.ts";
import { createDiscoveryClient, parseDiscoveryDocument } from "./discovery.ts";
import { McpFailureError } from "./errors.ts";

function failureOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpFailureError);
    return (error as McpFailureError).failure;
  }

  throw new Error("ожидалась McpFailureError");
}

describe("discovery", () => {
  it("разбирает актуальный discovery с exposure", () => {
    const operations = parseDiscoveryDocument(
      discoveryEnvelope([
        rawOperation({ id: "kanbaner.tasks.task.list", description: "Список задач" }),
        rawOperation({
          id: "kanbaner.tasks.task.create",
          kind: "mutation",
          idempotency: "supported",
        }),
      ]),
    );

    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      id: "kanbaner.tasks.task.list",
      kind: "query",
      risk: "read",
      exposure: { ui: true, http: true, mcp: true },
      description: "Список задач",
    });
    expect(operations[0]?.idempotency).toBeUndefined();
    expect(operations[1]?.idempotency).toBe("supported");
  });

  it("даёт compatibility error для старого discovery без exposure", () => {
    const legacy = rawOperation({ id: "kanbaner.tasks.task.list" });
    delete legacy["exposure"];

    const failure = failureOf(() => parseDiscoveryDocument(discoveryEnvelope([legacy])));

    expect(failure.code).toBe("DISCOVERY_INCOMPATIBLE");
    expect(failure.message).toContain("exposure");
  });

  it("пропускает отдельный descriptor без exposure, если поле есть у других", () => {
    const legacy = rawOperation({ id: "kanbaner.legacy.operation" });
    delete legacy["exposure"];

    const operations = parseDiscoveryDocument(
      discoveryEnvelope([legacy, rawOperation({ id: "kanbaner.new.operation" })]),
    );

    expect(operations.map((operation) => operation.id)).toEqual(["kanbaner.new.operation"]);
  });

  it("проверяет apiVersion и contractVersion", () => {
    for (const overrides of [{ apiVersion: 2 }, { contractVersion: 2 }]) {
      const failure = failureOf(() =>
        parseDiscoveryDocument(
          discoveryEnvelope([rawOperation({ id: "kanbaner.test.operation" })], overrides),
        ),
      );

      expect(failure.code).toBe("DISCOVERY_INCOMPATIBLE");
    }
  });

  it("допускает пустой список операций", () => {
    expect(parseDiscoveryDocument(discoveryEnvelope([]))).toEqual([]);
  });

  it("пропускает битые descriptors и не-object schemas", () => {
    const operations = parseDiscoveryDocument(
      discoveryEnvelope([
        rawOperation({ id: "kanbaner.good.operation" }),
        rawOperation({ id: "kanbaner.bad.kind", kind: "event" as "query" }),
        rawOperation({ id: "kanbaner.bad.input", inputSchema: { type: "array" } }),
        rawOperation({ id: "kanbaner.bad.exposure", exposure: { ui: "yes" } }),
        "not-an-object",
      ]),
    );

    expect(operations.map((operation) => operation.id)).toEqual(["kanbaner.good.operation"]);
  });

  it("сохраняет стабильную ошибку из конверта discovery", () => {
    const failure = failureOf(() =>
      parseDiscoveryDocument({
        ok: false,
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "HTTP API token не настроен на сервере",
          retryable: true,
        },
      }),
    );

    expect(failure).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
    });
  });

  it("запрашивает discovery с Bearer, mcp-заголовком и redirect:error", async () => {
    const harness = createFetchHarness(() =>
      Response.json(discoveryEnvelope([rawOperation({ id: "kanbaner.tasks.task.list" })])),
    );
    const client = createDiscoveryClient(TEST_CONFIG, { fetchImpl: harness.fetchImpl });
    const operations = await client.load();

    expect(operations).toHaveLength(1);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      url: "http://kanbaner.test/api/v1/discovery",
      method: "GET",
      redirect: "error",
    });
    expect(harness.requests[0]?.headers.get("authorization")).toBe("Bearer test-token");
    expect(harness.requests[0]?.headers.get("x-kanbaner-client")).toBe("mcp");
  });

  it("перечитывает discovery при каждом вызове", async () => {
    let call = 0;
    const harness = createFetchHarness(() => {
      call += 1;

      return Response.json(
        discoveryEnvelope([
          rawOperation({
            id: call === 1 ? "kanbaner.first.operation" : "kanbaner.second.operation",
          }),
        ]),
      );
    });
    const client = createDiscoveryClient(TEST_CONFIG, { fetchImpl: harness.fetchImpl });

    expect((await client.load()).map((operation) => operation.id)).toEqual([
      "kanbaner.first.operation",
    ]);
    expect((await client.load()).map((operation) => operation.id)).toEqual([
      "kanbaner.second.operation",
    ]);
  });
});
