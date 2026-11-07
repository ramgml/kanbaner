// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as publicApi from "./index.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TEST_DIRECTORY, "..");
const REPO_ROOT = path.resolve(TEST_DIRECTORY, "..", "..", "..");

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((relative) => relative.endsWith(".ts") && !relative.endsWith(".test.ts"))
    .map((relative) => path.join(root, relative));
}

function importsOf(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const matches = source.matchAll(/from\s+["']([^"']+)["']/gu);

  return [...matches].map((match) => match[1] ?? "");
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file);
}

describe("границы Storage Provider", () => {
  it("пакет storage-sqlite не зависит от kernel", () => {
    const offenders = sourceFiles(path.join(PACKAGE_ROOT, "src")).filter((file) =>
      importsOf(file).some(
        (specifier) =>
          specifier === "@kanbaner/kernel" || specifier.startsWith("@kanbaner/kernel/"),
      ),
    );

    expect(offenders.map(relative)).toEqual([]);
  });

  it("kernel и plugin-sdk не зависят от SQLite-драйвера и backend-пакета", () => {
    const offenders: string[] = [];

    for (const packageName of ["kernel", "plugin-sdk"]) {
      for (const file of sourceFiles(path.join(REPO_ROOT, "packages", packageName, "src"))) {
        if (
          importsOf(file).some(
            (specifier) =>
              specifier === "better-sqlite3" || specifier.startsWith("@kanbaner/storage-sqlite"),
          )
        ) {
          offenders.push(relative(file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("импорт better-sqlite3 ограничен внутренними модулями провайдера", () => {
    const allowed = new Set(["src/backup.ts", "src/provider.ts"]);
    const files = sourceFiles(path.join(PACKAGE_ROOT, "src"));

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const runtimeImport = source
        .split("\n")
        .some((line) => /^import\s+(?!type\b).*from\s+["']better-sqlite3["']/u.test(line));

      if (runtimeImport) {
        const relativeToPackage = path.relative(PACKAGE_ROOT, file).replaceAll(path.sep, "/");

        expect(allowed.has(relativeToPackage)).toBe(true);
      }
    }
  });

  it("приложение не импортирует внутренности storage-sqlite и драйвер напрямую", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(REPO_ROOT, "apps", "web", "src"))) {
      const imports = importsOf(file);

      if (imports.some((specifier) => specifier.startsWith("@kanbaner/storage-sqlite/"))) {
        offenders.push(relative(file));
      }

      if (imports.includes("better-sqlite3")) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("публичный API не раскрывает внутренние классы и SQL", () => {
    expect(typeof publicApi.createSqliteStorageProvider).toBe("function");
    expect(typeof publicApi.restoreDatabase).toBe("function");
    expect(typeof publicApi.createCoreInfrastructureMigrations).toBe("function");
    expect(publicApi).not.toHaveProperty("SqliteStorageTransaction");
    expect(publicApi).not.toHaveProperty("CORE_SCHEMA_SQL");
    expect(publicApi).not.toHaveProperty("createDocumentStore");
    expect(publicApi).not.toHaveProperty("AsyncMutex");
    expect(publicApi).not.toHaveProperty("SchemaSql");
  });

  it("пакеты не объявляют запрещённые зависимости", () => {
    for (const packageName of ["kernel", "plugin-sdk"]) {
      const manifest = JSON.parse(
        readFileSync(path.join(REPO_ROOT, "packages", packageName, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

      expect(manifest.dependencies ?? {}).not.toHaveProperty("better-sqlite3");
      expect(manifest.dependencies ?? {}).not.toHaveProperty("@kanbaner/storage-sqlite");
      expect(manifest.peerDependencies ?? {}).not.toHaveProperty("better-sqlite3");
    }

    const storageManifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect(storageManifest.dependencies ?? {}).not.toHaveProperty("@kanbaner/kernel");
    expect(storageManifest.devDependencies ?? {}).toHaveProperty("@kanbaner/kernel");
  });
});
