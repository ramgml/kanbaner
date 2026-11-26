// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_FILE_NAME,
  assertDatabaseFileName,
  assertLocalFilesystemPath,
  isSameFilesystemPath,
  resolveDataDirectory,
  resolveDatabasePath,
  resolveDefaultDataDirectory,
} from "./paths.ts";

const WIN_HOME = "C:\\Users\\aero";
const WIN_APPDATA = "C:\\Users\\aero\\AppData\\Roaming";

describe("resolveDefaultDataDirectory", () => {
  it("использует XDG-подобный путь на Linux", () => {
    expect(resolveDefaultDataDirectory({ platform: "linux", homedir: "/home/aero" })).toBe(
      "/home/aero/.local/share/kanbaner/data",
    );
  });

  it("использует %APPDATA% на Windows", () => {
    expect(
      resolveDefaultDataDirectory({
        platform: "win32",
        homedir: WIN_HOME,
        env: { APPDATA: WIN_APPDATA },
      }),
    ).toBe(`${WIN_APPDATA}\\Kanbaner\\data`);
  });

  it("откатывается к профилю пользователя без %APPDATA%", () => {
    expect(resolveDefaultDataDirectory({ platform: "win32", homedir: WIN_HOME, env: {} })).toBe(
      `${WIN_HOME}\\AppData\\Roaming\\Kanbaner\\data`,
    );
  });
});

describe("resolveDataDirectory", () => {
  it("предпочитает KANBANER_DATA_DIR и обрезает пробелы", () => {
    expect(
      resolveDataDirectory({
        platform: "linux",
        homedir: "/home/aero",
        env: { KANBANER_DATA_DIR: "  /srv/kan baner/ü  " },
      }),
    ).toBe("/srv/kan baner/ü");
  });

  it("игнорирует пустой KANBANER_DATA_DIR", () => {
    expect(
      resolveDataDirectory({
        platform: "linux",
        homedir: "/home/aero",
        env: { KANBANER_DATA_DIR: "   " },
      }),
    ).toBe("/home/aero/.local/share/kanbaner/data");
  });

  it("нормализует Windows-путь с не-ASCII и пробелами", () => {
    expect(
      resolveDataDirectory({
        platform: "win32",
        homedir: WIN_HOME,
        env: { KANBANER_DATA_DIR: "D:\\Данные Kanbaner" },
      }),
    ).toBe("D:\\Данные Kanbaner");
  });

  it("отклоняет сетевые и URI-пути", () => {
    for (const value of [
      "https://example.com/kanbaner",
      "file:///srv/kanbaner",
      "//server/share/kanbaner",
      "\\\\server\\share\\kanbaner",
      "sqlite:kanbaner.sqlite",
    ]) {
      expect(() =>
        resolveDataDirectory({
          platform: "linux",
          homedir: "/home/aero",
          env: { KANBANER_DATA_DIR: value },
        }),
      ).toThrow();
    }
  });
});

describe("resolveDatabasePath", () => {
  it("строит путь внутри каталога данных", () => {
    expect(resolveDatabasePath({ platform: "linux", dataDirectory: "/srv/kan baner/ü" })).toBe(
      "/srv/kan baner/ü/kanbaner.sqlite",
    );
    expect(
      resolveDatabasePath({
        platform: "win32",
        dataDirectory: "D:\\Данные Kanbaner",
        databaseFileName: "kanbaner-prod.sqlite",
      }),
    ).toBe("D:\\Данные Kanbaner\\kanbaner-prod.sqlite");
  });

  it("использует KANBANER_DATA_DIR при отсутствии явного каталога", () => {
    expect(
      resolveDatabasePath({
        platform: "linux",
        homedir: "/home/aero",
        env: { KANBANER_DATA_DIR: "/srv/kanbaner" },
      }),
    ).toBe("/srv/kanbaner/kanbaner.sqlite");
  });

  it("по умолчанию использует kanbaner.sqlite", () => {
    expect(DEFAULT_DATABASE_FILE_NAME).toBe("kanbaner.sqlite");
  });

  it("отклоняет небезопасное имя файла базы", () => {
    for (const value of [
      "",
      ".",
      "..",
      "a/b.sqlite",
      "a\\b.sqlite",
      "../kanbaner.sqlite",
      "база.sqlite",
    ]) {
      expect(() => assertDatabaseFileName(value)).toThrow();
    }

    expect(() => assertDatabaseFileName("kanbaner.sqlite")).not.toThrow();
    expect(() => assertDatabaseFileName("kanbaner_test-2.sqlite")).not.toThrow();
  });
});

describe("assertLocalFilesystemPath", () => {
  it("разрешает локальные POSIX, Windows и extended-length пути", () => {
    for (const value of [
      "/srv/kanbaner/data",
      "/home/ü ser/kan baner",
      "C:\\Users\\aero\\kanbaner.sqlite",
      "\\\\?\\C:\\Users\\aero\\kanbaner.sqlite",
    ]) {
      expect(() => assertLocalFilesystemPath(value, "path")).not.toThrow();
    }
  });

  it("отклоняет пустой путь, NUL, URI и сетевые ресурсы", () => {
    for (const value of [
      "",
      "bad\0path",
      "https://example.com/kanbaner.sqlite",
      "file:///srv/kanbaner.sqlite",
      "\\\\server\\share\\kanbaner.sqlite",
      "//server/share/kanbaner.sqlite",
    ]) {
      expect(() => assertLocalFilesystemPath(value, "path")).toThrow();
    }
  });
});

describe("isSameFilesystemPath", () => {
  it("сравнивает POSIX-пути с учётом регистра", () => {
    expect(isSameFilesystemPath("/srv/kanbaner/data", "/srv/kanbaner/./data", "linux")).toBe(true);
    expect(isSameFilesystemPath("/srv/Kanbaner", "/srv/kanbaner", "linux")).toBe(false);
  });

  it("сравнивает Windows-пути без учёта регистра и с разными разделителями", () => {
    expect(
      isSameFilesystemPath("C:\\Data\\kanbaner.sqlite", "c:/data/KANBANER.sqlite", "win32"),
    ).toBe(true);
    expect(isSameFilesystemPath("C:\\Data\\a.sqlite", "C:\\Data\\b.sqlite", "win32")).toBe(false);
  });
});
