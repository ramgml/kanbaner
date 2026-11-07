#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PACKAGE = "@kanbaner/plugin-fixture";
const ALLOWED_FIXTURE_DEPENDENCY = "@kanbaner/plugin-sdk";

/**
 * Запрещённые внешние модули fixture-плагина.
 *
 * Проверка идёт по спецификатору импорта, а не по подстроке файла: AST
 * различает named/side-effect import, export-from, require и dynamic import.
 */
const FORBIDDEN_MODULE_PATTERNS = [
  { pattern: /^@kanbaner\/kernel(?:\/|$)/iu, label: "kernel" },
  { pattern: /^@kanbaner\/storage-sqlite(?:\/|$)/iu, label: "storage provider" },
  {
    pattern: /^@kanbaner\/plugin-(?:tasks|notes|kanban|search|task-list)(?:\/|$)/iu,
    label: "domain plugin",
  },
  {
    pattern: /^(?:better-sqlite3|node:sqlite|sqlite3|pg|mysql2?)(?:\/|$)/iu,
    label: "database driver",
  },
  { pattern: /^react(?:-dom)?(?:\/|$)/iu, label: "React" },
  { pattern: /^@sinclair\/typebox(?:\/|$)/iu, label: "TypeBox outside SDK" },
  { pattern: /(?:^|\/)apps\//iu, label: "apps" },
  { pattern: /packages\/kernel/iu, label: "kernel internals" },
];

const SQL_PATTERNS = [
  { label: "SELECT", pattern: /\bSELECT\b/iu },
  { label: "INSERT INTO", pattern: /\bINSERT\s+INTO\b/iu },
  { label: "UPDATE SET", pattern: /\bUPDATE\s+\w+\s+SET\b/iu },
  { label: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/iu },
  { label: "PRAGMA", pattern: /\bPRAGMA\b/iu },
  { label: "RETURNING", pattern: /\bRETURNING\b/iu },
  { label: "CREATE TABLE", pattern: /\bCREATE\s+TABLE\b/iu },
  { label: "ALTER TABLE", pattern: /\bALTER\s+TABLE\b/iu },
];

const SYNC_PATTERNS = [
  { label: "readFileSync", pattern: /\breadFileSync\b/u },
  { label: "writeFileSync", pattern: /\bwriteFileSync\b/u },
  { label: "statSync", pattern: /\bstatSync\b/u },
  { label: "openSync", pattern: /\bopenSync\b/u },
  { label: ".prepare(", pattern: /\.prepare\s*\(/u },
];

const SOURCE_FILE_PATTERN = /\.(?:ts|tsx|js|mjs|cjs|jsx)$/u;

function sourceFiles(directory) {
  const files = [];

  if (!existsSync(directory)) {
    return files;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)) {
      files.push(absolute);
    }
  }

  return files;
}

function relative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function isInside(parent, child) {
  const relativePath = path.relative(parent, child);

  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (file.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }

  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

function parse(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
}

/**
 * Извлекает все модульные ссылки через TypeScript AST.
 *
 * Поддерживаются: `import ... from`, side-effect `import "..."`,
 * `export ... from`, `require("...")` и динамический `import("...")`.
 */
function moduleReferences(file, source) {
  const sourceFile = parse(file, source);
  const references = [];

  const visit = (node) => {
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

/** Текстовые литералы AST: SQL ищется без учёта регистра и не в комментариях. */
function stringLiterals(file, source) {
  const sourceFile = parse(file, source);
  const values = [];

  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      values.push(node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return values;
}

function forbiddenFixtureImport(specifier) {
  for (const rule of FORBIDDEN_MODULE_PATTERNS) {
    if (rule.pattern.test(specifier)) {
      return rule.label;
    }
  }

  return null;
}

function analyzeFixtureSources(root, violations) {
  const fixtureRoot = path.join(root, "packages", "plugin-fixture");
  const sourceRoot = path.join(fixtureRoot, "src");

  if (!existsSync(fixtureRoot) || !statSync(fixtureRoot).isDirectory()) {
    violations.push({ file: relative(root, fixtureRoot), rule: "fixture package is missing" });

    return;
  }

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;

      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);

        if (!isInside(fixtureRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `относительный импорт выходит за пределы fixture (${kind}): ${specifier}`,
          });
        }

        continue;
      }

      if (specifier === ALLOWED_FIXTURE_DEPENDENCY) {
        continue;
      }

      const label = forbiddenFixtureImport(specifier);

      violations.push({
        file: fileLabel,
        rule:
          label === null
            ? `запрещённый импорт (${kind}): ${specifier}`
            : `запрещённый импорт (${kind}): ${specifier} [${label}]`,
      });
    }

    const seenSql = new Set();

    for (const literal of stringLiterals(file, source)) {
      for (const rule of SQL_PATTERNS) {
        if (rule.pattern.test(literal) && !seenSql.has(rule.label)) {
          seenSql.add(rule.label);
          violations.push({
            file: fileLabel,
            rule: `SQL statement вне миграций (${rule.label})`,
          });
        }
      }
    }

    for (const rule of SYNC_PATTERNS) {
      if (rule.pattern.test(source)) {
        violations.push({
          file: fileLabel,
          rule: `synchronous storage call: ${rule.label}`,
        });
      }
    }
  }

  return fixtureRoot;
}

function analyzeProductionSources(root, fixtureRoot, violations) {
  const productionRoots = [
    { directory: path.join(root, "packages", "kernel", "src"), label: "ядро" },
    { directory: path.join(root, "packages", "plugin-sdk", "src"), label: "SDK" },
    { directory: path.join(root, "apps", "web", "src"), label: "production apps/web" },
  ];

  for (const { directory, label } of productionRoots) {
    for (const file of sourceFiles(directory)) {
      const source = readFileSync(file, "utf8");
      const fileLabel = relative(root, file);

      for (const reference of moduleReferences(file, source)) {
        const { specifier, kind } = reference;
        const resolved = specifier.startsWith(".")
          ? path.resolve(path.dirname(file), specifier)
          : null;
        const referencesFixture =
          (resolved !== null && isInside(fixtureRoot, resolved)) ||
          specifier === FIXTURE_PACKAGE ||
          specifier.startsWith(`${FIXTURE_PACKAGE}/`);

        if (referencesFixture) {
          violations.push({
            file: fileLabel,
            rule: `${label} не должен ссылаться на fixture (${kind}): ${specifier}`,
          });
        }
      }

      // Ссылка в строке ловит случаи, которые не являются import-выражением
      // (например, путь в конфигурации), но не заменяет AST-проверку выше.
      if (source.includes(FIXTURE_PACKAGE)) {
        violations.push({
          file: fileLabel,
          rule: `${label} не должен ссылаться на fixture`,
        });
      }
    }
  }
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function analyzeManifests(root, violations) {
  const fixtureManifest = readJson(path.join(root, "packages", "plugin-fixture", "package.json"));

  if (fixtureManifest !== null) {
    for (const dependency of Object.keys(fixtureManifest.dependencies ?? {})) {
      if (dependency !== ALLOWED_FIXTURE_DEPENDENCY) {
        violations.push({
          file: "packages/plugin-fixture/package.json",
          rule: `fixture dependency ${dependency} запрещена`,
        });
      }
    }
  }

  const productionManifests = [
    { file: "packages/kernel/package.json", label: "ядро" },
    { file: "packages/plugin-sdk/package.json", label: "SDK" },
    { file: "apps/web/package.json", label: "production apps/web" },
    { file: "package.json", label: "корневой package.json" },
  ];

  for (const { file, label } of productionManifests) {
    const manifest = readJson(path.join(root, file));

    if (manifest === null) {
      continue;
    }

    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      if ((manifest[field] ?? {})[FIXTURE_PACKAGE] !== undefined) {
        violations.push({
          file,
          rule: `${label} ${field} не должен зависеть от fixture`,
        });
      }
    }
  }
}

/**
 * Анализирует дерево репозитория и возвращает нарушения границ.
 *
 * `root` параметризован для self-test: проверки не привязаны к абсолютному
 * пути текущего checkout-а.
 */
export function analyzeImportBoundaries(root = ROOT) {
  const violations = [];

  const fixtureRoot = analyzeFixtureSources(root, violations);

  if (fixtureRoot !== undefined) {
    analyzeProductionSources(root, fixtureRoot, violations);
  }

  analyzeManifests(root, violations);

  return violations;
}

function writeFile(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function assertViolation(violations, fileSuffix, ruleFragment) {
  const found = violations.some(
    (violation) => violation.file.endsWith(fileSuffix) && violation.rule.includes(ruleFragment),
  );

  if (!found) {
    throw new Error(`Self-test не нашёл правило «${ruleFragment}» для ${fileSuffix}`);
  }
}

function assertNoViolation(violations, fileSuffix) {
  const found = violations.filter((violation) => violation.file.endsWith(fileSuffix));

  if (found.length > 0) {
    throw new Error(
      `Self-test нашёл ложное нарушение для ${fileSuffix}: ${found
        .map((violation) => violation.rule)
        .join("; ")}`,
    );
  }
}

function runSelfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "kanbaner-import-boundaries-"));
  const fixtureRoot = path.join(root, "packages", "plugin-fixture");

  try {
    writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ dependencies: { [ALLOWED_FIXTURE_DEPENDENCY]: "workspace:*" } }),
    );
    writeFile(
      path.join(root, "packages", "kernel", "package.json"),
      JSON.stringify({ dependencies: {} }),
    );
    writeFile(
      path.join(root, "packages", "plugin-sdk", "package.json"),
      JSON.stringify({ dependencies: {} }),
    );
    writeFile(path.join(root, "apps", "web", "package.json"), JSON.stringify({ dependencies: {} }));

    // 1. Относительный импорт из fixture выходит в kernel.
    writeFile(
      path.join(fixtureRoot, "src", "relative-kernel.ts"),
      'import { describeKernel } from "../../kernel/src/index.ts";\n',
    );

    // 2. Side-effect import запрещённого пакета.
    writeFile(
      path.join(fixtureRoot, "src", "side-effect.ts"),
      'import "@kanbaner/kernel/register";\n',
    );

    // 3. SQL в нижнем регистре внутри строкового литерала.
    writeFile(
      path.join(fixtureRoot, "src", "lowercase-sql.ts"),
      'export const statement = "select * from plugin_items";\n',
    );

    // 4. export/require/dynamic import распознаются AST.
    writeFile(
      path.join(fixtureRoot, "src", "module-syntaxes.ts"),
      [
        'export * from "@kanbaner/kernel";',
        'const viaRequire = require("@kanbaner/kernel");',
        'const viaDynamic = import("@kanbaner/kernel");',
        "export const keep = [viaRequire, viaDynamic];",
        "",
      ].join("\n"),
    );

    // 5. production-код не должен относительно ссылаться на fixture.
    writeFile(
      path.join(root, "packages", "kernel", "src", "leak.ts"),
      'import "../../plugin-fixture/src/index.ts";\n',
    );

    // 6. Разрешённый SDK и локальный относительный импорт не считаются ошибкой.
    writeFile(path.join(fixtureRoot, "src", "good-dep.ts"), "export const value = 1;\n");
    writeFile(
      path.join(fixtureRoot, "src", "good.ts"),
      [
        'import { value } from "./good-dep.ts";',
        'import type { PluginId } from "@kanbaner/plugin-sdk";',
        "export const plugin: PluginId = `kanbaner.fixture`;",
        "export const kept = value;",
        "",
      ].join("\n"),
    );

    const violations = analyzeImportBoundaries(root);

    assertViolation(
      violations,
      "relative-kernel.ts",
      "относительный импорт выходит за пределы fixture",
    );
    assertViolation(
      violations,
      "side-effect.ts",
      "запрещённый импорт (import): @kanbaner/kernel/register",
    );
    assertViolation(violations, "lowercase-sql.ts", "SQL statement вне миграций (SELECT)");
    assertViolation(violations, "module-syntaxes.ts", "запрещённый импорт (export)");
    assertViolation(violations, "module-syntaxes.ts", "запрещённый импорт (require)");
    assertViolation(violations, "module-syntaxes.ts", "запрещённый импорт (dynamic import)");
    assertViolation(
      violations,
      "packages/kernel/src/leak.ts",
      "ядро не должен ссылаться на fixture",
    );
    assertNoViolation(violations, "good.ts");

    console.log(
      `Import boundary self-test: ${String(violations.length)} violation(s) в ${String(
        new Set(violations.map((violation) => violation.file)).size,
      )} файле(ах); правила relative/side-effect/SQL/production проверены.`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  const violations = analyzeImportBoundaries();

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.rule}`);
    }

    process.exitCode = 1;
  } else {
    console.log("Import boundaries: plugin-fixture использует только @kanbaner/plugin-sdk.");
    console.log("Import boundaries: kernel/plugin-sdk/apps не зависят от fixture.");
  }
}
