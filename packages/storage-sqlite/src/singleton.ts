import { resolveDatabasePath } from "./paths.ts";
import { sqliteError } from "./errors.ts";
import {
  createSqliteStorageProvider,
  type SqliteStorageProvider,
  type SqliteStorageProviderOptions,
} from "./provider.ts";

const SINGLETON_KEY = "__kanbanerSqliteStorageV1";

interface StorageSingletonHolder {
  [SINGLETON_KEY]?: {
    readonly key: string;
    readonly provider: SqliteStorageProvider;
  };
}

const globalHolder = globalThis as typeof globalThis & StorageSingletonHolder;

/**
 * Singleton SQLite provider для Next.js hot reload.
 *
 * Повторный импорт модуля не создаёт второе соединение: экземпляр хранится
 * на `globalThis`. Попытка запросить другой каталог данных у уже созданного
 * singleton-а отклоняется, чтобы не открыть две базы в одном процессе.
 */
export function getSqliteStorageProvider(
  options: SqliteStorageProviderOptions = {},
): SqliteStorageProvider {
  const key = resolveDatabasePath(options);
  const existing = globalHolder[SINGLETON_KEY];

  if (existing !== undefined) {
    if (existing.key !== key) {
      throw sqliteError(
        "INVALID_ARGUMENT",
        "SQLite singleton уже создан с другим каталогом данных",
        { details: { reason: "path" } },
      );
    }

    return existing.provider;
  }

  const provider = createSqliteStorageProvider(options);

  globalHolder[SINGLETON_KEY] = { key, provider };

  return provider;
}

/** Закрывает и сбрасывает singleton. Используется shutdown и тестами. */
export async function resetSqliteStorageSingleton(): Promise<void> {
  const existing = globalHolder[SINGLETON_KEY];

  if (existing === undefined) {
    return;
  }

  Reflect.deleteProperty(globalHolder, SINGLETON_KEY);

  await existing.provider.close();
}
