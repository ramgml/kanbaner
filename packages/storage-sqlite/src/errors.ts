import {
  StorageError,
  type StorageErrorCode,
  type StorageErrorOptions,
} from "@kanbaner/plugin-sdk";

/** Внутренние причины ошибок, безопасные для details. */
export type SqliteFailureReason =
  "busy" | "constraint" | "corrupt" | "io" | "closed" | "path" | "backup" | "unknown";

interface DriverErrorShape {
  readonly code?: unknown;
  readonly rawCode?: unknown;
}

function driverErrorShape(error: unknown): DriverErrorShape | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  return error as DriverErrorShape;
}

/** Проверяет, что драйвер сообщил о временной занятости SQLite. */
export function isSqliteBusyError(error: unknown): boolean {
  const shape = driverErrorShape(error);

  if (shape === null) {
    return false;
  }

  const rawCode = typeof shape.rawCode === "number" ? shape.rawCode : null;

  if (rawCode === 5 || rawCode === 6) {
    return true;
  }

  return typeof shape.code === "string" && /^SQLITE_(?:BUSY|LOCKED)/u.test(shape.code);
}

/** Проверяет, что ошибка драйвера связана с ограничением схемы. */
export function isSqliteConstraintError(error: unknown): boolean {
  const shape = driverErrorShape(error);

  if (shape === null) {
    return false;
  }

  if (typeof shape.rawCode === "number" && shape.rawCode === 19) {
    return true;
  }

  return typeof shape.code === "string" && /^SQLITE_CONSTRAINT/u.test(shape.code);
}

function isCorruptOrNotDatabase(error: unknown): boolean {
  const shape = driverErrorShape(error);

  if (shape === null) {
    return false;
  }

  if (typeof shape.rawCode === "number" && (shape.rawCode === 11 || shape.rawCode === 26)) {
    return true;
  }

  return typeof shape.code === "string" && /^SQLITE_(?:CORRUPT|NOTADB|FORMAT)/u.test(shape.code);
}

function isIoError(error: unknown): boolean {
  const shape = driverErrorShape(error);

  return shape !== null && typeof shape.code === "string" && /^SQLITE_IOERR/u.test(shape.code);
}

/** Создаёт публичную ошибку Storage-слоя с безопасным сообщением. */
export function sqliteError(
  code: StorageErrorCode,
  message: string,
  options: StorageErrorOptions = {},
): StorageError {
  return new StorageError(code, message, options);
}

/**
 * Преобразует ошибку драйвера в стабильную ошибку Storage-слоя.
 *
 * Сообщения, SQL, пути и коды SQLite не выходят наружу: details содержат
 * только безопасную причину.
 */
export function toStorageError(error: unknown, attempts = 1): StorageError {
  if (error instanceof StorageError) {
    return error;
  }

  if (isSqliteBusyError(error)) {
    return sqliteError("INTERNAL_ERROR", "Storage backend временно занят", {
      retryable: true,
      details: { reason: "busy", attempts },
      cause: error,
    });
  }

  if (isSqliteConstraintError(error)) {
    return sqliteError("INTERNAL_ERROR", "Операция нарушает ограничение Storage backend", {
      details: { reason: "constraint" },
      cause: error,
    });
  }

  if (isCorruptOrNotDatabase(error)) {
    return sqliteError("INTERNAL_ERROR", "Storage backend повреждён или не является базой SQLite", {
      details: { reason: "corrupt" },
      cause: error,
    });
  }

  if (isIoError(error)) {
    return sqliteError("INTERNAL_ERROR", "Ошибка ввода-вывода Storage backend", {
      details: { reason: "io" },
      cause: error,
    });
  }

  return sqliteError("INTERNAL_ERROR", "Внутренняя ошибка Storage backend", {
    details: { reason: "unknown" },
    cause: error,
  });
}

/** Ошибка закрытого провайдера. */
export function providerClosedError(): StorageError {
  return sqliteError("PROVIDER_CLOSED", "Storage Provider не открыт");
}

/** Ошибка завершённой транзакции или savepoint. */
export function transactionClosedError(): StorageError {
  return sqliteError("TRANSACTION_CLOSED", "Транзакция уже завершена");
}

/** Ошибка отсутствия capability savepoints. */
export function savepointsUnsupportedError(): StorageError {
  return sqliteError("SAVEPOINTS_UNSUPPORTED", "Storage Provider не поддерживает savepoints");
}
