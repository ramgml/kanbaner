// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  assertNoTransactionControlStatements,
  findTransactionControlStatement,
} from "./sql-scanner.ts";

describe("SQL scanner: transaction control", () => {
  it("находит реальные BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE", () => {
    expect(findTransactionControlStatement("BEGIN;")?.keyword).toBe("BEGIN");
    expect(findTransactionControlStatement("COMMIT;")?.keyword).toBe("COMMIT");
    expect(findTransactionControlStatement("END;")?.keyword).toBe("END");
    expect(findTransactionControlStatement("ROLLBACK;")?.keyword).toBe("ROLLBACK");
    expect(findTransactionControlStatement("SAVEPOINT s1;")?.keyword).toBe("SAVEPOINT");
    expect(findTransactionControlStatement("RELEASE SAVEPOINT s1;")?.keyword).toBe("RELEASE");
    expect(
      findTransactionControlStatement("CREATE TABLE plugin_acme_widgets_items (id TEXT);\nCOMMIT;")
        ?.keyword,
    ).toBe("COMMIT");
    expect(
      findTransactionControlStatement(
        "CREATE TABLE plugin_acme_widgets_items (id TEXT);\n/* comment */ ROLLBACK;",
      )?.keyword,
    ).toBe("ROLLBACK");
  });

  it("не даёт false positive для строк, комментариев и quoted identifiers", () => {
    expect(findTransactionControlStatement("SELECT 'COMMIT';")).toBeNull();
    expect(findTransactionControlStatement("SELECT 'it''s ROLLBACK';")).toBeNull();
    expect(findTransactionControlStatement('SELECT "COMMIT";')).toBeNull();
    expect(findTransactionControlStatement("SELECT [ROLLBACK];")).toBeNull();
    expect(findTransactionControlStatement("SELECT `SAVEPOINT`;")).toBeNull();
    expect(findTransactionControlStatement("-- COMMIT\nCREATE TABLE t (id TEXT);")).toBeNull();
    expect(findTransactionControlStatement("/* ROLLBACK */ CREATE TABLE t (id TEXT);")).toBeNull();
    expect(
      findTransactionControlStatement(
        "CREATE TABLE t (id TEXT, note TEXT DEFAULT 'COMMIT'); -- END\nCREATE INDEX i ON t (id);",
      ),
    ).toBeNull();
  });

  it("не считает BEGIN/END внутри trigger body транзакционными statements", () => {
    const sql = `
      CREATE TRIGGER plugin_acme_widgets_audit
      AFTER INSERT ON plugin_acme_widgets_items
      BEGIN
        INSERT INTO plugin_acme_widgets_log (id) VALUES (NEW.id);
        SELECT CASE WHEN NEW.id IS NULL THEN 'END' ELSE 'BEGIN' END;
      END;
      CREATE INDEX plugin_acme_widgets_idx ON plugin_acme_widgets_items (id);
    `;

    expect(findTransactionControlStatement(sql)).toBeNull();
  });

  it("возвращает keyword и offset, а assert бросает безопасную ошибку", () => {
    const match = findTransactionControlStatement("SELECT 1;\n  COMMIT;");

    expect(match).toMatchObject({ keyword: "COMMIT" });
    expect(match?.index).toBeGreaterThan(0);

    expect(() => assertNoTransactionControlStatements("CREATE TABLE t (id); ROLLBACK;")).toThrow();
  });
});
