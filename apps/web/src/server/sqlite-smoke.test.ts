import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

describe("better-sqlite3", () => {
  let database: Database.Database | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("загружает нативный модуль и выполняет SELECT 1 на in-memory базе", () => {
    database = new Database(":memory:");

    const row = database.prepare("SELECT 1 AS value").get() as { value: number } | undefined;

    expect(row).toEqual({ value: 1 });
    expect(database.prepare("SELECT sqlite_version() AS version").pluck().get()).toMatch(
      /^\d+\.\d+\.\d+/,
    );
  });
});
