import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function resolvePackageRoot(): string {
  const fromRepositoryRoot = path.resolve(process.cwd(), "packages", "plugin-tasks");

  return existsSync(path.join(fromRepositoryRoot, "package.json"))
    ? fromRepositoryRoot
    : process.cwd();
}

const packageRoot = resolvePackageRoot();
const sourceRoot = path.join(packageRoot, "src");
const contractSource = path.join(sourceRoot, "contract.ts");
const contractDist = path.join(packageRoot, "dist", "contract.js");

const ALLOWED_EXTERNALS = new Set(["@kanbaner/plugin-sdk", "@sinclair/typebox"]);

const FORBIDDEN_MODULES = [
  /^node:/u,
  /^@kanbaner\/kernel(?:\/|$)/u,
  /^@kanbaner\/storage-sqlite(?:\/|$)/u,
  /^@kanbaner\/plugin-(?:notes|kanban|search|task-list)(?:\/|$)/u,
  /^(?:better-sqlite3|node:sqlite|sqlite3|pg|mysql2?)(?:\/|$)/u,
  /^(?:react|react-dom)(?:\/|$)/u,
];

const FORBIDDEN_RELATIVE_MODULES = new Set(["store.ts", "operations.ts", "index.ts"]);

interface ModuleReference {
  readonly specifier: string;
  readonly kind: string;
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function moduleReferences(file: string): ModuleReference[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const references: ModuleReference[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;

      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
        references.push({
          specifier: specifier.text,
          kind: ts.isImportDeclaration(node) ? "import" : "export",
        });
      }
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const firstArgument = node.arguments[0];

      if (
        (isRequire || isDynamicImport) &&
        firstArgument !== undefined &&
        ts.isStringLiteralLike(firstArgument)
      ) {
        references.push({
          specifier: firstArgument.text,
          kind: isRequire ? "require" : "dynamic import",
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return references;
}

function relative(file: string): string {
  return path.relative(packageRoot, file).replaceAll(path.sep, "/");
}

/**
 * Обходит граф contract entrypoint по относительным импортам и собирает
 * внешние модули. Любой серверный или Node.js-модуль делает тест красным.
 */
function analyzeContractGraph(): {
  readonly externals: readonly string[];
  readonly files: string[];
} {
  const visited = new Set<string>();
  const externals = new Set<string>();
  const files: string[] = [];
  const violations: string[] = [];

  const visit = (file: string): void => {
    if (visited.has(file)) {
      return;
    }

    visited.add(file);
    files.push(file);

    for (const reference of moduleReferences(file)) {
      const { specifier, kind } = reference;

      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);

        if (!resolved.startsWith(`${sourceRoot}${path.sep}`)) {
          violations.push(
            `${relative(file)}: относительный импорт вне src (${kind}): ${specifier}`,
          );
          continue;
        }

        if (FORBIDDEN_RELATIVE_MODULES.has(path.basename(resolved))) {
          violations.push(`${relative(file)}: серверный модуль в contract (${kind}): ${specifier}`);
          continue;
        }

        visit(resolved);
        continue;
      }

      externals.add(specifier);

      if (!ALLOWED_EXTERNALS.has(specifier)) {
        violations.push(`${relative(file)}: запрещённый внешний импорт (${kind}): ${specifier}`);
      }
    }
  };

  visit(contractSource);

  for (const specifier of externals) {
    for (const pattern of FORBIDDEN_MODULES) {
      if (pattern.test(specifier)) {
        violations.push(`contract: запрещённый модуль ${specifier}`);
      }
    }
  }

  expect(violations).toEqual([]);

  return { externals: [...externals].sort(), files };
}

describe("client-safe entrypoint @kanbaner/plugin-tasks/contract", () => {
  it("импортирует только SDK, TypeBox и собственные client-safe модули", () => {
    const { externals, files } = analyzeContractGraph();

    expect(externals).toEqual([...ALLOWED_EXTERNALS].sort());
    expect(files.map((file) => relative(file)).sort()).toEqual(
      [
        "src/constants.ts",
        "src/contract.ts",
        "src/events.ts",
        "src/model.ts",
        "src/resources.ts",
        "src/schemas/common.ts",
        "src/schemas/project.ts",
        "src/schemas/queries.ts",
        "src/schemas/task.ts",
        "src/search.ts",
        "src/validation.ts",
      ].sort(),
    );
    expect(files.map((file) => relative(file))).not.toContain("src/store.ts");
    expect(files.map((file) => relative(file))).not.toContain("src/operations.ts");
    expect(files.map((file) => relative(file))).not.toContain("src/index.ts");
  });

  it("публикует subpath ./contract с отдельными declarations", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      readonly exports?: Readonly<Record<string, unknown>>;
    };

    expect(manifest.exports?.["./contract"]).toEqual({
      types: "./dist/contract.d.ts",
      import: "./dist/contract.js",
    });
  });

  it("собранный contract.js не содержит серверных и Node.js-импортов", () => {
    expect(
      existsSync(contractDist),
      "Соберите пакет: pnpm --filter @kanbaner/plugin-tasks build",
    ).toBe(true);

    const references = moduleReferences(contractDist);

    for (const { specifier } of references) {
      expect(specifier.startsWith("node:")).toBe(false);
      expect(specifier).not.toMatch(/store|operations|index\.js/u);
    }
  });

  it("импортируется в runtime и не отдаёт Store, operations или activate", async () => {
    expect(
      existsSync(contractDist),
      "Соберите пакет: pnpm --filter @kanbaner/plugin-tasks build",
    ).toBe(true);

    const contract = (await import(pathToFileURL(contractDist).href)) as Record<string, unknown>;

    expect(contract.PLUGIN_ID).toBe("kanbaner.tasks");
    expect(contract.TASKS_COMMAND_IDS).toMatchObject({
      taskComplete: "kanbaner.tasks.task.complete",
    });
    expect(contract.TASKS_QUERY_IDS).toMatchObject({
      taskList: "kanbaner.tasks.task.list",
    });
    expect(contract.formatTaskRef).toBeTypeOf("function");
    expect(contract.toTaskSearchDocument).toBeTypeOf("function");
    expect(contract.validateSubtaskParent).toBeTypeOf("function");

    expect(contract.TASKS_COMMAND_LIST).toBeUndefined();
    expect(contract.TASKS_QUERY_LIST).toBeUndefined();
    expect(contract.TASKS_STORE_CONTRACT_DEFINITION).toBeUndefined();
    expect(contract.activate).toBeUndefined();
  });
});
