import type { JsonObject } from "../json.ts";

/**
 * Стабильные коды ошибок Storage-слоя.
 *
 * Коды не зависят от backend и не раскрывают SQL-состояния драйвера.
 * `VERSION_CONFLICT` и `NOT_FOUND` совпадают по смыслу с Plugin Contract.
 */
export const STORAGE_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_BACKEND_ID",
  "INVALID_PLUGIN_ID",
  "INVALID_PROVIDER",
  "DUPLICATE_BACKEND",
  "UNKNOWN_BACKEND",
  "ACTIVE_BACKEND_CONFLICT",
  "NO_ACTIVE_BACKEND",
  "MISSING_TRANSACTIONS_CAPABILITY",
  "CAPABILITY_UNAVAILABLE",
  "PROVIDER_CLOSED",
  "PROVIDER_NOT_READY",
  "HEALTH_CHECK_FAILED",
  "VERSION_CONFLICT",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE_STORE_CONTRACT",
  "SAVEPOINTS_UNSUPPORTED",
  "INVALID_MIGRATION",
  "MIGRATION_CHECKSUM_MISMATCH",
  "MIGRATION_FAILED",
  "TRANSACTION_CLOSED",
  "INTERNAL_ERROR",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/** Безопасные структурированные детали ошибки Storage-слоя. */
export type StorageErrorDetails = JsonObject;

/** Повторяемость ошибки. Повторяются только заведомо временные состояния. */
export const STORAGE_ERROR_RETRYABLE: Readonly<Record<StorageErrorCode, boolean>> = Object.freeze({
  INVALID_ARGUMENT: false,
  INVALID_BACKEND_ID: false,
  INVALID_PLUGIN_ID: false,
  INVALID_PROVIDER: false,
  DUPLICATE_BACKEND: false,
  UNKNOWN_BACKEND: false,
  ACTIVE_BACKEND_CONFLICT: false,
  NO_ACTIVE_BACKEND: false,
  MISSING_TRANSACTIONS_CAPABILITY: false,
  CAPABILITY_UNAVAILABLE: false,
  PROVIDER_CLOSED: false,
  PROVIDER_NOT_READY: false,
  HEALTH_CHECK_FAILED: true,
  VERSION_CONFLICT: false,
  NOT_FOUND: false,
  IDEMPOTENCY_CONFLICT: false,
  DUPLICATE_STORE_CONTRACT: false,
  SAVEPOINTS_UNSUPPORTED: false,
  INVALID_MIGRATION: false,
  MIGRATION_CHECKSUM_MISMATCH: false,
  MIGRATION_FAILED: false,
  TRANSACTION_CLOSED: false,
  INTERNAL_ERROR: false,
});

/** Структурная форма ошибки, не зависящая от класса реализации. */
export interface StorageErrorShape {
  readonly name: string;
  readonly message: string;
  readonly code: StorageErrorCode;
  readonly retryable: boolean;
  readonly details?: StorageErrorDetails;
}

export interface StorageErrorOptions {
  readonly details?: StorageErrorDetails;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * Ошибка Storage-слоя.
 *
 * Сообщения фиксированные и не содержат SQL, путей, секретов и содержимого
 * пользовательских документов.
 */
export class StorageError extends Error implements StorageErrorShape {
  override readonly name = "StorageError";
  readonly code: StorageErrorCode;
  readonly retryable: boolean;
  readonly details?: StorageErrorDetails;

  constructor(code: StorageErrorCode, message: string, options: StorageErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? STORAGE_ERROR_RETRYABLE[code];

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

/** Проверяет структурную форму ошибки без привязки к конкретному классу. */
export function isStorageErrorShape(value: unknown): value is StorageErrorShape {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    readonly name?: unknown;
    readonly message?: unknown;
    readonly code?: unknown;
    readonly retryable?: unknown;
  };

  return (
    typeof candidate.name === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    (STORAGE_ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.retryable === "boolean"
  );
}
