import { StorageError } from "@kanbaner/plugin-sdk";
import type { JsonObject, StorageErrorCode, StorageErrorOptions } from "@kanbaner/plugin-sdk";

const SAFE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/** Безопасное имя ошибки для структурной диагностики. */
export function safeStorageErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UnknownError";
  }

  return SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
}

/** Совместимый псевдоним публичной ошибки Storage SDK. */
export { StorageError };
export type StorageOperationError = StorageError;
export type StorageOperationErrorDetails = JsonObject;
export type StorageOperationErrorOptions = StorageErrorOptions;

/**
 * Создаёт публичную ошибку Storage-слоя SDK.
 *
 * Ядро использует тот же класс, что и провайдеры, поэтому `instanceof`
 * согласован между пакетами. Сообщения не содержат SQL, путей, секретов и
 * пользовательских документов.
 */
export function storageError(
  code: StorageErrorCode,
  message: string,
  options: StorageErrorOptions = {},
): StorageError {
  return new StorageError(code, message, options);
}

export function isStorageOperationError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}
