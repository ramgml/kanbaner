import type { UniversalMcpConfig } from "./config.ts";
import { createFailure, McpFailureError, readUpstreamFailure } from "./errors.ts";
import { requestJson, type FetchLike } from "./http.ts";
import { isObjectSchema, isPlainObject, type JsonObjectSchema } from "./json.ts";

export const SUPPORTED_API_VERSION = 1;
export const SUPPORTED_CONTRACT_VERSION = 1;

export type OperationKind = "mutation" | "query";
export type OperationRisk = "read" | "write" | "destructive";
export type IdempotencyMode = "none" | "supported";

export interface DiscoveryExposure {
  readonly ui: boolean;
  readonly http: boolean;
  readonly mcp: boolean;
}

/** Проверенный descriptor операции из `/api/v1/discovery`. */
export interface DiscoveryOperation {
  readonly id: string;
  readonly kind: OperationKind;
  readonly risk: OperationRisk;
  readonly exposure: DiscoveryExposure;
  readonly inputSchema: JsonObjectSchema;
  readonly outputSchema?: JsonObjectSchema;
  readonly description?: string;
  readonly idempotency?: IdempotencyMode;
}

function readExposure(value: unknown): DiscoveryExposure | null {
  if (!isPlainObject(value)) {
    return null;
  }

  for (const channel of ["ui", "http", "mcp"] as const) {
    const field = value[channel];

    if (field !== undefined && typeof field !== "boolean") {
      return null;
    }
  }

  return {
    ui: value["ui"] === true,
    http: value["http"] === true,
    mcp: value["mcp"] === true,
  };
}

function readOperation(value: unknown): DiscoveryOperation | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = value["id"];
  const kind = value["kind"];
  const risk = value["risk"];
  const exposure = readExposure(value["exposure"]);
  const inputSchema = value["inputSchema"];

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    (kind !== "mutation" && kind !== "query") ||
    (risk !== "read" && risk !== "write" && risk !== "destructive") ||
    exposure === null ||
    !isObjectSchema(inputSchema)
  ) {
    return null;
  }

  const outputSchema = isObjectSchema(value["outputSchema"]) ? value["outputSchema"] : undefined;
  const descriptionValue = value["description"];
  const description =
    typeof descriptionValue === "string" && descriptionValue.trim().length > 0
      ? descriptionValue
      : undefined;
  const idempotency =
    kind === "mutation" && (value["idempotency"] === "none" || value["idempotency"] === "supported")
      ? value["idempotency"]
      : undefined;

  return {
    id,
    kind,
    risk,
    exposure,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(description === undefined ? {} : { description }),
    ...(idempotency === undefined ? {} : { idempotency }),
  };
}

/**
 * Разбирает discovery и проверяет совместимость.
 *
 * Discovery обязан отдавать additive `exposure`. Если операций нет совсем,
 * пустой каталог допустим; если операции есть, но ни у одной нет `exposure`,
 * это старый сервер и возвращается compatibility error, а не пустой success.
 */
export function parseDiscoveryDocument(
  payload: unknown,
  secret?: string,
): readonly DiscoveryOperation[] {
  if (!isPlainObject(payload)) {
    throw new McpFailureError(
      createFailure("DISCOVERY_INCOMPATIBLE", "Discovery API вернул некорректный ответ", {
        secret,
      }),
    );
  }

  if (payload["ok"] !== true) {
    const upstream = readUpstreamFailure(payload, secret);

    throw new McpFailureError(
      upstream ??
        createFailure("DISCOVERY_INCOMPATIBLE", "Discovery API вернул ошибку", { secret }),
    );
  }

  const data = payload["data"];

  if (!isPlainObject(data)) {
    throw new McpFailureError(
      createFailure("DISCOVERY_INCOMPATIBLE", "Discovery API вернул некорректный ответ", {
        secret,
      }),
    );
  }

  if (
    data["apiVersion"] !== SUPPORTED_API_VERSION ||
    data["contractVersion"] !== SUPPORTED_CONTRACT_VERSION
  ) {
    throw new McpFailureError(
      createFailure(
        "DISCOVERY_INCOMPATIBLE",
        "Discovery API несовместим: требуются apiVersion 1 и contractVersion 1",
        { secret },
      ),
    );
  }

  const operations = data["operations"];

  if (!Array.isArray(operations)) {
    throw new McpFailureError(
      createFailure("DISCOVERY_INCOMPATIBLE", "Discovery API не вернул список операций", {
        secret,
      }),
    );
  }

  let exposurePresent = false;
  const parsed: DiscoveryOperation[] = [];

  for (const raw of operations) {
    if (isPlainObject(raw) && Object.hasOwn(raw, "exposure")) {
      exposurePresent = true;
    }

    const operation = readOperation(raw);

    if (operation !== null) {
      parsed.push(operation);
    }
  }

  if (operations.length > 0 && !exposurePresent) {
    throw new McpFailureError(
      createFailure(
        "DISCOVERY_INCOMPATIBLE",
        "Discovery API несовместим: отсутствует поле exposure",
        { secret },
      ),
    );
  }

  return parsed;
}

export interface DiscoveryClient {
  /** Перечитывает discovery при каждом list/call: статического кэша нет. */
  load(options?: {
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly DiscoveryOperation[]>;
}

export interface DiscoveryClientOptions {
  readonly fetchImpl?: FetchLike;
}

export function createDiscoveryClient(
  config: UniversalMcpConfig,
  options: DiscoveryClientOptions = {},
): DiscoveryClient {
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async load(loadOptions = {}) {
      const payload = await requestJson({
        config,
        fetchImpl,
        method: "GET",
        path: "/api/v1/discovery",
        signal: loadOptions.signal,
      });

      return parseDiscoveryDocument(payload, config.apiToken);
    },
  };
}
