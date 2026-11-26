import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const kernelStorageDirectory = dirname(fileURLToPath(import.meta.url));
const sdkStorageDirectory = join(kernelStorageDirectory, "../../../plugin-sdk/src/storage");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

const databaseImports = [
  /(?:from|import)\s*\(?\s*["']better-sqlite3["']/,
  /(?:from|import)\s*\(?\s*["']node:sqlite["']/,
  /(?:from|import)\s*\(?\s*["']sqlite3["']/,
  /(?:from|import)\s*\(?\s*["']pg["']/,
  /(?:from|import)\s*\(?\s*["']mysql2?["']/,
  /@prisma\//,
  /drizzle-orm/,
  /kysely/,
];

const sqlStatements = [
  /\bSELECT\b/,
  /\bINSERT\s+INTO\b/,
  /\bUPDATE\s+\w+\s+SET\b/,
  /\bDELETE\s+FROM\b/,
  /\bPRAGMA\b/,
  /\bRETURNING\b/,
  /\bCREATE\s+TABLE\b/,
  /\bALTER\s+TABLE\b/,
];

const synchronousDriverCalls = [
  /\breadFileSync\b/,
  /\bwriteFileSync\b/,
  /\bstatSync\b/,
  /\bopenSync\b/,
  /\.prepare\s*\(/,
];

describe("границы Storage-слоя", () => {
  it("не содержит SQL и импортов драйверов БД", () => {
    for (const file of [
      ...sourceFiles(kernelStorageDirectory),
      ...sourceFiles(sdkStorageDirectory),
    ]) {
      const source = readFileSync(file, "utf8");

      for (const pattern of databaseImports) {
        expect(source, `${file} импортирует драйвер БД ${pattern}`).not.toMatch(pattern);
      }

      for (const pattern of sqlStatements) {
        expect(source, `${file} содержит SQL ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("не использует синхронный API драйвера вне провайдера", () => {
    for (const file of [
      ...sourceFiles(kernelStorageDirectory),
      ...sourceFiles(sdkStorageDirectory),
    ]) {
      const source = readFileSync(file, "utf8");

      for (const pattern of synchronousDriverCalls) {
        expect(source, `${file} содержит синхронный вызов ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("не импортирует kernel, apps и доменные плагины из SDK storage", () => {
    for (const file of sourceFiles(sdkStorageDirectory)) {
      const source = readFileSync(file, "utf8");

      expect(source, `${file} импортирует kernel`).not.toMatch(/@kanbaner\/kernel/);
      expect(source, `${file} импортирует apps`).not.toMatch(/apps\//);
      expect(source, `${file} содержит explicit any`).not.toMatch(/\bany\b/);
    }
  });

  it("не выносит имена инфраструктурных таблиц в публичные контракты", () => {
    const contracts = readFileSync(join(kernelStorageDirectory, "contracts.ts"), "utf8");

    expect(contracts).not.toMatch(/core_plugins/);
    expect(contracts).not.toMatch(/core_plugin_migrations/);
    expect(contracts).not.toMatch(/core_resource_links/);
    expect(contracts).not.toMatch(/\b(?:table|PRAGMA|rowid)\b/);
  });

  it("не содержит AI-провайдеров и векторного поиска", () => {
    for (const file of [
      ...sourceFiles(kernelStorageDirectory),
      ...sourceFiles(sdkStorageDirectory),
    ]) {
      const source = readFileSync(file, "utf8");

      expect(source, `${file} импортирует AI SDK`).not.toMatch(
        /(?:from|import)\s*\(?\s*["'](?:openai|langchain|@langchain\/[a-z-]+|cohere-ai)["']/,
      );
      expect(source, `${file} содержит vector search`).not.toMatch(/\bvector\s+search\b/i);
    }
  });
});
