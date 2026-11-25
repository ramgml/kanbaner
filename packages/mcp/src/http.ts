import type { UniversalMcpConfig } from "./config.ts";
import { createFailure, failureForStatus, McpFailureError, readUpstreamFailure } from "./errors.ts";

/** Минимальная поверхность `fetch`, достаточная адаптеру и тестам. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface JsonRequestOptions {
  readonly config: UniversalMcpConfig;
  readonly fetchImpl: FetchLike;
  readonly method: "GET" | "POST";
  /** Путь от корня API, начинается с `/`. */
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly idempotencyKey?: string | undefined;
  /** `false` для mutation без поддержки идемпотентности. */
  readonly retryableOnTimeout?: boolean;
}

type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function transportFailure(options: JsonRequestOptions, timedOut: boolean) {
  const secret = options.config.apiToken;

  if (options.signal?.aborted === true) {
    return createFailure("CANCELLED", "Вызов Kanbaner отменён клиентом", { secret });
  }

  if (timedOut) {
    return createFailure("TIMEOUT", "Превышено время ожидания Kanbaner API", {
      retryable: options.retryableOnTimeout ?? true,
      secret,
    });
  }

  return createFailure("DEPENDENCY_UNAVAILABLE", "Kanbaner API недоступен", { secret });
}

/**
 * Выполняет HTTP-запрос к Kanbaner API и разбирает JSON.
 *
 * Ошибки транспорта, статуса и JSON заменяются стабильными кодами; тело
 * ответа и заголовки наружу не возвращаются.
 */
export async function requestJson(options: JsonRequestOptions): Promise<unknown> {
  const { config, fetchImpl, method, path } = options;
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${config.apiToken}`,
    "x-kanbaner-client": "mcp",
  };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

  let response: Response;

  try {
    response = await fetchImpl(`${config.apiUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal,
    });
  } catch {
    throw new McpFailureError(transportFailure(options, timeoutSignal.aborted));
  }

  let text: string;

  try {
    text = await response.text();
  } catch {
    throw new McpFailureError(transportFailure(options, timeoutSignal.aborted));
  }

  const parsed = parseJson(text);

  if (!response.ok) {
    const upstream = parsed.ok ? readUpstreamFailure(parsed.value, config.apiToken) : null;

    throw new McpFailureError(upstream ?? failureForStatus(response.status, config.apiToken));
  }

  if (!parsed.ok) {
    throw new McpFailureError(
      createFailure("INTERNAL_ERROR", "Kanbaner API вернул некорректный JSON", {
        secret: config.apiToken,
      }),
    );
  }

  return parsed.value;
}
