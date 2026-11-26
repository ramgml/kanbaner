import type { StorageMigration } from "@kanbaner/plugin-sdk";

import { sqliteError } from "./errors.ts";
import { SqliteStorageTransaction } from "./provider.ts";
import {
  CORE_INFRASTRUCTURE_NAME,
  CORE_INFRASTRUCTURE_PLUGIN_ID,
  CORE_INFRASTRUCTURE_VERSION,
  CORE_SCHEMA_SQL,
} from "./schema.ts";

/**
 * Инфраструктурная миграция core-таблиц.
 *
 * Должна применяться composition root-ом до миграций остальных плагинов.
 * DDL идемпотентен, а запись журнала с checksum делает применение
 * exactly-once и блокирует изменение уже применённой миграции.
 */
export function createCoreInfrastructureMigrations(): readonly StorageMigration[] {
  const migration: StorageMigration = {
    pluginId: CORE_INFRASTRUCTURE_PLUGIN_ID,
    version: CORE_INFRASTRUCTURE_VERSION,
    name: CORE_INFRASTRUCTURE_NAME,
    source: CORE_SCHEMA_SQL,
    async up({ transaction }) {
      if (!(transaction instanceof SqliteStorageTransaction)) {
        throw sqliteError(
          "INVALID_ARGUMENT",
          "Инфраструктурная миграция SQLite требует транзакцию SQLite provider-а",
        );
      }

      transaction.execInfrastructureDdl(CORE_SCHEMA_SQL);
    },
  };

  return Object.freeze([migration]);
}
