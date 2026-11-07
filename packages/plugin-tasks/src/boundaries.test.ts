import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function resolvePackageRoot(): string {
  const fromRepositoryRoot = path.resolve(process.cwd(), "packages", "plugin-tasks");

  return existsSync(path.join(fromRepositoryRoot, "package.json"))
    ? fromRepositoryRoot
    : process.cwd();
}

const packageRoot = resolvePackageRoot();
const sourceRoot = path.join(packageRoot, "src");

const ALLOWED_DEPENDENCIES = new Set(["@kanbaner/plugin-sdk", "@sinclair/typebox"]);

const FORBIDDEN_IMPORTS = [
  /^@kanbaner\/kernel(?:\/|$)/u,
  /^@kanbaner\/storage-sqlite(?:\/|$)/u,
  /^@kanbaner\/plugin-(?:notes|kanban|search|task-list)(?:\/|$)/u,
  /^(?:better-sqlite3|node:sqlite|sqlite3|pg|mysql2?)(?:\/|$)/u,
  /(?:^|\/)apps\//u,
  /packages\/kernel/u,
];

const SQL_PATTERNS = [
  /\bSELECT\b/iu,
  /\bINSERT\s+INTO\b/iu,
  /\bUPDATE\s+\w+\s+SET\b/iu,
  /\bDELETE\s+FROM\b/iu,
  /\bPRAGMA\b/iu,
  /\bRETURNING\b/iu,
  /\bCREATE\s+TABLE\b/iu,
  /\bALTER\s+TABLE\b/iu,
];

const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;

function productionSources(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...productionSources(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(absolute);
    }
  }

  return files;
}

function relative(file: string): string {
  return path.relative(packageRoot, file).replaceAll(path.sep, "/");
}

describe("границы пакета plugin-tasks", () => {
  const files = productionSources(sourceRoot);

  it("не импортирует ядро, драйверы БД и чужие доменные плагины", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");

      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];

        if (specifier === undefined) {
          continue;
        }

        for (const pattern of FORBIDDEN_IMPORTS) {
          if (pattern.test(specifier)) {
            violations.push(`${relative(file)}: ${specifier}`);
          }
        }

        if (specifier.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), specifier);

          if (!resolved.startsWith(`${sourceRoot}${path.sep}`)) {
            violations.push(`${relative(file)}: относительный импорт вне пакета ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("не содержит SQL в исходниках", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");

      for (const pattern of SQL_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${relative(file)}: ${pattern.source}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("зависит только от plugin-sdk и TypeBox", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    const dependencies = Object.keys(manifest.dependencies ?? {});

    expect(dependencies.sort()).toEqual([...ALLOWED_DEPENDENCIES].sort());
  });
});
