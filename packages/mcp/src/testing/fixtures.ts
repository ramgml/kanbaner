import type { UniversalMcpConfig } from "../config.ts";
import type { DiscoveryOperation, DiscoveryExposure } from "../discovery.ts";
import type { FetchLike } from "../http.ts";
import type { JsonObjectSchema } from "../json.ts";

export const TEST_TOKEN = "test-token";

export const TEST_CONFIG: UniversalMcpConfig = {
  apiUrl: "http://kanbaner.test",
  apiToken: TEST_TOKEN,
  timeoutMs: 1_000,
  allowDestructive: false,
};

export const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} satisfies JsonObjectSchema;

export const OBJECT_OUTPUT_SCHEMA = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} satisfies JsonObjectSchema;

export const ARRAY_OUTPUT_SCHEMA = {
  type: "array",
  items: { type: "string" },
};

export const DEFAULT_EXPOSURE: DiscoveryExposure = {
  ui: true,
  http: true,
  mcp: true,
};

export interface DescribeOptions {
  readonly id: string;
  readonly kind?: "mutation" | "query";
  readonly risk?: "read" | "write" | "destructive";
  readonly exposure?: unknown;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly description?: string;
  readonly idempotency?: unknown;
}

/** Сырой descriptor в форме `/api/v1/discovery`. */
export function rawOperation(options: DescribeOptions): Record<string, unknown> {
  const kind = options.kind ?? "query";
  const risk = options.risk ?? (kind === "query" ? "read" : "write");

  return {
    id: options.id,
    kind,
    pluginId: "kanbaner.test",
    contract: "kanbaner.test",
    version: 1,
    risk,
    ...(kind === "mutation" ? { idempotency: options.idempotency ?? "supported" } : {}),
    exposure: options.exposure ?? DEFAULT_EXPOSURE,
    inputSchema: options.inputSchema ?? EMPTY_INPUT_SCHEMA,
    outputSchema: options.outputSchema ?? OBJECT_OUTPUT_SCHEMA,
    ...(options.description === undefined ? {} : { description: options.description }),
  };
}

export function discoveryEnvelope(
  operations: readonly unknown[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ok: true,
    data: {
      apiVersion: 1,
      contractVersion: 1,
      operations,
      ...overrides,
    },
  };
}

/** Типизированный descriptor для unit-тестов каталога. */
export function describeOperation(options: DescribeOptions): DiscoveryOperation {
  const kind = options.kind ?? "query";
  const risk = options.risk ?? (kind === "query" ? "read" : "write");
  const exposure =
    options.exposure === undefined ? DEFAULT_EXPOSURE : (options.exposure as DiscoveryExposure);

  return {
    id: options.id,
    kind,
    risk,
    exposure,
    inputSchema: (options.inputSchema ?? EMPTY_INPUT_SCHEMA) as JsonObjectSchema,
    ...(options.outputSchema === undefined
      ? { outputSchema: OBJECT_OUTPUT_SCHEMA }
      : options.outputSchema === null
        ? {}
        : { outputSchema: options.outputSchema as JsonObjectSchema }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(kind === "mutation"
      ? { idempotency: (options.idempotency ?? "supported") as "none" | "supported" }
      : {}),
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly redirect: RequestRedirect | undefined;
}

export interface FetchHarness {
  readonly fetchImpl: FetchLike;
  readonly requests: RecordedRequest[];
}

/** Подменяет fetch и записывает запросы без сети. */
export function createFetchHarness(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): FetchHarness {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: bodyText === undefined ? undefined : (JSON.parse(bodyText) as unknown),
      redirect: init?.redirect,
    };

    requests.push(request);

    return handler(request);
  };

  return { fetchImpl, requests };
}
