// @vitest-environment node

import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createStorageProviderConformanceSuite, StorageMigrationRunner } from "@kanbaner/kernel";

import { createCoreInfrastructureMigrations } from "./infrastructure-migrations.ts";
import { createSqliteStorageProvider } from "./provider.ts";

const FIXED_NOW = () => new Date("2026-11-06T12:00:00.000Z");
const DELAYS = {
  openMs: 1,
  healthCheckMs: 1,
  operationMs: 1,
  transactionMs: 1,
} as const;

const NO_SAVEPOINTS_CASE = "savepoint недоступен без capability";

interface Variant {
  readonly name: string;
  readonly delays?: typeof DELAYS;
  readonly backendId: string;
  readonly alternateBackendId: string;
}

const variants: readonly Variant[] = [
  {
    name: "SQLite обычный",
    backendId: "sqlite",
    alternateBackendId: "sqlite-alt",
  },
  {
    name: "SQLite с искусственными задержками",
    delays: DELAYS,
    backendId: "sqlite-delayed",
    alternateBackendId: "sqlite-delayed-alt",
  },
];

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kanbaner-sqlite-conformance-"));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Готовит базу как composition root: open создаёт только журнал, а
 * версионируемая схема применяется инфраструктурной миграцией.
 */
async function preparedProvider(
  options: Parameters<typeof createSqliteStorageProvider>[0],
): Promise<ReturnType<typeof createSqliteStorageProvider>> {
  const provider = createSqliteStorageProvider(options);

  await provider.open();

  try {
    await new StorageMigrationRunner(provider).run(createCoreInfrastructureMigrations());
  } finally {
    await provider.close();
  }

  // Conformance Suite backend-neutral и ожидает пустой журнал для своих
  // миграций. Инфраструктурная миграция применена, но её служебная запись
  // убирается из тестового fixture-а.
  const database = new Database(provider.databasePath);

  try {
    database.prepare("DELETE FROM core_plugin_migrations WHERE plugin_id = ?").run("kanbaner.core");
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }

  return provider;
}

function variantOptions(
  variant: Variant,
  backendId: string,
  extra: Record<string, unknown> = {},
): Parameters<typeof createSqliteStorageProvider>[0] {
  return {
    backendId,
    dataDirectory: temporaryDirectory(),
    now: FIXED_NOW,
    ...(variant.delays === undefined ? {} : { delays: variant.delays }),
    ...extra,
  };
}

for (const variant of variants) {
  describe(`Storage Provider Conformance Suite: ${variant.name}`, () => {
    const suite = createStorageProviderConformanceSuite({
      createProvider: () => preparedProvider(variantOptions(variant, variant.backendId)),
      createProviderWithoutSavepoints: () =>
        preparedProvider(
          variantOptions(variant, `${variant.backendId}-no-savepoints`, {
            savepoints: false,
          }),
        ),
      createAlternateProvider: () =>
        preparedProvider(variantOptions(variant, variant.alternateBackendId)),
    });

    const baseCases = suite.filter(
      (conformanceCase) => conformanceCase.name !== NO_SAVEPOINTS_CASE,
    );

    it("содержит 33 базовых case и опциональный no-savepoints case", () => {
      expect(baseCases).toHaveLength(33);
      expect(suite).toHaveLength(34);
      expect(suite.some((conformanceCase) => conformanceCase.name === NO_SAVEPOINTS_CASE)).toBe(
        true,
      );
    });

    for (const conformanceCase of suite) {
      it(conformanceCase.name, async () => {
        const provider = await preparedProvider(variantOptions(variant, variant.backendId));

        await provider.open();

        try {
          await conformanceCase.run(provider);
        } finally {
          await provider.close();
        }
      });
    }
  });
}
