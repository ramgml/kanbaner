// @vitest-environment node

import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStorageProviderConformanceSuite } from "@kanbaner/kernel";

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

for (const variant of variants) {
  describe(`Storage Provider Conformance Suite: ${variant.name}`, () => {
    const suite = createStorageProviderConformanceSuite({
      createProvider: () =>
        createSqliteStorageProvider({
          backendId: variant.backendId,
          dataDirectory: temporaryDirectory(),
          now: FIXED_NOW,
          ...(variant.delays === undefined ? {} : { delays: variant.delays }),
        }),
      createProviderWithoutSavepoints: () =>
        createSqliteStorageProvider({
          backendId: `${variant.backendId}-no-savepoints`,
          dataDirectory: temporaryDirectory(),
          now: FIXED_NOW,
          savepoints: false,
          ...(variant.delays === undefined ? {} : { delays: variant.delays }),
        }),
      createAlternateProvider: () =>
        createSqliteStorageProvider({
          backendId: variant.alternateBackendId,
          dataDirectory: temporaryDirectory(),
          now: FIXED_NOW,
          ...(variant.delays === undefined ? {} : { delays: variant.delays }),
        }),
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
        const provider = createSqliteStorageProvider({
          backendId: variant.backendId,
          dataDirectory: temporaryDirectory(),
          now: FIXED_NOW,
          ...(variant.delays === undefined ? {} : { delays: variant.delays }),
        });

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
