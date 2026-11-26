import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import Database from "better-sqlite3";
import { StorageError, type StorageErrorCode } from "@kanbaner/plugin-sdk";

import { sqliteError } from "./errors.ts";
import {
  assertDatabaseFileName,
  assertLocalFilesystemPath,
  DEFAULT_DATABASE_FILE_NAME,
} from "./paths.ts";

export interface IntegrityCheckResult {
  readonly ok: boolean;
  readonly status: string;
}

function readIntegrityStatus(database: Database.Database): string {
  const rows = database.pragma("integrity_check") as readonly {
    readonly integrity_check?: unknown;
  }[];
  const first = rows[0]?.integrity_check;

  if (rows.length !== 1 || typeof first !== "string") {
    return "unexpected";
  }

  return first;
}

/**
 * Проверяет целостность файла базы отдельным read-only соединением.
 *
 * Функция не удаляет и не переименовывает файлы: sidecar-файлы чужой базы
 * остаются нетронутыми. Собственные backup-и публикуются в journal_mode
 * DELETE, поэтому read-only проверка не создаёт рядом с ними WAL/SHM.
 */
export function verifyDatabaseIntegrity(
  databasePath: string,
  errorCode: StorageErrorCode = "INVALID_ARGUMENT",
): IntegrityCheckResult {
  assertLocalFilesystemPath(databasePath, "databasePath");

  let database: Database.Database | undefined;

  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000,
    });
    const status = readIntegrityStatus(database);

    if (status !== "ok") {
      throw sqliteError(errorCode, "Файл базы не прошёл integrity_check", {
        details: { reason: "corrupt" },
      });
    }

    return { ok: true, status };
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw sqliteError(errorCode, "Файл не является корректной базой SQLite", {
      details: { reason: "corrupt" },
      cause: error,
    });
  } finally {
    database?.close();
  }
}

/** Удаляет только собственные временные файлы backup/restore. */
export function removeOwnedFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}

function canFallbackToCopy(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

  return code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function isCorruptDriverError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const shape = error as { code?: unknown; rawCode?: unknown };

  if (typeof shape.rawCode === "number" && (shape.rawCode === 11 || shape.rawCode === 26)) {
    return true;
  }

  return typeof shape.code === "string" && /^SQLITE_(?:CORRUPT|NOTADB|FORMAT)/u.test(shape.code);
}

/**
 * Публикует готовый backup по целевому пути без перезаписи.
 *
 * В том же каталоге используется hardlink (атомарный и без копирования
 * данных). Если файловая система не поддерживает hardlink, выполняется
 * `copyFile(..., COPYFILE_EXCL)`. Существующий destination никогда не
 * перезаписывается и не удаляется.
 */
function publishExclusive(tempPath: string, targetPath: string): void {
  try {
    linkSync(tempPath, targetPath);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw sqliteError("INVALID_ARGUMENT", "Backup destination уже существует", {
        details: { reason: "path" },
      });
    }

    if (!canFallbackToCopy(error)) {
      throw error;
    }

    try {
      copyFileSync(tempPath, targetPath, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      if (isAlreadyExists(copyError)) {
        throw sqliteError("INVALID_ARGUMENT", "Backup destination уже существует", {
          details: { reason: "path" },
        });
      }

      throw copyError;
    }
  } finally {
    removeOwnedFiles(tempPath);
  }
}

/** Проверяет, что путь и все его sidecar-файлы свободны. */
function assertDestinationFree(targetPath: string, label: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(`${targetPath}${suffix}`)) {
      throw sqliteError("INVALID_ARGUMENT", `${label} уже существует`, {
        details: { reason: "path" },
      });
    }
  }
}

/**
 * Завершает backup-файл: checkpoint-ит WAL в основной файл и переводит
 * собственную копию в journal_mode DELETE.
 *
 * Строка результата `wal_checkpoint(TRUNCATE)` проверяется явно: `busy = 1`
 * означает, что checkpoint не завершён, и такой backup нельзя публиковать.
 * DELETE-режим гарантирует самодостаточность файла и отсутствие непустых
 * WAL/SHM sidecar-файлов.
 */
export function checkpointBackupDatabase(databasePath: string): void {
  let database: Database.Database | undefined;

  try {
    database = new Database(databasePath);

    const rows = database.pragma("wal_checkpoint(TRUNCATE)") as readonly {
      readonly busy?: unknown;
    }[];
    const result = rows[0];

    if (result === undefined || Number(result.busy) !== 0) {
      throw sqliteError("INTERNAL_ERROR", "WAL checkpoint backup-а не завершён", {
        retryable: true,
        details: { reason: "busy" },
      });
    }

    const mode = database.pragma("journal_mode = DELETE", { simple: true });

    if (String(mode).toLowerCase() !== "delete") {
      throw sqliteError("INTERNAL_ERROR", "Не удалось перевести backup в journal_mode DELETE", {
        details: { reason: "backup" },
      });
    }
  } finally {
    database?.close();
  }

  const walPath = `${databasePath}-wal`;

  if (existsSync(walPath) && statSync(walPath).size > 0) {
    throw sqliteError("INTERNAL_ERROR", "Backup содержит непустой WAL после checkpoint", {
      retryable: true,
      details: { reason: "busy" },
    });
  }

  rmSync(walPath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

export interface RestoreDatabaseOptions {
  readonly backupPath: string;
  readonly dataDirectory: string;
  readonly databaseFileName?: string;
}

export interface RestoreDatabaseResult {
  readonly databasePath: string;
  readonly sizeBytes: number;
}

/**
 * Требует несуществующий или полностью пустой каталог восстановления.
 *
 * Посторонний файл отклоняется до открытия backup-а. Если каталог создан
 * этой функцией, при ошибке он удаляется только когда остаётся пустым.
 */
function prepareRestoreDirectory(dataDirectory: string): { created: boolean } {
  if (existsSync(dataDirectory)) {
    const info = statSync(dataDirectory);

    if (!info.isDirectory()) {
      throw sqliteError("INVALID_ARGUMENT", "Каталог восстановления не является каталогом", {
        details: { reason: "path" },
      });
    }

    if (readdirSync(dataDirectory).length > 0) {
      throw sqliteError(
        "INVALID_ARGUMENT",
        "Каталог восстановления должен быть несуществующим или полностью пустым",
        { details: { reason: "path" } },
      );
    }

    return { created: false };
  }

  mkdirSync(dataDirectory, { recursive: true });

  return { created: true };
}

/**
 * Offline restore в **новый или пустой** каталог данных.
 *
 * CLI должен запускаться только при остановленном приложении. Источник —
 * только файл backup-а; restore не открывает соединение с работающей базой.
 * Чужие destination и sidecar-файлы не перезаписываются и не удаляются.
 */
export async function restoreDatabase(
  options: RestoreDatabaseOptions,
): Promise<RestoreDatabaseResult> {
  // Проверяем исходные строки до resolve: URI/UNC не должны нормализоваться
  // в локальный абсолютный путь.
  assertLocalFilesystemPath(options.backupPath, "backupPath");
  assertLocalFilesystemPath(options.dataDirectory, "dataDirectory");
  assertDatabaseFileName(options.databaseFileName ?? DEFAULT_DATABASE_FILE_NAME);

  const backupPath = path.resolve(options.backupPath);
  const dataDirectory = path.resolve(options.dataDirectory);
  const databaseFileName = options.databaseFileName ?? DEFAULT_DATABASE_FILE_NAME;

  const directoryState = prepareRestoreDirectory(dataDirectory);
  const targetPath = path.join(dataDirectory, databaseFileName);

  if (targetPath === backupPath) {
    cleanupRestoreDirectory(dataDirectory, directoryState.created);
    throw sqliteError("INVALID_ARGUMENT", "Backup и целевая база не должны совпадать", {
      details: { reason: "path" },
    });
  }

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${backupPath}${suffix}`)) {
      cleanupRestoreDirectory(dataDirectory, directoryState.created);
      throw sqliteError(
        "INVALID_ARGUMENT",
        "Backup содержит sidecar-файлы live-базы; используйте online .backup()",
        { details: { reason: "backup" } },
      );
    }
  }

  if (!existsSync(backupPath)) {
    cleanupRestoreDirectory(dataDirectory, directoryState.created);
    throw sqliteError("INVALID_ARGUMENT", "Файл backup-а не найден", {
      details: { reason: "path" },
    });
  }

  if (!statSync(backupPath).isFile()) {
    cleanupRestoreDirectory(dataDirectory, directoryState.created);
    throw sqliteError("INVALID_ARGUMENT", "Backup должен быть файлом", {
      details: { reason: "path" },
    });
  }

  assertDestinationFree(targetPath, "Целевая база");

  const tempPath = path.join(dataDirectory, `.restore-${randomUUID()}.tmp`);
  let source: Database.Database | undefined;

  try {
    source = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000,
    });
    await source.backup(tempPath);
  } catch (error) {
    removeOwnedFiles(tempPath);
    cleanupRestoreDirectory(dataDirectory, directoryState.created);

    if (error instanceof StorageError) {
      throw error;
    }

    if (isCorruptDriverError(error)) {
      throw sqliteError("INVALID_ARGUMENT", "Файл не является корректной базой SQLite", {
        details: { reason: "corrupt" },
        cause: error,
      });
    }

    throw sqliteError("INVALID_ARGUMENT", "Не удалось восстановить базу из backup-а", {
      details: { reason: "backup" },
      cause: error,
    });
  } finally {
    source?.close();
  }

  try {
    checkpointBackupDatabase(tempPath);
    verifyDatabaseIntegrity(tempPath, "INTERNAL_ERROR");
    assertDestinationFree(targetPath, "Целевая база");
    publishExclusive(tempPath, targetPath);
  } catch (error) {
    removeOwnedFiles(tempPath);
    cleanupRestoreDirectory(dataDirectory, directoryState.created);

    if (error instanceof StorageError) {
      throw error;
    }

    throw sqliteError("INVALID_ARGUMENT", "Не удалось проверить восстановленную базу", {
      details: { reason: "backup" },
      cause: error,
    });
  }

  return { databasePath: targetPath, sizeBytes: statSync(targetPath).size };
}

function cleanupRestoreDirectory(dataDirectory: string, created: boolean): void {
  if (!created) {
    return;
  }

  try {
    if (existsSync(dataDirectory) && readdirSync(dataDirectory).length === 0) {
      rmSync(dataDirectory, { recursive: false, force: true });
    }
  } catch {
    // Каталог мог быть уже удалён или занят; первичная ошибка важнее cleanup.
  }
}

/** Создаёт уникальный временный путь рядом с публикуемым backup-ом. */
export function backupTempPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.backup-${randomUUID()}.tmp`,
  );
}

export { assertDestinationFree, publishExclusive };
