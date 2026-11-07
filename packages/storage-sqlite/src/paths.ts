import { homedir as osHomedir } from "node:os";
import path from "node:path";

import { sqliteError } from "./errors.ts";

/** Имя файла базы по умолчанию внутри каталога данных. */
export const DEFAULT_DATABASE_FILE_NAME = "kanbaner.sqlite";

export interface DataDirectoryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
}

export interface DatabasePathOptions extends DataDirectoryOptions {
  readonly dataDirectory?: string;
  readonly databaseFileName?: string;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Проверяет, что путь не похож на сетевой или URI-адрес.
 *
 * WAL не поддерживается на сетевых файловых системах. Полностью определить
 * mount type по строке невозможно, поэтому запрещаются явные UNC/URI формы,
 * а документация требует локальный диск. Проверка кроссплатформенная и не
 * зависит от текущей ОС, чтобы конфигурация проверялась одинаково.
 */
export function assertLocalFilesystemPath(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} должно быть непустым путём`, {
      details: { reason: "path" },
    });
  }

  if (value.includes("\0")) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} содержит недопустимый символ`, {
      details: { reason: "path" },
    });
  }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value);

  if (scheme !== null) {
    const name = scheme[1] ?? "";
    const driveLetter = name.length === 1 && /[\\/]/u.test(value.charAt(2));

    if (!driveLetter) {
      throw sqliteError(
        "INVALID_ARGUMENT",
        `Поле ${label} не должно быть URI или сетевым адресом`,
        { details: { reason: "path" } },
      );
    }
  }

  const normalizedSeparators = value.replace(/\//gu, "\\");

  if (/^\\\\/u.test(normalizedSeparators)) {
    const extendedLocal = /^\\\\\?\\[A-Za-z]:\\/u.test(normalizedSeparators);

    if (!extendedLocal) {
      throw sqliteError("INVALID_ARGUMENT", `Поле ${label} не должно указывать на сетевой ресурс`, {
        details: { reason: "path" },
      });
    }
  }

  if (/^\/\//u.test(value)) {
    throw sqliteError("INVALID_ARGUMENT", `Поле ${label} не должно указывать на сетевой ресурс`, {
      details: { reason: "path" },
    });
  }
}

/** Проверяет имя файла базы: только безопасный basename без разделителей. */
export function assertDatabaseFileName(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    /[\\/]/u.test(value) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw sqliteError("INVALID_ARGUMENT", "Некорректное имя файла базы данных", {
      details: { reason: "path" },
    });
  }
}

/**
 * Каталог данных ОС по умолчанию без учёта `KANBANER_DATA_DIR`.
 *
 * Linux: `~/.local/share/kanbaner/data`.
 * Windows: `%APPDATA%\Kanbaner\data`.
 */
export function resolveDefaultDataDirectory(options: DataDirectoryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? osHomedir();
  const api = pathApi(platform);

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();

    return api.resolve(
      appData !== undefined && appData.length > 0 ? appData : api.join(home, "AppData", "Roaming"),
      "Kanbaner",
      "data",
    );
  }

  return api.resolve(home, ".local", "share", "kanbaner", "data");
}

/** Разрешает каталог данных: `KANBANER_DATA_DIR` или каталог ОС по умолчанию. */
export function resolveDataDirectory(options: DataDirectoryOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const configured = env.KANBANER_DATA_DIR;
  const trimmed = configured === undefined ? "" : configured.trim();

  if (trimmed.length > 0) {
    // Проверяем исходную строку до resolve, иначе `https://…` или `//host`
    // нормализуются в локальный абсолютный путь и проверка теряет смысл.
    assertLocalFilesystemPath(trimmed, "KANBANER_DATA_DIR");

    return api.resolve(trimmed);
  }

  const directory = resolveDefaultDataDirectory(options);

  assertLocalFilesystemPath(directory, "KANBANER_DATA_DIR");

  return directory;
}

/** Формирует абсолютный путь к файлу базы внутри каталога данных. */
export function resolveDatabasePath(options: DatabasePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);

  if (options.dataDirectory !== undefined) {
    assertLocalFilesystemPath(options.dataDirectory, "dataDirectory");
  }

  const dataDirectory =
    options.dataDirectory === undefined
      ? resolveDataDirectory(options)
      : api.resolve(options.dataDirectory);
  const databaseFileName = options.databaseFileName ?? DEFAULT_DATABASE_FILE_NAME;

  assertLocalFilesystemPath(dataDirectory, "dataDirectory");
  assertDatabaseFileName(databaseFileName);

  return api.join(dataDirectory, databaseFileName);
}

/** Сравнивает два пути с учётом регистронезависимости Windows. */
export function isSameFilesystemPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApi(platform);
  const normalizedLeft = api.resolve(left);
  const normalizedRight = api.resolve(right);

  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
