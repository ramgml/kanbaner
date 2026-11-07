import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";
import { JsonObjectSchema, createJsonObjectSchema, type JsonObject } from "./json.ts";

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

/**
 * Фабрика схемы ошибки с уникальными `$id` для вложенной JSON-схемы.
 *
 * Нужна там, где ошибка встраивается рядом с другой JSON-схемой: повторное
 * использование одной и той же константы с `$id` ломает компиляцию Ajv.
 */
export function createPluginErrorSchema() {
  return Type.Object(
    {
      code: PluginErrorCodeSchema,
      message: Type.String({ minLength: 1 }),
      retryable: Type.Boolean(),
      details: Type.Optional(createJsonObjectSchema()),
    },
    DRAFT_2020_12,
  );
}

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

/** Фабрика схемы ошибочного результата с уникальными `$id`. */
export function createErrorResultSchema() {
  return Type.Object(
    {
      ok: Type.Literal(false),
      error: createPluginErrorSchema(),
    },
    DRAFT_2020_12,
  );
}

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

/**
 * Ожидаемая ошибка выполнения операции.
 *
 * Плагин выбрасывает её из обработчика, чтобы шина вернула стабильный код
 * Plugin Contract. Любые другие исключения шина заменяет на безопасный
 * `INTERNAL_ERROR`. Публичный тип не зависит от ядра.
 */
export class PluginOperationError extends Error {
  override name = "PluginOperationError";
  readonly error: PluginError;

  constructor(code: PluginErrorCode, message: string, options: PluginErrorOptions = {}) {
    super(message);
    this.error = createPluginError(code, message, options);
  }

  /** Создаёт ошибку из готового конверта `PluginError`. */
  static from(error: PluginError): PluginOperationError {
    const options: PluginErrorOptions =
      error.details === undefined
        ? { retryable: error.retryable }
        : { retryable: error.retryable, details: error.details };

    return new PluginOperationError(error.code, error.message, options);
  }
}

/** Оборачивает ошибку в единый конверт результата. */
export function toErrorResult(error: PluginError): ErrorResult {
  return { ok: false, error };
}
