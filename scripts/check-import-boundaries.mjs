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
const TASKS_PACKAGE = "@kanbaner/plugin-tasks";
const TASKS_CONTRACT_ENTRYPOINT = "contract.ts";
const ALLOWED_TASKS_DEPENDENCIES = new Set(["@kanbaner/plugin-sdk", "@sinclair/typebox"]);
const SERVER_ONLY_TASKS_BUILTINS = new Set(["node:crypto"]);
const TESTING_TASKS_BUILTINS = new Set(["node:assert/strict"]);

const TASK_UI_PACKAGE = "@kanbaner/task-ui";
const MARKDOWN_UI_PACKAGE = "@kanbaner/markdown-ui";
const PROJECTS_PACKAGE = "@kanbaner/plugin-projects";
const PROJECTS_UI_ENTRYPOINT = "@kanbaner/plugin-projects/ui";
const NOTES_PACKAGE = "@kanbaner/plugin-notes";
const NOTES_UI_ENTRYPOINT = "@kanbaner/plugin-notes/ui";
const SEARCH_PACKAGE = "@kanbaner/plugin-search";
const SEARCH_UI_ENTRYPOINT = "@kanbaner/plugin-search/ui";
const BUILTIN_UI_COMPOSITION = "apps/web/src/ui/builtin-ui-plugins.ts";
const ALLOWED_TASK_UI_DEPENDENCIES = new Set([
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@kanbaner/plugin-sdk",
  "@kanbaner/plugin-tasks/contract",
]);
const ALLOWED_PROJECTS_DEPENDENCIES = new Set([
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@kanbaner/plugin-sdk",
  "@kanbaner/plugin-tasks/contract",
  "lucide-react",
  "react-markdown",
  "remark-gfm",
  MARKDOWN_UI_PACKAGE,
  TASK_UI_PACKAGE,
]);
const PROJECTS_SERVER_ENTRYPOINT = "index.ts";
const PROJECTS_UI_ENTRYPOINT_FILE = "ui.tsx";
const ALLOWED_MARKDOWN_UI_DEPENDENCIES = new Set([
  "react",
  "react/jsx-runtime",
  "react-markdown",
  "remark-gfm",
]);
const ALLOWED_NOTES_DEPENDENCIES = new Set([
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@kanbaner/plugin-sdk",
  "@sinclair/typebox",
  "lucide-react",
  "mdast-util-from-markdown",
  "mdast-util-gfm",
  "micromark-extension-gfm",
  "@blocknote/core",
  "@blocknote/react",
  "@blocknote/shadcn",
  MARKDOWN_UI_PACKAGE,
]);
const NOTES_SERVER_ENTRYPOINT = "index.ts";
const NOTES_CONTRACT_ENTRYPOINT = "contract.ts";
const NOTES_UI_ENTRYPOINT_FILE = "ui.tsx";
const NOTES_UI_PACKAGE_PREFIXES = ["@blocknote/core", "@blocknote/react", "@blocknote/shadcn"];
const ALLOWED_SEARCH_DEPENDENCIES = new Set([
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@kanbaner/plugin-sdk",
  "@sinclair/typebox",
  "lucide-react",
]);
const SEARCH_SERVER_ENTRYPOINT = "index.ts";
const SEARCH_CONTRACT_ENTRYPOINT = "contract.ts";
const SEARCH_UI_ENTRYPOINT_FILE = "ui.tsx";
const ALLOWED_CLI_DEPENDENCIES = new Set([
  "node:fs/promises",
  "node:util",
  "@kanbaner/plugin-sdk",
  "@kanbaner/plugin-tasks/contract",
  "@kanbaner/plugin-notes/contract",
]);

function isNotesUiSpecifier(specifier) {
  return NOTES_UI_PACKAGE_PREFIXES.some(
    (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
  );
}

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
    pattern: /^@kanbaner\/plugin-(?:tasks|notes|projects|search)(?:\/|$)/iu,
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

/**
 * Запрещённые внешние модули plugin-tasks.
 *
 * Плагин может импортировать только публичный SDK, TypeBox для схем и
 * собственные файлы. `node:crypto` разрешён только серверному графу
 * (activation/idempotency), но не client-safe contract entrypoint.
 */
const FORBIDDEN_TASKS_MODULE_PATTERNS = [
  { pattern: /^@kanbaner\/kernel(?:\/|$)/iu, label: "kernel" },
  { pattern: /^@kanbaner\/storage-sqlite(?:\/|$)/iu, label: "storage provider" },
  {
    pattern: /^@kanbaner\/plugin-(?:fixture|notes|projects|search)(?:\/|$)/iu,
    label: "другой плагин",
  },
  {
    pattern: /^(?:better-sqlite3|node:sqlite|sqlite3|pg|mysql2?)(?:\/|$)/iu,
    label: "database driver",
  },
  { pattern: /^react(?:-dom)?(?:\/|$)/iu, label: "React" },
  { pattern: /(?:^|\/)apps\//iu, label: "apps" },
  { pattern: /packages\/kernel/iu, label: "kernel internals" },
];

/** Файлы, недостижимые из client-safe contract entrypoint. */
const TASKS_SERVER_ONLY_FILES = new Set(["store.ts", "operations.ts", "index.ts", "activation.ts"]);

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

function resolveRelativeModule(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return base;
}

/**
 * Строит граф client-safe entrypoint `contract.ts`.
 *
 * В граф попадают только относительные импорты; внешние модули проверяются
 * отдельно по каждому файлу.
 */
function tasksContractGraph(sourceRoot) {
  const entrypoint = path.join(sourceRoot, TASKS_CONTRACT_ENTRYPOINT);
  const graph = new Set();

  const visit = (file) => {
    if (graph.has(file) || !existsSync(file)) {
      return;
    }

    graph.add(file);

    for (const reference of moduleReferences(file, readFileSync(file, "utf8"))) {
      if (reference.specifier.startsWith(".")) {
        visit(resolveRelativeModule(file, reference.specifier));
      }
    }
  };

  visit(entrypoint);

  return graph;
}

/** Строит граф относительных импортов от указанного entrypoint. */
function entryGraph(sourceRoot, entrypointName) {
  const entrypoint = path.join(sourceRoot, entrypointName);
  const graph = new Set();

  const visit = (file) => {
    if (graph.has(file) || !existsSync(file)) {
      return;
    }

    graph.add(file);

    for (const reference of moduleReferences(file, readFileSync(file, "utf8"))) {
      if (reference.specifier.startsWith(".")) {
        visit(resolveRelativeModule(file, reference.specifier));
      }
    }
  };

  visit(entrypoint);

  return graph;
}

function forbiddenPluginUiImport(specifier) {
  if (specifier === TASKS_PACKAGE) {
    return "корневой @kanbaner/plugin-tasks запрещён, используйте /contract";
  }

  if (
    specifier.startsWith(`${TASKS_PACKAGE}/`) &&
    !specifier.startsWith(`${TASKS_PACKAGE}/contract`)
  ) {
    return `разрешён только @kanbaner/plugin-tasks/contract: ${specifier}`;
  }

  const rules = [
    { pattern: /^@kanbaner\/kernel(?:\/|$)/iu, label: "kernel" },
    { pattern: /^@kanbaner\/storage-sqlite(?:\/|$)/iu, label: "storage provider" },
    {
      pattern: /^@kanbaner\/plugin-(?:fixture|notes|projects|search)(?:\/|$)/iu,
      label: "другой плагин",
    },
    {
      pattern: /^(?:better-sqlite3|node:sqlite|sqlite3|pg|mysql2?)(?:\/|$)/iu,
      label: "database driver",
    },
    { pattern: /(?:^|\/)apps\//iu, label: "apps internals" },
    { pattern: /packages\/kernel/iu, label: "kernel internals" },
    { pattern: /^node:/iu, label: "node builtin" },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(specifier)) {
      return rule.label;
    }
  }

  return null;
}

function analyzeTaskUiSources(root, violations) {
  const packageRoot = path.join(root, "packages", "task-ui");
  const sourceRoot = path.join(packageRoot, "src");

  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
    violations.push({ file: relative(root, packageRoot), rule: "task-ui package is missing" });

    return;
  }

  const files = sourceFiles(sourceRoot).filter((file) => !/\.test\.tsx?$/u.test(file));

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;

      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(file, specifier);

        if (!isInside(packageRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `относительный импорт выходит за пределы task-ui (${kind}): ${specifier}`,
          });
        }

        continue;
      }

      const forbidden = forbiddenPluginUiImport(specifier) ?? null;

      if (forbidden !== null) {
        violations.push({
          file: fileLabel,
          rule: `запрещённый импорт (${kind}): ${specifier} [${forbidden}]`,
        });

        continue;
      }

      if (!ALLOWED_TASK_UI_DEPENDENCIES.has(specifier)) {
        violations.push({
          file: fileLabel,
          rule: `task-ui не должен импортировать (${kind}): ${specifier}`,
        });
      }
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
  }
}

function analyzeProjectsSources(root, violations) {
  const packageRoot = path.join(root, "packages", "plugin-projects");
  const sourceRoot = path.join(packageRoot, "src");

  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
    violations.push({
      file: relative(root, packageRoot),
      rule: "plugin-projects package is missing",
    });

    return;
  }

  const serverGraph = entryGraph(sourceRoot, PROJECTS_SERVER_ENTRYPOINT);
  const uiGraph = entryGraph(sourceRoot, PROJECTS_UI_ENTRYPOINT_FILE);
  const files = sourceFiles(sourceRoot).filter((file) => !/\.test\.tsx?$/u.test(file));

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);
    const relativeFile = path.relative(sourceRoot, file).replaceAll(path.sep, "/");
    const inServer = serverGraph.has(file);
    const inUi = uiGraph.has(file);

    if (inUi && relativeFile === PROJECTS_SERVER_ENTRYPOINT) {
      violations.push({
        file: relative(root, path.join(sourceRoot, PROJECTS_UI_ENTRYPOINT_FILE)),
        rule: `UI entrypoint не должен достигать server entrypoint: ${relativeFile}`,
      });
    }

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;

      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(file, specifier);

        if (!isInside(packageRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `относительный импорт выходит за пределы plugin-projects (${kind}): ${specifier}`,
          });
        }

        continue;
      }

      const forbidden = forbiddenPluginUiImport(specifier) ?? null;

      if (forbidden !== null) {
        violations.push({
          file: fileLabel,
          rule: `запрещённый импорт (${kind}): ${specifier} [${forbidden}]`,
        });

        continue;
      }

      if (
        inServer &&
        (specifier === "react" ||
          specifier === "react-dom" ||
          specifier.startsWith("react/") ||
          specifier === TASK_UI_PACKAGE ||
          specifier === PROJECTS_UI_ENTRYPOINT ||
          specifier === `${PROJECTS_PACKAGE}/ui`)
      ) {
        violations.push({
          file: fileLabel,
          rule: `server graph не должен импортировать React/client (${kind}): ${specifier}`,
        });

        continue;
      }

      if (!ALLOWED_PROJECTS_DEPENDENCIES.has(specifier)) {
        violations.push({
          file: fileLabel,
          rule: `plugin-projects не должен импортировать (${kind}): ${specifier}`,
        });
      }
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
}

function analyzeMarkdownUiSources(root, violations) {
  const packageRoot = path.join(root, "packages", "markdown-ui");
  const sourceRoot = path.join(packageRoot, "src");

  for (const file of sourceFiles(sourceRoot).filter((file) => !/\.test\.tsx?$/u.test(file))) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(file, specifier);
        if (!isInside(packageRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `markdown-ui relative import escapes package (${kind})`,
          });
        }
        continue;
      }
      if (!ALLOWED_MARKDOWN_UI_DEPENDENCIES.has(specifier)) {
        violations.push({
          file: fileLabel,
          rule: `markdown-ui не должен импортировать (${kind}): ${specifier}`,
        });
      }
    }
  }
}

function analyzeCliSources(root, violations) {
  const packageRoot = path.join(root, "packages", "cli");
  const sourceRoot = path.join(packageRoot, "src");

  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    return;
  }

  for (const file of sourceFiles(sourceRoot).filter((file) => !/\.test\.tsx?$/u.test(file))) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;

      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(file, specifier);

        if (!isInside(packageRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `относительный импорт выходит за пределы cli (${kind}): ${specifier}`,
          });
        }

        continue;
      }

      if (!ALLOWED_CLI_DEPENDENCIES.has(specifier)) {
        violations.push({
          file: fileLabel,
          rule: `cli должен использовать только HTTP client и public contract (${kind}): ${specifier}`,
        });
      }
    }
  }
}

function analyzeNotesSources(root, violations) {
  const packageRoot = path.join(root, "packages", "plugin-notes");
  const sourceRoot = path.join(packageRoot, "src");
  const serverGraph = entryGraph(sourceRoot, NOTES_SERVER_ENTRYPOINT);
  const contractGraph = entryGraph(sourceRoot, NOTES_CONTRACT_ENTRYPOINT);
  const uiGraph = entryGraph(sourceRoot, NOTES_UI_ENTRYPOINT_FILE);
  const serverOnly = new Set([
    NOTES_SERVER_ENTRYPOINT,
    "activation.ts",
    "store.ts",
    "operations.ts",
  ]);

  for (const file of sourceFiles(sourceRoot).filter((file) => !/\.test\.tsx?$/u.test(file))) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);
    const relativeFile = path.relative(sourceRoot, file).replaceAll(path.sep, "/");
    const inServer = serverGraph.has(file);
    const inContract = contractGraph.has(file);
    const inUi = uiGraph.has(file);

    if (inContract && serverOnly.has(relativeFile)) {
      violations.push({
        file: fileLabel,
        rule: "client-safe contract не должен достигать server modules",
      });
    }
    if (inUi && relativeFile === NOTES_SERVER_ENTRYPOINT) {
      violations.push({
        file: fileLabel,
        rule: "notes UI entrypoint не должен достигать server entrypoint",
      });
    }

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(file, specifier);
        if (!isInside(packageRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `notes relative import escapes package (${kind})`,
          });
        }
        continue;
      }

      if (specifier.startsWith("node:")) {
        const allowedCrypto =
          specifier === "node:crypto" &&
          inServer &&
          !inContract &&
          relativeFile.startsWith("activation/");
        if (!allowedCrypto) {
          violations.push({
            file: fileLabel,
            rule: `notes builtin import запрещён (${kind}): ${specifier}`,
          });
        }
        continue;
      }

      const forbidden = forbiddenPluginUiImport(specifier);
      if (forbidden !== null) {
        violations.push({
          file: fileLabel,
          rule: `notes запрещённый импорт (${kind}): ${specifier} [${forbidden}]`,
        });
        continue;
      }

      if (
        inServer &&
        (specifier === "react" ||
          specifier === "react-dom" ||
          specifier.startsWith("react/") ||
          specifier === MARKDOWN_UI_PACKAGE ||
          isNotesUiSpecifier(specifier))
      ) {
        violations.push({
          file: fileLabel,
          rule: `notes server graph не должен импортировать UI (${kind}): ${specifier}`,
        });
        continue;
      }

      if (!ALLOWED_NOTES_DEPENDENCIES.has(specifier) && !isNotesUiSpecifier(specifier)) {
        violations.push({
          file: fileLabel,
          rule: `notes не должен импортировать (${kind}): ${specifier}`,
        });
      }
    }

    for (const rule of SYNC_PATTERNS) {
      if (rule.pattern.test(source)) {
        violations.push({ file: fileLabel, rule: `synchronous storage call: ${rule.label}` });
      }
    }
  }
}

function analyzeSearchSources(root, violations) {
  const packageRoot = path.join(root, "packages", "plugin-search");
  const sourceRoot = path.join(packageRoot, "src");

  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
    violations.push({
      file: relative(root, packageRoot),
      rule: "plugin-search package is missing",
    });

    return;
  }

  const serverGraph = entryGraph(sourceRoot, SEARCH_SERVER_ENTRYPOINT);
  const contractGraph = entryGraph(sourceRoot, SEARCH_CONTRACT_ENTRYPOINT);
  const uiGraph = entryGraph(sourceRoot, SEARCH_UI_ENTRYPOINT_FILE);
  const serverOnly = new Set([SEARCH_SERVER_ENTRYPOINT, "activation.ts", "operations.ts"]);

  for (const file of sourceFiles(sourceRoot).filter((file) => !/\.test\.tsx?$/u.test(file))) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);
    const relativeFile = path.relative(sourceRoot, file).replaceAll(path.sep, "/");
    const inServer = serverGraph.has(file);
    const inContract = contractGraph.has(file);
    const inUi = uiGraph.has(file);

    if (inContract && serverOnly.has(relativeFile)) {
      violations.push({
        file: fileLabel,
        rule: "search client-safe contract не должен достигать server modules",
      });
    }

    if (inUi && serverOnly.has(relativeFile)) {
      violations.push({
        file: fileLabel,
        rule: "search UI entrypoint не должен достигать server entrypoint",
      });
    }

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;

      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(file, specifier);

        if (!isInside(packageRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `search relative import escapes package (${kind})`,
          });
        }

        continue;
      }

      if (specifier.startsWith("node:")) {
        violations.push({
          file: fileLabel,
          rule: `search builtin import запрещён (${kind}): ${specifier}`,
        });
        continue;
      }

      const forbidden = forbiddenPluginUiImport(specifier);

      if (forbidden !== null) {
        violations.push({
          file: fileLabel,
          rule: `search запрещённый импорт (${kind}): ${specifier} [${forbidden}]`,
        });
        continue;
      }

      if (
        inServer &&
        (specifier === "react" ||
          specifier === "react-dom" ||
          specifier.startsWith("react/") ||
          specifier === "lucide-react")
      ) {
        violations.push({
          file: fileLabel,
          rule: `search server graph не должен импортировать UI (${kind}): ${specifier}`,
        });
        continue;
      }

      if (!ALLOWED_SEARCH_DEPENDENCIES.has(specifier)) {
        violations.push({
          file: fileLabel,
          rule: `search не должен импортировать (${kind}): ${specifier}`,
        });
      }
    }

    for (const rule of SYNC_PATTERNS) {
      if (rule.pattern.test(source)) {
        violations.push({ file: fileLabel, rule: `synchronous storage call: ${rule.label}` });
      }
    }
  }
}

function isTasksServerOnlyRelative(relativeFile) {
  return (
    TASKS_SERVER_ONLY_FILES.has(relativeFile) ||
    relativeFile === "testing.ts" ||
    relativeFile.startsWith("activation/") ||
    relativeFile.startsWith("store/")
  );
}

function analyzePluginTasksSources(root, violations) {
  const packageRoot = path.join(root, "packages", "plugin-tasks");
  const sourceRoot = path.join(packageRoot, "src");

  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
    violations.push({ file: relative(root, packageRoot), rule: "plugin-tasks package is missing" });

    return;
  }

  const contractGraph = tasksContractGraph(sourceRoot);
  const files = sourceFiles(sourceRoot).filter((file) => !file.endsWith(".test.ts"));

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(root, file);
    const relativeFile = path.relative(sourceRoot, file).replaceAll(path.sep, "/");
    const inContract = contractGraph.has(file);

    if (inContract && isTasksServerOnlyRelative(relativeFile)) {
      violations.push({
        file: fileLabel,
        rule: `client-safe contract не должен достигать server-модуля: ${relativeFile}`,
      });
    }

    for (const reference of moduleReferences(file, source)) {
      const { specifier, kind } = reference;

      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeModule(file, specifier);

        if (!isInside(packageRoot, resolved)) {
          violations.push({
            file: fileLabel,
            rule: `относительный импорт выходит за пределы plugin-tasks (${kind}): ${specifier}`,
          });
        }

        continue;
      }

      const forbidden = FORBIDDEN_TASKS_MODULE_PATTERNS.find((rule) =>
        rule.pattern.test(specifier),
      );

      if (forbidden !== undefined) {
        violations.push({
          file: fileLabel,
          rule: `запрещённый импорт (${kind}): ${specifier} [${forbidden.label}]`,
        });

        continue;
      }

      if (ALLOWED_TASKS_DEPENDENCIES.has(specifier)) {
        continue;
      }

      if (SERVER_ONLY_TASKS_BUILTINS.has(specifier)) {
        if (inContract) {
          violations.push({
            file: fileLabel,
            rule: `client-safe contract не должен импортировать ${specifier} (${kind})`,
          });
        }

        continue;
      }

      // Тестовый entrypoint — не server-граф; ему разрешён только явный
      // node:assert/strict. Любой другой node builtin запрещён везде.
      if (relativeFile === "testing.ts" && TESTING_TASKS_BUILTINS.has(specifier)) {
        continue;
      }

      if (specifier.startsWith("node:")) {
        violations.push({
          file: fileLabel,
          rule: `запрещённый node builtin вне whitelist (${kind}): ${specifier}`,
        });

        continue;
      }

      violations.push({
        file: fileLabel,
        rule: `запрещённый импорт (${kind}): ${specifier}`,
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
      const isBuiltinComposition = fileLabel === BUILTIN_UI_COMPOSITION;

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

        const isProjectsUiEntrypoint =
          specifier === PROJECTS_UI_ENTRYPOINT ||
          specifier === `${PROJECTS_PACKAGE}/ui` ||
          specifier.startsWith(`${PROJECTS_PACKAGE}/ui/`) ||
          (resolved !== null &&
            isInside(path.join(root, "packages", "plugin-projects", "src"), resolved) &&
            /(?:^|\/)ui(?:\.tsx?|\/)/u.test(
              relative(path.join(root, "packages", "plugin-projects", "src"), resolved),
            ));

        if (isProjectsUiEntrypoint && !isBuiltinComposition) {
          violations.push({
            file: fileLabel,
            rule: `UI-entrypoint плагина разрешён только из ${BUILTIN_UI_COMPOSITION} (${kind}): ${specifier}`,
          });
        }

        if (
          (specifier === PROJECTS_PACKAGE || specifier.startsWith(`${PROJECTS_PACKAGE}/`)) &&
          specifier !== PROJECTS_UI_ENTRYPOINT &&
          specifier !== `${PROJECTS_PACKAGE}/ui`
        ) {
          violations.push({
            file: fileLabel,
            rule: `apps/shell не должен импортировать серверный entrypoint плагина (${kind}): ${specifier}`,
          });
        }

        const isNotesUiEntrypoint =
          specifier === NOTES_UI_ENTRYPOINT ||
          specifier === `${NOTES_PACKAGE}/ui` ||
          specifier.startsWith(`${NOTES_PACKAGE}/ui/`) ||
          (resolved !== null &&
            isInside(path.join(root, "packages", "plugin-notes", "src"), resolved) &&
            /(?:^|\/)ui(?:\.tsx?|\/)/u.test(
              relative(path.join(root, "packages", "plugin-notes", "src"), resolved),
            ));

        if (isNotesUiEntrypoint && !isBuiltinComposition) {
          violations.push({
            file: fileLabel,
            rule: `UI-entrypoint плагина разрешён только из ${BUILTIN_UI_COMPOSITION} (${kind}): ${specifier}`,
          });
        }

        if (
          (specifier === NOTES_PACKAGE || specifier.startsWith(`${NOTES_PACKAGE}/`)) &&
          specifier !== NOTES_UI_ENTRYPOINT &&
          specifier !== `${NOTES_PACKAGE}/ui`
        ) {
          violations.push({
            file: fileLabel,
            rule: `apps/shell не должен импортировать серверный entrypoint плагина (${kind}): ${specifier}`,
          });
        }

        const isSearchUiEntrypoint =
          specifier === SEARCH_UI_ENTRYPOINT ||
          specifier === `${SEARCH_PACKAGE}/ui` ||
          specifier.startsWith(`${SEARCH_PACKAGE}/ui/`) ||
          (resolved !== null &&
            isInside(path.join(root, "packages", "plugin-search", "src"), resolved) &&
            /(?:^|\/)ui(?:\.tsx?|\/)/u.test(
              relative(path.join(root, "packages", "plugin-search", "src"), resolved),
            ));

        if (isSearchUiEntrypoint && !isBuiltinComposition) {
          violations.push({
            file: fileLabel,
            rule: `UI-entrypoint плагина разрешён только из ${BUILTIN_UI_COMPOSITION} (${kind}): ${specifier}`,
          });
        }

        if (
          (specifier === SEARCH_PACKAGE || specifier.startsWith(`${SEARCH_PACKAGE}/`)) &&
          specifier !== SEARCH_UI_ENTRYPOINT &&
          specifier !== `${SEARCH_PACKAGE}/ui`
        ) {
          violations.push({
            file: fileLabel,
            rule: `apps/shell не должен импортировать серверный entrypoint плагина (${kind}): ${specifier}`,
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

  const packageDependencyRules = [
    {
      file: "packages/markdown-ui/package.json",
      name: MARKDOWN_UI_PACKAGE,
      allowed: new Set(["react-markdown", "remark-gfm"]),
    },
    {
      file: "packages/plugin-notes/package.json",
      name: NOTES_PACKAGE,
      allowed: new Set([
        ALLOWED_FIXTURE_DEPENDENCY,
        "@sinclair/typebox",
        "lucide-react",
        "mdast-util-from-markdown",
        "mdast-util-gfm",
        "micromark-extension-gfm",
        "@blocknote/core",
        "@blocknote/react",
        "@blocknote/shadcn",
        MARKDOWN_UI_PACKAGE,
      ]),
    },
    {
      file: "packages/plugin-search/package.json",
      name: SEARCH_PACKAGE,
      allowed: new Set([ALLOWED_FIXTURE_DEPENDENCY, "@sinclair/typebox", "lucide-react"]),
    },
    {
      file: "packages/task-ui/package.json",
      name: TASK_UI_PACKAGE,
      allowed: new Set([TASKS_PACKAGE, ALLOWED_FIXTURE_DEPENDENCY]),
    },
    {
      file: "packages/plugin-projects/package.json",
      name: PROJECTS_PACKAGE,
      allowed: new Set([
        TASKS_PACKAGE,
        ALLOWED_FIXTURE_DEPENDENCY,
        TASK_UI_PACKAGE,
        "lucide-react",
        "react-markdown",
        "remark-gfm",
        MARKDOWN_UI_PACKAGE,
      ]),
    },
  ];

  for (const rule of packageDependencyRules) {
    const manifest = readJson(path.join(root, rule.file));

    if (manifest === null) {
      continue;
    }

    if (manifest.name !== rule.name) {
      violations.push({
        file: rule.file,
        rule: `package name должен быть ${rule.name}`,
      });
    }

    for (const field of ["dependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        const allowedDependency =
          rule.allowed.has(dependency) ||
          (field === "peerDependencies" && (dependency === "react" || dependency === "react-dom"));

        if (!allowedDependency) {
          violations.push({
            file: rule.file,
            rule: `${rule.name} ${field} содержит запрещённую зависимость ${dependency}`,
          });
        }
      }
    }
  }

  const tasksManifest = readJson(path.join(root, "packages", "plugin-tasks", "package.json"));

  if (tasksManifest !== null) {
    if (tasksManifest.name !== TASKS_PACKAGE) {
      violations.push({
        file: "packages/plugin-tasks/package.json",
        rule: `plugin-tasks package name должен быть ${TASKS_PACKAGE}`,
      });
    }

    for (const field of ["dependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(tasksManifest[field] ?? {})) {
        if (!ALLOWED_TASKS_DEPENDENCIES.has(dependency)) {
          violations.push({
            file: "packages/plugin-tasks/package.json",
            rule: `plugin-tasks ${field} содержит запрещённую зависимость ${dependency}`,
          });
        }
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

  analyzePluginTasksSources(root, violations);

  analyzeTaskUiSources(root, violations);

  analyzeProjectsSources(root, violations);

  analyzeMarkdownUiSources(root, violations);

  analyzeNotesSources(root, violations);

  analyzeSearchSources(root, violations);

  analyzeCliSources(root, violations);

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
  const tasksRoot = path.join(root, "packages", "plugin-tasks");
  const taskUiRoot = path.join(root, "packages", "task-ui");
  const projectsRoot = path.join(root, "packages", "plugin-projects");
  const cliRoot = path.join(root, "packages", "cli");

  try {
    writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ dependencies: { [ALLOWED_FIXTURE_DEPENDENCY]: "workspace:*" } }),
    );
    writeFile(
      path.join(tasksRoot, "package.json"),
      JSON.stringify({
        name: "@kanbaner/plugin-tasks",
        dependencies: {
          "@kanbaner/plugin-sdk": "workspace:*",
          "@sinclair/typebox": "0.34.52",
        },
      }),
    );
    writeFile(
      path.join(taskUiRoot, "package.json"),
      JSON.stringify({
        name: TASK_UI_PACKAGE,
        dependencies: {
          "@kanbaner/plugin-sdk": "workspace:*",
          "@kanbaner/plugin-tasks": "workspace:*",
        },
        peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      }),
    );
    writeFile(
      path.join(projectsRoot, "package.json"),
      JSON.stringify({
        name: PROJECTS_PACKAGE,
        dependencies: {
          "@kanbaner/plugin-sdk": "workspace:*",
          "@kanbaner/plugin-tasks": "workspace:*",
          "@kanbaner/task-ui": "workspace:*",
        },
        peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      }),
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

    // 7. plugin-tasks: server-модуль может использовать node:crypto.
    writeFile(
      path.join(tasksRoot, "src", "activation.ts"),
      [
        'import { createHash } from "node:crypto";',
        'import { constant } from "./good-dep.ts";',
        "export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');",
        "export const kept = constant;",
        "",
      ].join("\n"),
    );
    writeFile(path.join(tasksRoot, "src", "good-dep.ts"), "export const constant = 1;\n");
    writeFile(
      path.join(tasksRoot, "src", "contract.ts"),
      [
        'import { Type } from "@sinclair/typebox";',
        'import { constant } from "./good-dep.ts";',
        'import { serverValue } from "./store.ts";',
        'import { builtinValue } from "./contract-node.ts";',
        "export const schema = Type.String();",
        "export const values = [constant, serverValue, builtinValue];",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(tasksRoot, "src", "store.ts"),
      'import type { PluginId } from "@kanbaner/plugin-sdk";\nexport const serverValue: PluginId = `kanbaner.tasks`;\n',
    );
    writeFile(
      path.join(tasksRoot, "src", "contract-node.ts"),
      'import { createHash } from "node:crypto";\nexport const builtinValue = createHash("sha256");\n',
    );
    writeFile(
      path.join(tasksRoot, "src", "kernel-import.ts"),
      'import { describeKernel } from "@kanbaner/kernel";\nexport const value = describeKernel;\n',
    );
    writeFile(
      path.join(tasksRoot, "src", "other-plugin.ts"),
      'import { activate } from "@kanbaner/plugin-fixture";\nexport const value = activate;\n',
    );
    writeFile(
      path.join(tasksRoot, "src", "sql.ts"),
      'export const statement = "select * from tasks";\n',
    );
    writeFile(
      path.join(tasksRoot, "src", "fs-import.ts"),
      'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
    );

    // 8. task-ui: только client-safe contract, без root tasks и apps.
    writeFile(
      path.join(taskUiRoot, "src", "bad.ts"),
      'import { PLUGIN_ID } from "@kanbaner/plugin-tasks";\nexport const pluginId = PLUGIN_ID;\n',
    );
    writeFile(
      path.join(taskUiRoot, "src", "apps-import.ts"),
      'import { createUiContributionRegistry } from "../../../apps/web/src/ui/registry.ts";\nexport const registry = createUiContributionRegistry;\n',
    );
    writeFile(
      path.join(taskUiRoot, "src", "good.ts"),
      'import type { Task } from "@kanbaner/plugin-tasks/contract";\nexport type Kept = Task;\n',
    );

    // 9. plugin-projects: server graph без React/client, UI без server entrypoint.
    writeFile(
      path.join(projectsRoot, "src", "index.ts"),
      'import React from "react";\nimport { register } from "./metadata.ts";\nimport { table } from "./server-mix.ts";\nexport const activate = () => [React, register, table];\n',
    );
    writeFile(
      path.join(projectsRoot, "src", "metadata.ts"),
      'import type { UiContribution } from "@kanbaner/plugin-sdk";\nimport type { Task } from "@kanbaner/plugin-tasks/contract";\nexport const contributions: UiContribution[] = [];\nexport type Kept = Task;\n',
    );
    writeFile(
      path.join(projectsRoot, "src", "ui.tsx"),
      [
        'import React from "react";',
        'import { activate } from "./index.ts";',
        'import { PLUGIN_ID } from "@kanbaner/plugin-tasks";',
        "export const value = [React, activate, PLUGIN_ID];",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(projectsRoot, "src", "server-mix.ts"),
      'import { TaskTable } from "@kanbaner/task-ui";\nexport const table = TaskTable;\n',
    );

    // 10. shell может импортировать UI-entrypoint только из composition-модуля.
    writeFile(
      path.join(root, "apps", "web", "src", "ui", "shell.tsx"),
      'import { projectsUiPlugin } from "@kanbaner/plugin-projects/ui";\nexport const plugin = projectsUiPlugin;\n',
    );
    writeFile(
      path.join(root, "apps", "web", "src", "ui", "shell-kanban.tsx"),
      'import { projectsUiPlugin } from "@kanbaner/plugin-projects/ui";\nexport const plugin = projectsUiPlugin;\n',
    );
    writeFile(
      path.join(root, "apps", "web", "src", "ui", "builtin-ui-plugins.ts"),
      'import { projectsUiPlugin } from "@kanbaner/plugin-projects/ui";\nexport const builtin = [projectsUiPlugin];\n',
    );

    // 11. CLI использует только public contracts и не импортирует server graph.
    writeFile(
      path.join(cliRoot, "src", "bad.ts"),
      'import { OperationBus } from "@kanbaner/kernel";\nexport const bus = OperationBus;\n',
    );
    writeFile(
      path.join(cliRoot, "src", "good.ts"),
      'import { parseArgs } from "node:util";\nimport { TASKS_QUERY_IDS } from "@kanbaner/plugin-tasks/contract";\nexport const value = [parseArgs, TASKS_QUERY_IDS];\n',
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
    assertViolation(
      violations,
      "packages/plugin-tasks/src/store.ts",
      "client-safe contract не должен достигать server-модуля",
    );
    assertViolation(
      violations,
      "packages/plugin-tasks/src/contract-node.ts",
      "client-safe contract не должен импортировать node:crypto",
    );
    assertViolation(
      violations,
      "packages/plugin-tasks/src/kernel-import.ts",
      "запрещённый импорт (import): @kanbaner/kernel",
    );
    assertViolation(
      violations,
      "packages/plugin-tasks/src/other-plugin.ts",
      "запрещённый импорт (import): @kanbaner/plugin-fixture",
    );
    assertViolation(violations, "packages/plugin-tasks/src/sql.ts", "SQL statement вне миграций");
    assertViolation(
      violations,
      "packages/plugin-tasks/src/fs-import.ts",
      "запрещённый node builtin вне whitelist",
    );
    assertViolation(
      violations,
      "packages/task-ui/src/bad.ts",
      "корневой @kanbaner/plugin-tasks запрещён",
    );
    assertViolation(
      violations,
      "packages/task-ui/src/apps-import.ts",
      "относительный импорт выходит за пределы task-ui",
    );
    assertViolation(
      violations,
      "packages/plugin-projects/src/index.ts",
      "server graph не должен импортировать React/client",
    );
    assertViolation(
      violations,
      "packages/plugin-projects/src/ui.tsx",
      "UI entrypoint не должен достигать server entrypoint",
    );
    assertViolation(
      violations,
      "packages/plugin-projects/src/ui.tsx",
      "корневой @kanbaner/plugin-tasks запрещён",
    );
    assertViolation(
      violations,
      "packages/plugin-projects/src/server-mix.ts",
      "server graph не должен импортировать React/client",
    );
    assertViolation(
      violations,
      "apps/web/src/ui/shell.tsx",
      `UI-entrypoint плагина разрешён только из ${BUILTIN_UI_COMPOSITION}`,
    );
    assertViolation(
      violations,
      "apps/web/src/ui/shell-kanban.tsx",
      `UI-entrypoint плагина разрешён только из ${BUILTIN_UI_COMPOSITION}`,
    );
    assertNoViolation(violations, "packages/task-ui/src/good.ts");
    assertNoViolation(violations, "packages/plugin-projects/src/metadata.ts");
    assertNoViolation(violations, "apps/web/src/ui/builtin-ui-plugins.ts");
    assertNoViolation(violations, "packages/plugin-fixture/src/good.ts");
    assertNoViolation(violations, "packages/plugin-tasks/src/good-dep.ts");
    assertNoViolation(violations, "packages/plugin-tasks/src/activation.ts");
    assertNoViolation(violations, "packages/plugin-tasks/src/contract.ts");
    assertViolation(violations, "packages/cli/src/bad.ts", "cli должен использовать только HTTP");
    assertNoViolation(violations, "packages/cli/src/good.ts");

    console.log(
      `Import boundary self-test: ${String(violations.length)} violation(s) в ${String(
        new Set(violations.map((violation) => violation.file)).size,
      )} файле(ах); правила relative/side-effect/SQL/production/contract проверены.`,
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
    console.log(
      "Import boundaries: plugin-tasks не импортирует kernel, SQL, драйверы и другие плагины; contract не достигает server-модулей.",
    );
    console.log(
      "Import boundaries: task-ui и plugin-projects не смешивают server и React; UI-entrypoint импортируется только composition-модулем.",
    );
    console.log("Import boundaries: cli использует только HTTP client и public contracts.");
  }
}
