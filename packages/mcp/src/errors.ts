import {
  ERROR_RETRYABLE,
  PLUGIN_ERROR_CODES,
  type JsonObject,
  type PluginErrorCode,
} from "@kanbaner/plugin-sdk";

import { isPlainObject } from "./json.ts";

/** Дополнительные коды ошибок самого MCP-адаптера. */
export const UNIVERSAL_ERROR_CODES = ["DISCOVERY_INCOMPATIBLE", "UNKNOWN_TOOL"] as const;

export type UniversalErrorCode = (typeof UNIVERSAL_ERROR_CODES)[number];

export type McpFailureCode = PluginErrorCode | UniversalErrorCode;

/**
 * Детали ошибки передаются клиенту только для кодов, где они описывают
 * структуру ошибки, а не содержимое ресурса. Остальные детали отбрасываются.
 */
const SAFE_DETAIL_CODES: ReadonlySet<McpFailureCode> = new Set([
  "VALIDATION_ERROR",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
]);

export const REDACTED = "[REDACTED]";

const MAX_MESSAGE_LENGTH = 500;

export interface McpFailure {
  readonly code: McpFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export function isPluginErrorCode(value: unknown): value is PluginErrorCode {
  return typeof value === "string" && (PLUGIN_ERROR_CODES as readonly string[]).includes(value);
}

export function isMcpFailureCode(value: unknown): value is McpFailureCode {
  return (
    isPluginErrorCode(value) ||
    (UNIVERSAL_ERROR_CODES as readonly string[]).includes(value as string)
  );
}

export function retryableForCode(code: McpFailureCode): boolean {
  return isPluginErrorCode(code) ? ERROR_RETRYABLE[code] : false;
}

/**
 * Убирает управляющие символы, ограничивает длину и заменяет секрет.
 *
 * Токен и тело ответа никогда не должны попадать в сообщение об ошибке,
 * но защита применяется повторно, чтобы вызовы с чужим текстом не утекли.
 */
export function redactText(text: string, secret?: string): string {
  const bounded = text
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);

  if (secret === undefined || secret.length === 0) {
    return bounded;
  }

  return bounded.split(secret).join(REDACTED);
}

export interface FailureOptions {
  readonly retryable?: boolean;
  readonly details?: unknown;
  readonly secret?: string | undefined;
}

export function createFailure(
  code: McpFailureCode,
  message: string,
  options: FailureOptions = {},
): McpFailure {
  const safeDetails =
    options.details !== undefined && SAFE_DETAIL_CODES.has(code) && isPlainObject(options.details)
      ? (options.details as JsonObject)
      : undefined;

  return {
    code,
    message: redactText(message, options.secret),
    retryable: options.retryable ?? retryableForCode(code),
    ...(safeDetails === undefined ? {} : { details: safeDetails }),
  };
}

/** Ожидаемая ошибка адаптера с уже безопасным контрактом. */
export class McpFailureError extends Error {
  override readonly name = "McpFailureError";
  readonly failure: McpFailure;

  constructor(failure: McpFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

export function failureFromError(error: unknown, secret?: string): McpFailure {
  if (error instanceof McpFailureError) {
    return error.failure;
  }

  return createFailure("INTERNAL_ERROR", "Внутренняя ошибка MCP-адаптера", { secret });
}

/**
 * Разбирает конверт ошибки HTTP API.
 *
 * Возвращает `null`, если ответ не является стабильной ошибкой контракта:
 * тогда вызывающий код формирует безопасную ошибку по HTTP-статусу.
 */
export function readUpstreamFailure(payload: unknown, secret?: string): McpFailure | null {
  if (!isPlainObject(payload) || payload["ok"] !== false) {
    return null;
  }

  const error = payload["error"];

  if (
    !isPlainObject(error) ||
    !isPluginErrorCode(error["code"]) ||
    typeof error["message"] !== "string" ||
    typeof error["retryable"] !== "boolean"
  ) {
    return null;
  }

  return createFailure(error["code"], error["message"], {
    retryable: error["retryable"],
    ...(error["details"] === undefined ? {} : { details: error["details"] }),
    ...(secret === undefined ? {} : { secret }),
  });
}

/** Безопасное соответствие HTTP-статуса стабильному коду. */
export function failureForStatus(status: number, secret?: string): McpFailure {
  if (status === 401 || status === 403) {
    return createFailure("PERMISSION_DENIED", "Kanbaner API отклонил Bearer token", { secret });
  }

  if (status === 404) {
    return createFailure("NOT_FOUND", "Операция Kanbaner API не найдена", { secret });
  }

  if (status === 429) {
    return createFailure("RATE_LIMITED", "Kanbaner API временно ограничил запросы", { secret });
  }

  if (status === 502 || status === 503) {
    return createFailure("DEPENDENCY_UNAVAILABLE", "Kanbaner API недоступен", { secret });
  }

  if (status === 504) {
    return createFailure("TIMEOUT", "Kanbaner API не ответил вовремя", { secret });
  }

  return createFailure("INTERNAL_ERROR", "Kanbaner API вернул ошибку", { secret });
}

/** Данные протокольной ошибки MCP: стабильный код и retryable. */
export function protocolErrorData(failure: McpFailure): JsonObject {
  return {
    code: failure.code,
    retryable: failure.retryable,
  };
}

/** Текстовый конверт ошибки для `CallToolResult`. */
export function failureResult(failure: McpFailure): {
  readonly ok: false;
  readonly error: McpFailure;
} {
  return { ok: false, error: failure };
}
