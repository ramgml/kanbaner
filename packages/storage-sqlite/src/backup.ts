import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
 * Открывается только проверяемый файл (backup или восстановленная копия),
 * а не работающая исходная база приложения.
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
    removeBackupSidecars(databasePath);
  }
}

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

/**
 * Завершает backup-файл: checkpoint-ит возможный WAL в основной файл.
 *
 * `sqlite3_backup` может оставить destination в WAL-режиме с непустым
 * `-wal`. Открытие destination read-write и `wal_checkpoint(TRUNCATE)`
 * переносит страницы в основной файл, после чего SQLite удаляет sidecar-файлы
 * при закрытии. Backup становится самодостаточным и не похож на live-базу.
 */
export function checkpointBackupDatabase(databasePath: string): void {
  let database: Database.Database | undefined;

  try {
    database = new Database(databasePath);
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database?.close();
  }
}

/**
 * Удаляет пустые WAL/SHM sidecar-файлы, созданные read-only проверкой.
 *
 * `.backup()` и offline restore завершают копирование с checkpoint-ом: все
 * страницы уже в основном файле, а `-wal` пуст. Read-only connection к базе в
 * WAL-режиме создаёт `-shm` и пустой `-wal`; без очистки restore отклонял бы
 * собственный свежий backup как содержащий sidecar-файлы live-базы.
 *
 * Непустой `-wal` не удаляется: в нём могут быть незаcheckpoint-ленные данные.
 */
export function removeBackupSidecars(databasePath: string): void {
  const walPath = `${databasePath}-wal`;

  try {
    if (existsSync(walPath)) {
      if (statSync(walPath).size > 0) {
        return;
      }

      rmSync(walPath, { force: true });
    }

    rmSync(`${databasePath}-shm`, { force: true });
  } catch {
    // Очистка sidecar-файлов best-effort и не затирает результат проверки.
  }
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
 * Offline restore в **новый** каталог данных.
 *
 * CLI должен запускаться только при остановленном приложении. Функция не
 * открывает соединение с работающей исходной базой: источник — только файл
 * backup-а. Копирование выполняется SQLite `.backup()`, а не файловыми
 * операциями над live-базой, WAL или SHM.
 */
export async function restoreDatabase(
  options: RestoreDatabaseOptions,
): Promise<RestoreDatabaseResult> {
  const backupPath = path.resolve(options.backupPath);
  const dataDirectory = path.resolve(options.dataDirectory);
  const databaseFileName = options.databaseFileName ?? DEFAULT_DATABASE_FILE_NAME;

  assertLocalFilesystemPath(backupPath, "backupPath");
  assertLocalFilesystemPath(dataDirectory, "dataDirectory");
  assertDatabaseFileName(databaseFileName);

  const targetPath = path.join(dataDirectory, databaseFileName);

  if (targetPath === backupPath) {
    throw sqliteError("INVALID_ARGUMENT", "Backup и целевая база не должны совпадать", {
      details: { reason: "path" },
    });
  }

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${backupPath}${suffix}`)) {
      throw sqliteError(
        "INVALID_ARGUMENT",
        "Backup содержит sidecar-файлы live-базы; используйте online .backup()",
        { details: { reason: "backup" } },
      );
    }
  }

  if (!existsSync(backupPath)) {
    throw sqliteError("INVALID_ARGUMENT", "Файл backup-а не найден", {
      details: { reason: "path" },
    });
  }

  const backupStat = statSync(backupPath);

  if (!backupStat.isFile()) {
    throw sqliteError("INVALID_ARGUMENT", "Backup должен быть файлом", {
      details: { reason: "path" },
    });
  }

  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(`${targetPath}${suffix}`)) {
      throw sqliteError("INVALID_ARGUMENT", "Каталог восстановления уже содержит базу данных", {
        details: { reason: "path" },
      });
    }
  }

  verifyDatabaseIntegrity(backupPath, "INVALID_ARGUMENT");

  let source: Database.Database | undefined;

  try {
    mkdirSync(dataDirectory, { recursive: true });
    source = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000,
    });
    await source.backup(targetPath);
  } catch (error) {
    removeDatabaseFiles(targetPath);

    if (error instanceof StorageError) {
      throw error;
    }

    throw sqliteError("INVALID_ARGUMENT", "Не удалось восстановить базу из backup-а", {
      details: { reason: "backup" },
      cause: error,
    });
  } finally {
    source?.close();
    removeBackupSidecars(backupPath);
  }

  try {
    checkpointBackupDatabase(targetPath);
    verifyDatabaseIntegrity(targetPath, "INTERNAL_ERROR");
    removeBackupSidecars(targetPath);
  } catch (error) {
    removeDatabaseFiles(targetPath);

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
