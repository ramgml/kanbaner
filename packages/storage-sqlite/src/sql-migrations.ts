import type { StorageTransaction } from "@kanbaner/plugin-sdk";

import { sqliteError } from "./errors.ts";
import { SqliteStorageTransaction } from "./provider.ts";

/**
 * Выполняет backend-specific SQL плагинной миграции внутри транзакции runner-а.
 *
 * SQL не покидает storage-пакет: загрузчик приложения передаёт содержимое
 * `.sql`-файла, а provider выполняет его в той же транзакции, что и запись
 * журнала миграций.
 */
export function executeSqliteMigrationSql(transaction: StorageTransaction, sql: string): void {
  if (!(transaction instanceof SqliteStorageTransaction)) {
    throw sqliteError("INVALID_ARGUMENT", "SQLite-миграция требует транзакцию SQLite provider-а");
  }

  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw sqliteError("INVALID_ARGUMENT", "SQL миграции не может быть пустым");
  }

  transaction.execMigrationSql(sql);
}
