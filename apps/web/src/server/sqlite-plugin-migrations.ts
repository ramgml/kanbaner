import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  createPluginMigrationHook,
  StorageMigrationRunner,
  type PluginMigrationContext,
  type PluginMigrationLoader,
} from "@kanbaner/kernel";
import type { StorageHealth, StorageMigration, StorageProvider } from "@kanbaner/plugin-sdk";
import { executeSqliteMigrationSql } from "@kanbaner/storage-sqlite";

const MIGRATION_FILE_PATTERN = /^(\d{3,})_([a-z0-9][a-z0-9-]{0,63})\.sql$/u;

export interface LoadedSqlMigration {
  readonly fileName: string;
  readonly version: number;
  readonly name: string;
  readonly source: string;
}

function invalidMigration(message: string): Error {
  return new Error(`Некорректная SQLite-миграция: ${message}`);
}

/**
 * Читает `.sql`-миграции из каталога плагина детерминированно.
 *
 * Формат имени: `<NNN>_<name>.sql`, где `NNN` — положительная версия.
 * Файлы сортируются по версии и имени; дубли версии и symlink-и
 * отклоняются. Содержимое файла становится `source` миграции, поэтому
 * runner вычисляет по нему checksum и блокирует изменение применённого SQL.
 */
export async function loadSqliteMigrationFiles(
  directory: string,
): Promise<readonly LoadedSqlMigration[]> {
  let entries: string[];

  try {
    entries = await readdir(directory);
  } catch {
    throw invalidMigration(`каталог недоступен (${path.basename(directory)})`);
  }

  const files: LoadedSqlMigration[] = [];

  for (const fileName of entries.sort()) {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);

    if (match === null) {
      continue;
    }

    const version = Number(match[1]);
    const name = match[2] ?? "";

    if (!Number.isSafeInteger(version) || version < 1 || name.length === 0) {
      throw invalidMigration(`некорректное имя файла ${fileName}`);
    }

    const filePath = path.join(directory, fileName);
    const info = await lstat(filePath);

    if (!info.isFile()) {
      throw invalidMigration(`${fileName} должен быть обычным файлом`);
    }

    const source = await readFile(filePath, "utf8");

    if (source.trim().length === 0) {
      throw invalidMigration(`${fileName} пуст`);
    }

    files.push({ fileName, version, name, source });
  }

  if (files.length === 0) {
    throw invalidMigration("каталог не содержит файлов <NNN>_<name>.sql");
  }

  files.sort((left, right) =>
    left.version === right.version
      ? left.name.localeCompare(right.name)
      : left.version - right.version,
  );

  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];

    if (previous !== undefined && current !== undefined && previous.version === current.version) {
      throw invalidMigration(
        `версия ${current.version} повторяется: ${previous.fileName}, ${current.fileName}`,
      );
    }
  }

  return files;
}

/** Преобразует файл в backend-neutral миграцию с SQLite `up`. */
export function createSqliteMigration(
  pluginId: string,
  file: LoadedSqlMigration,
): StorageMigration {
  return {
    pluginId,
    version: file.version,
    name: file.name,
    source: file.source,
    async up({ transaction }) {
      executeSqliteMigrationSql(transaction, file.source);
    },
  };
}

/** Loader для lifecycle hook KAN-003 по каноническому `migrationsPath`. */
export function createSqlitePluginMigrationLoader(
  loadFiles: (
    directory: string,
  ) => Promise<readonly LoadedSqlMigration[]> = loadSqliteMigrationFiles,
): PluginMigrationLoader {
  return {
    async load(context: PluginMigrationContext): Promise<readonly StorageMigration[]> {
      if (context.migrationsPath === null) {
        return [];
      }

      const files = await loadFiles(context.migrationsPath);

      return files.map((file) => createSqliteMigration(context.pluginId, file));
    },
  };
}

export interface MigratePluginOptions {
  readonly provider: StorageProvider;
  readonly health?: StorageHealth;
  /** Статический список для тестов вместо чтения каталога. */
  readonly load?: PluginMigrationLoader;
}

/**
 * Применяет SQLite-миграции плагина до активации.
 *
 * Плагин с объявленным `manifest.migrations`, но без доступного каталога или
 * hook-а не должен активироваться молча: ошибка loader-а/runner-а
 * превращается в диагностику `migration_failed` в KAN-003.
 */
export async function migratePluginWithSqlite(
  context: PluginMigrationContext,
  options: MigratePluginOptions,
): Promise<void> {
  if (context.migrationsPath === null) {
    if (context.manifest.migrations !== undefined) {
      throw invalidMigration("манифест объявляет migrations, но canonical path не разрешён");
    }

    return;
  }

  const runner = new StorageMigrationRunner(options.provider, {
    ...(options.health === undefined ? {} : { health: options.health }),
  });
  const hook = createPluginMigrationHook(
    runner,
    options.load ?? createSqlitePluginMigrationLoader(),
  );

  await hook(context);
}
