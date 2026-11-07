#!/usr/bin/env node
import {
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(ROOT, "packages", "plugin-fixture");
const FIXTURE_PACKAGE = "@kanbaner/plugin-fixture";
const ALLOWED_FIXTURE_DEPENDENCY = "@kanbaner/plugin-sdk";

const FORBIDDEN_FIXTURE_IMPORTS = [
  { pattern: /@kanbaner\/kernel/u, label: "kernel" },
  { pattern: /(?:^|\/)apps\//u, label: "apps" },
  { pattern: /packages\/kernel/u, label: "kernel internals" },
  { pattern: /@kanbaner\/storage-sqlite/u, label: "storage provider" },
  {
    pattern: /better-sqlite3|node:sqlite|["']sqlite3["']|["']pg["']|["']mysql2?["']/u,
    label: "database driver",
  },
  { pattern: /["']react["']|["']react-dom["']/u, label: "React" },
  { pattern: /@sinclair\/typebox/u, label: "TypeBox outside SDK" },
  { pattern: /@kanbaner\/plugin-(?:tasks|notes|kanban|search|task-list)/u, label: "domain plugin" },
];

const SQL_PATTERNS = [
  /\bSELECT\b/u,
  /\bINSERT\s+INTO\b/u,
  /\bUPDATE\s+\w+\s+SET\b/u,
  /\bDELETE\s+FROM\b/u,
  /\bPRAGMA\b/u,
  /\bRETURNING\b/u,
  /\bCREATE\s+TABLE\b/u,
  /\bALTER\s+TABLE\b/u,
];

const SYNC_PATTERNS = [
  /\breadFileSync\b/u,
  /\bwriteFileSync\b/u,
  /\bstatSync\b/u,
  /\bopenSync\b/u,
  /\.prepare\s*\(/u,
];

function sourceFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) {
      files.push(absolute);
    }
  }

  return files;
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}

function importSpecifiers(source) {
  const specifiers = [];

  for (const match of source.matchAll(
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu,
  )) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

export function analyzePluginFixture(root = FIXTURE_ROOT) {
  const violations = [];
  const sourceRoot = path.join(root, "src");

  if (!statSync(root).isDirectory()) {
    violations.push({ file: relative(root), rule: "fixture package is missing" });

    return violations;
  }

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const fileLabel = relative(file);

    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".") || specifier === ALLOWED_FIXTURE_DEPENDENCY) {
        continue;
      }

      violations.push({
        file: fileLabel,
        rule: `запрещённый импорт ${specifier}`,
      });
    }

    for (const rule of FORBIDDEN_FIXTURE_IMPORTS) {
      if (rule.pattern.test(source)) {
        violations.push({ file: fileLabel, rule: `forbidden ${rule.label}` });
      }
    }

    for (const pattern of SQL_PATTERNS) {
      if (pattern.test(source)) {
        violations.push({ file: fileLabel, rule: `SQL ${pattern}` });
      }
    }

    for (const pattern of SYNC_PATTERNS) {
      if (pattern.test(source)) {
        violations.push({ file: fileLabel, rule: `synchronous storage call ${pattern}` });
      }
    }
  }

  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const dependencies = Object.keys(manifest.dependencies ?? {});

  for (const dependency of dependencies) {
    if (dependency !== ALLOWED_FIXTURE_DEPENDENCY) {
      violations.push({
        file: "packages/plugin-fixture/package.json",
        rule: `fixture dependency ${dependency} запрещена`,
      });
    }
  }

  for (const packageName of ["kernel", "plugin-sdk"]) {
    const packageRoot = path.join(ROOT, "packages", packageName);
    const packageManifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );

    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      if ((packageManifest[field] ?? {})[FIXTURE_PACKAGE] !== undefined) {
        violations.push({
          file: `packages/${packageName}/package.json`,
          rule: `production ${field} не должен зависеть от fixture`,
        });
      }
    }

    for (const file of sourceFiles(path.join(packageRoot, "src"))) {
      if (readFileSync(file, "utf8").includes(FIXTURE_PACKAGE)) {
        violations.push({
          file: relative(file),
          rule: "ядро/SDK не должно ссылаться на fixture",
        });
      }
    }
  }

  const rootManifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

  for (const field of ["dependencies", "devDependencies"]) {
    if ((rootManifest[field] ?? {})[FIXTURE_PACKAGE] !== undefined) {
      violations.push({
        file: "package.json",
        rule: `корневой ${field} не должен зависеть от fixture`,
      });
    }
  }

  for (const file of sourceFiles(path.join(ROOT, "apps", "web", "src"))) {
    if (readFileSync(file, "utf8").includes(FIXTURE_PACKAGE)) {
      violations.push({
        file: relative(file),
        rule: "production apps/web не должен импортировать fixture",
      });
    }
  }

  return violations;
}

function runSelfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "kanbaner-import-boundaries-"));
  const pluginRoot = path.join(root, "packages", "plugin-fixture");

  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const source = path.join(pluginRoot, "src");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(source, "bad.ts"),
      'import { describeKernel } from "@kanbaner/kernel";\nconst sql = "SELECT * FROM x";\n',
    );
    writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ dependencies: { "@kanbaner/kernel": "workspace:*" } }),
    );

    const violations = analyzePluginFixture(pluginRoot).filter((violation) =>
      violation.file.endsWith("bad.ts"),
    );

    if (violations.length < 2) {
      throw new Error("Self-test не обнаружил запрещённые импорт/SQL");
    }

    console.log(`Import boundary self-test: detected ${String(violations.length)} violation(s).`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  const violations = analyzePluginFixture();

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
