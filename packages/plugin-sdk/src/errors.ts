import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";
import { JsonObjectSchema, type JsonObject } from "./json.ts";

/** Все стабильные коды ошибок Plugin Contract v1. */
export const PLUGIN_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "PERMISSION_DENIED",
  "DEPENDENCY_UNAVAILABLE",
  "PLUGIN_UNAVAILABLE",
  "CANCELLED",
  "TIMEOUT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];

export const PluginErrorCodeSchema = Type.Union(
  PLUGIN_ERROR_CODES.map((code) => Type.Literal(code)),
);

/**
 * Признак безопасного повтора для каждого кода ошибки.
 *
 * Повторяемыми считаются только заведомо временные состояния. Конфликты,
 * отмена и ошибки валидации требуют явного решения вызывающей стороны.
 */
export const ERROR_RETRYABLE: Readonly<Record<PluginErrorCode, boolean>> = Object.freeze({
  VALIDATION_ERROR: false,
  NOT_FOUND: false,
  VERSION_CONFLICT: false,
  IDEMPOTENCY_CONFLICT: false,
  PERMISSION_DENIED: false,
  DEPENDENCY_UNAVAILABLE: true,
  PLUGIN_UNAVAILABLE: true,
  CANCELLED: false,
  TIMEOUT: true,
  RATE_LIMITED: true,
  INTERNAL_ERROR: false,
});

/**
 * Структурированные детали ошибки.
 *
 * Детали должны содержать только данные, безопасные для журнала и внешнего
 * клиента: без секретов, стека, внутренних путей и содержимого чужих ресурсов.
 */
export type PluginErrorDetails = JsonObject;

export const PluginErrorDetailsSchema = JsonObjectSchema;

export const PluginErrorSchema = Type.Object(
  {
    code: PluginErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
    details: Type.Optional(PluginErrorDetailsSchema),
  },
  DRAFT_2020_12,
);

export type PluginError = Static<typeof PluginErrorSchema>;

export const ErrorResultSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: PluginErrorSchema,
  },
  DRAFT_2020_12,
);

export type ErrorResult = Static<typeof ErrorResultSchema>;

/** Опции создания ошибки; `retryable` можно переопределить осознанно. */
export interface PluginErrorOptions {
  readonly details?: PluginErrorDetails;
  readonly retryable?: boolean;
}

export function isRetryableErrorCode(code: PluginErrorCode): boolean {
  return ERROR_RETRYABLE[code];
}

/** Создаёт ошибку с признаком `retryable` по умолчанию для её кода. */
export function createPluginError(
  code: PluginErrorCode,
  message: string,
  options: PluginErrorOptions = {},
): PluginError {
  const error: {
    code: PluginErrorCode;
    message: string;
    retryable: boolean;
    details?: PluginErrorDetails;
  } = {
    code,
    message,
    retryable: options.retryable ?? isRetryableErrorCode(code),
  };

  if (options.details !== undefined) {
    error.details = options.details;
  }

  return error;
}

/** Оборачивает ошибку в единый конверт результата. */
export function toErrorResult(error: PluginError): ErrorResult {
  return { ok: false, error };
}
