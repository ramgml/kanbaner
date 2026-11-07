#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = [
  "Kanbaner offline restore",
  "",
  "Использование:",
  "  node scripts/restore.mjs --backup <file> --data-dir <new-dir> [--file kanbaner.sqlite]",
  "",
  "Запускайте только при остановленном приложении. Восстановление выполняется",
  "в новый каталог; каталог с существующей базой отклоняется. Источник читается",
  "через SQLite .backup(), live-файлы базы, WAL и SHM не копируются.",
].join("\n");

function fail(message) {
  console.error(`Restore failed: ${message}`);
  process.exitCode = 1;
}

async function main() {
  let parsed;

  try {
    parsed = parseArgs({
      options: {
        backup: { type: "string" },
        "data-dir": { type: "string" },
        file: { type: "string", default: "kanbaner.sqlite" },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch {
    console.error(USAGE);
    process.exitCode = 1;

    return;
  }

  if (parsed.values.help === true) {
    console.log(USAGE);

    return;
  }

  const backupPath = parsed.values.backup;
  const dataDirectory = parsed.values["data-dir"];
  const databaseFileName = parsed.values.file;

  if (typeof backupPath !== "string" || backupPath.length === 0) {
    fail("не указан --backup");
    return;
  }

  if (typeof dataDirectory !== "string" || dataDirectory.length === 0) {
    fail("не указан --data-dir");
    return;
  }

  const modulePath = path.join(
    import.meta.dirname,
    "..",
    "packages",
    "storage-sqlite",
    "dist",
    "index.js",
  );

  let restoreDatabase;

  try {
    ({ restoreDatabase } = await import(modulePath));
  } catch {
    fail("модуль @kanbaner/storage-sqlite не собран; выполните pnpm build:packages");
    return;
  }

  try {
    const result = await restoreDatabase({
      backupPath,
      dataDirectory,
      databaseFileName:
        typeof databaseFileName === "string" && databaseFileName.length > 0
          ? databaseFileName
          : undefined,
    });

    console.log(`Restore completed: ${result.databasePath} (${result.sizeBytes} bytes)`);
  } catch (error) {
    const message =
      error instanceof Error && typeof error.message === "string"
        ? error.message
        : "внутренняя ошибка";

    fail(message);
  }
}

await main();
