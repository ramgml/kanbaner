import type { JsonValue, OperationResult } from "@kanbaner/plugin-sdk";

import { CliFailure, usageError } from "./errors.ts";

export const DEFAULT_API_URL = "http://127.0.0.1:3000";
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface KanbanerApiClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ApiRequestOptions {
  readonly requestId?: string;
  readonly idempotencyKey?: string;
}

function normalizeBaseUrl(value: string): string {
  const candidate = value.trim().replace(/\/+$/u, "");
  let url: URL;

  if (candidate.includes("?") || candidate.includes("#")) {
    throw usageError("API URL не должен содержать query или hash");
  }

  try {
    url = new URL(candidate);
  } catch {
    throw usageError("KANBANER_API_URL/--url должен содержать абсолютный HTTP(S) URL");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw usageError("API URL должен быть HTTP(S) URL без credentials, query и hash");
  }

  return candidate;
}

function isOperationResult(value: unknown): value is OperationResult<unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  const candidate = value as {
    readonly ok?: unknown;
    readonly data?: unknown;
    readonly error?: unknown;
  };

  if (candidate.ok === true) {
    return "data" in value;
  }

  if (candidate.ok !== false || typeof candidate.error !== "object" || candidate.error === null) {
    return false;
  }

  const error = candidate.error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly retryable?: unknown;
  };

  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}

function transportError(error: unknown): CliFailure {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new CliFailure("TIMEOUT", "Истёк срок ожидания HTTP API", 3, {
      retryable: false,
      details: { reason: "request_timeout" },
    });
  }

  return new CliFailure("DEPENDENCY_UNAVAILABLE", "HTTP API недоступен", 3, {
    details: { reason: "transport_error" },
  });
}

/** Тонкий HTTP-клиент; доменная валидация остаётся на сервере. */
export class KanbanerApiClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: KanbanerApiClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_API_URL);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;

    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw usageError("Таймаут должен быть положительным целым числом миллисекунд");
    }
  }

  health(options: ApiRequestOptions = {}): Promise<OperationResult<unknown>> {
    return this.#request("GET", "/api/v1/health", undefined, options, false);
  }

  discovery(options: ApiRequestOptions = {}): Promise<OperationResult<unknown>> {
    return this.#request("GET", "/api/v1/discovery", undefined, options, true);
  }

  command(
    commandId: string,
    input: JsonValue,
    options: ApiRequestOptions = {},
  ): Promise<OperationResult<unknown>> {
    return this.#request(
      "POST",
      `/api/v1/commands/${encodeURIComponent(commandId)}`,
      input,
      options,
      true,
    );
  }

  query(
    queryId: string,
    input: JsonValue,
    options: ApiRequestOptions = {},
  ): Promise<OperationResult<unknown>> {
    return this.#request(
      "POST",
      `/api/v1/queries/${encodeURIComponent(queryId)}`,
      input,
      options,
      true,
    );
  }

  resource(ref: string, options: ApiRequestOptions = {}): Promise<OperationResult<unknown>> {
    return this.#request(
      "GET",
      `/api/v1/resources/${encodeURIComponent(ref)}`,
      undefined,
      options,
      true,
    );
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    input: JsonValue | undefined,
    options: ApiRequestOptions,
    authenticated: boolean,
  ): Promise<OperationResult<unknown>> {
    if (authenticated && (this.#token === undefined || this.#token.length === 0)) {
      throw new CliFailure("PERMISSION_DENIED", "Задайте Bearer token в KANBANER_API_TOKEN", 2);
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.requestId === undefined ? {} : { "x-request-id": options.requestId }),
      ...(authenticated ? { authorization: `Bearer ${this.#token ?? ""}` } : {}),
      ...(options.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": options.idempotencyKey }),
    };

    if (input !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw transportError(error);
    }

    let body: unknown;

    try {
      body = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new CliFailure("INTERNAL_ERROR", "HTTP API вернул некорректный JSON", 3, {
        details: { reason: "invalid_response", httpStatus: response.status },
      });
    }

    if (!isOperationResult(body)) {
      throw new CliFailure("INTERNAL_ERROR", "HTTP API вернул неизвестный конверт", 3, {
        details: { reason: "invalid_envelope", httpStatus: response.status },
      });
    }

    return body;
  }
}
