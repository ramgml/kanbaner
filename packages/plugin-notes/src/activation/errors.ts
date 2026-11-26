import {
  isStorageErrorShape,
  PluginOperationError,
  type JsonObject,
  type PluginErrorCode,
} from "@kanbaner/plugin-sdk";

import {
  NotesNotFoundError,
  NotesSubtreeConflictError,
  NotesValidationError,
  NotesVersionConflictError,
} from "../store.ts";
import { IdempotencyConflictError } from "./idempotency.ts";

/**
 * Переводит доменные и storage-ошибки в стабильные коды Plugin Contract.
 *
 * Сообщения фиксированные; детали содержат только безопасные идентификаторы,
 * причины и целочисленные версии, но не содержимое заметок.
 */
export function mapNotesError(error: unknown): {
  readonly code: PluginErrorCode;
  readonly message: string;
  readonly details?: JsonObject;
} {
  if (error instanceof IdempotencyConflictError) {
    return mapped("IDEMPOTENCY_CONFLICT", error.message, { reason: "idempotency_key" });
  }

  if (error instanceof NotesVersionConflictError) {
    return mapped("VERSION_CONFLICT", "Заметка была изменена другой операцией", {
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
  }

  if (error instanceof NotesSubtreeConflictError) {
    return mapped("VERSION_CONFLICT", error.message, {
      expectedDescendants: error.expectedDescendants,
      actualDescendants: error.actualDescendants,
    });
  }

  if (error instanceof NotesNotFoundError) {
    return mapped("NOT_FOUND", error.message, {
      entity: error.entity,
      id: error.id,
    });
  }

  if (error instanceof NotesValidationError) {
    return mapped("VALIDATION_ERROR", error.message, { reason: error.reason });
  }

  if (isStorageErrorShape(error)) {
    switch (error.code) {
      case "VERSION_CONFLICT":
        return mapped("VERSION_CONFLICT", "Заметка была изменена другой операцией");
      case "NOT_FOUND":
        return mapped("NOT_FOUND", "Ресурс не найден");
      case "IDEMPOTENCY_CONFLICT":
        return mapped("IDEMPOTENCY_CONFLICT", "Idempotency-Key уже использован");
      case "INVALID_ARGUMENT":
        return mapped("VALIDATION_ERROR", "Аргумент операции не прошёл валидацию");
      default:
        return mapped("INTERNAL_ERROR", "Внутренняя ошибка хранилища");
    }
  }

  return mapped("INTERNAL_ERROR", "Внутренняя ошибка операции");
}

function mapped(
  code: PluginErrorCode,
  message: string,
  details?: JsonObject,
): { readonly code: PluginErrorCode; readonly message: string; readonly details?: JsonObject } {
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Преобразует произвольную ошибку в ожидаемую ошибку операции.
 *
 * Уже созданный `PluginOperationError` (включая kernel `OperationFailure`)
 * пробрасывается без изменений, чтобы не потерять исходный код.
 */
export function toOperationError(error: unknown): Error {
  if (error instanceof PluginOperationError) {
    return error;
  }

  const mappedError = mapNotesError(error);
  const options = mappedError.details === undefined ? {} : { details: mappedError.details };

  return new PluginOperationError(mappedError.code, mappedError.message, options);
}

/** Выполняет обработчик, преобразуя ошибки в стабильный конверт. */
export async function runMapped<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw toOperationError(error);
  }
}
