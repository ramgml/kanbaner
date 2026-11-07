import {
  isStorageErrorShape,
  PluginOperationError,
  type JsonObject,
  type PluginErrorCode,
} from "@kanbaner/plugin-sdk";

import {
  TasksNotFoundError,
  TasksStoreValidationError,
  TasksVersionConflictError,
} from "../store/index.ts";
import { TasksValidationError } from "../validation.ts";
import { IdempotencyConflictError } from "./idempotency.ts";

/**
 * Переводит доменные и storage-ошибки в стабильные коды Plugin Contract.
 *
 * Сообщения фиксированные; детали содержат только безопасные идентификаторы и
 * целочисленные версии, но не содержимое задач.
 */
export function mapTasksError(error: unknown): {
  readonly code: PluginErrorCode;
  readonly message: string;
  readonly details?: JsonObject;
} {
  if (error instanceof IdempotencyConflictError) {
    return mapped("IDEMPOTENCY_CONFLICT", error.message, { reason: "idempotency_key" });
  }

  if (error instanceof TasksVersionConflictError) {
    return mapped("VERSION_CONFLICT", "Сущность была изменена другой операцией", {
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
  }

  if (error instanceof TasksNotFoundError) {
    return mapped("NOT_FOUND", error.message, {
      entity: error.entity,
      id: error.id,
    });
  }

  if (error instanceof TasksValidationError) {
    return mapped("VALIDATION_ERROR", error.message, { reason: error.code });
  }

  if (error instanceof TasksStoreValidationError) {
    return mapped("VALIDATION_ERROR", error.message, { reason: "STORE_VALIDATION" });
  }

  if (isStorageErrorShape(error)) {
    switch (error.code) {
      case "VERSION_CONFLICT":
        return mapped("VERSION_CONFLICT", "Сущность была изменена другой операцией");
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

  const mappedError = mapTasksError(error);
  const options = mappedError.details === undefined ? {} : { details: mappedError.details };

  return new PluginOperationError(mappedError.code, mappedError.message, options);
}

/** Бросает ожидаемую ошибку операции. */
export function throwOperationError(error: unknown): never {
  throw toOperationError(error);
}

/** Выполняет обработчик, преобразуя ошибки в стабильный конверт. */
export async function runMapped<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throwOperationError(error);
  }
}
