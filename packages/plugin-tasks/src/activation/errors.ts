import {
  createPluginError,
  isStorageErrorShape,
  parseResourceRef,
  type JsonObject,
  type PluginError,
  type PluginErrorCode,
  type PluginLogger,
  type PluginSearchService,
} from "@kanbaner/plugin-sdk";

import {
  TasksNotFoundError,
  TasksStoreValidationError,
  TasksVersionConflictError,
} from "../store/index.ts";
import { TasksValidationError } from "../validation.ts";
import { IdempotencyConflictError } from "./idempotency.ts";

/**
 * Форма ожидаемой ошибки операции.
 *
 * Ядро (KAN-004) распознаёт только собственный `OperationFailure`. Публичный
 * SDK не предоставляет аналогичный throwable-тип, а плагину запрещено
 * импортировать ядро. Поэтому activation получает конструктор ошибки хоста
 * через публичный отказ bound-сервиса (см. `captureOperationFailureConstructor`)
 * и создаёт ошибку этого класса. Если хост не предоставил такой класс,
 * используется локальный носитель конверта `PluginError`; шина в этом случае
 * вернёт безопасный `INTERNAL_ERROR`.
 */
export interface OperationFailureLike extends Error {
  readonly error: PluginError;
}

export interface OperationFailureOptions {
  readonly details?: JsonObject;
  readonly retryable?: boolean;
}

export type OperationFailureConstructor = new (
  code: PluginErrorCode,
  message: string,
  options?: OperationFailureOptions,
) => OperationFailureLike;

/** Локальный носитель ошибки для хостов без `OperationFailure`. */
export class TasksOperationError extends Error implements OperationFailureLike {
  override readonly name = "TasksOperationError";
  readonly error: PluginError;

  constructor(code: PluginErrorCode, message: string, options: OperationFailureOptions = {}) {
    super(message);
    this.error = createPluginError(code, message, options);
  }
}

let hostOperationFailure: OperationFailureConstructor | null = null;

function isOperationFailureLike(value: unknown): value is OperationFailureLike {
  if (!(value instanceof Error) || value.name !== "OperationFailure") {
    return false;
  }

  const candidate = value as { readonly error?: unknown };

  return (
    typeof candidate.error === "object" &&
    candidate.error !== null &&
    typeof (candidate.error as { readonly code?: unknown }).code === "string"
  );
}

/**
 * Получает конструктор `OperationFailure` активного хоста.
 *
 * Bound-поиск отклоняет ResourceRef чужого плагина ожидаемой ошибкой ядра.
 * Вызов не имеет побочных эффектов: документ не читается и не изменяется.
 * Возвращает `true`, если конструктор удалось запомнить.
 */
export async function captureOperationFailureConstructor(
  search: PluginSearchService,
  logger: PluginLogger,
): Promise<boolean> {
  const foreign = "kanbaner.fixture:item:activation-probe";

  try {
    parseResourceRef(foreign);
    await search.delete(foreign);
  } catch (error) {
    if (isOperationFailureLike(error)) {
      hostOperationFailure = error.constructor as OperationFailureConstructor;

      return true;
    }
  }

  logger.warn("tasks.operation_failure_unavailable", {
    reason: "host OperationFailure не получен",
  });

  return false;
}

interface MappedError {
  readonly code: PluginErrorCode;
  readonly message: string;
  readonly details?: JsonObject;
}

function mapped(code: PluginErrorCode, message: string, details?: JsonObject): MappedError {
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Переводит доменные и storage-ошибки в стабильные коды Plugin Contract.
 *
 * Сообщения фиксированные; детали содержат только безопасные идентификаторы и
 * целочисленные версии, но не содержимое задач.
 */
export function mapTasksError(error: unknown): MappedError {
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

/**
 * Преобразует произвольную ошибку в ожидаемую ошибку операции.
 *
 * Уже созданный хостом `OperationFailure` пробрасывается без изменений, чтобы
 * не потерять исходный код (например, `PERMISSION_DENIED` bound-сервиса).
 */
export function toOperationError(error: unknown): Error {
  if (isOperationFailureLike(error)) {
    return error;
  }

  const mappedError = mapTasksError(error);
  const options: OperationFailureOptions =
    mappedError.details === undefined ? {} : { details: mappedError.details };

  if (hostOperationFailure !== null) {
    return new hostOperationFailure(mappedError.code, mappedError.message, options);
  }

  return new TasksOperationError(mappedError.code, mappedError.message, options);
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

/**
 * Сбрасывает запомненный конструктор.
 *
 * Нужен только тестам активации, чтобы изолировать глобальное состояние
 * модуля между сценариями.
 */
export function resetOperationFailureConstructor(): void {
  hostOperationFailure = null;
}
