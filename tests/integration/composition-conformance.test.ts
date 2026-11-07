// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { createStorageProviderConformanceSuite, InMemoryStorageProvider } from "@kanbaner/kernel";
import type { StorageProvider } from "@kanbaner/plugin-sdk";
import { createSqliteStorageProvider } from "@kanbaner/storage-sqlite";

import { createApplicationStorage } from "../../apps/web/src/server/application-storage.ts";
import { removeDirectory, temporaryDirectory } from "../contract/fixture-harness.ts";

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }

  for (const directory of directories.splice(0)) {
    removeDirectory(directory);
  }
});

interface ProviderVariant {
  readonly name: string;
  create(): Promise<StorageProvider>;
}

function inMemory(backendId: string, delays: boolean): ProviderVariant {
  return {
    name: backendId,
    async create() {
      const provider = new InMemoryStorageProvider({
        backendId,
        ...(delays
          ? { delays: { openMs: 1, healthCheckMs: 1, operationMs: 2, transactionMs: 1 } }
          : {}),
      });

      await provider.open();
      closers.push(() => provider.close());

      return provider;
    },
  };
}

function sqlite(backendId: string, delays: boolean): ProviderVariant {
  return {
    name: backendId,
    async create() {
      const dataDirectory = temporaryDirectory(`kanbaner-conformance-${backendId}-`);
      directories.push(dataDirectory);

      const provider = createSqliteStorageProvider({
        backendId,
        dataDirectory,
        ...(delays
          ? { delays: { openMs: 1, healthCheckMs: 1, operationMs: 2, transactionMs: 1 } }
          : {}),
      });
      const storage = await createApplicationStorage({ provider, dataDirectory });

      closers.push(() => storage.registry.closeAll());

      return storage.provider;
    },
  };
}

const variants: readonly ProviderVariant[] = [
  inMemory("memory-conformance-path", false),
  inMemory("memory-conformance-delayed-path", true),
  sqlite("sqlite-conformance-path", false),
  sqlite("sqlite-conformance-delayed-path", true),
];

const SELECTED_CASES = [
  "объявляет backendId и capabilities до операции",
  "открытие и health check идемпотентны",
  "публичные операции Store возвращают Promise",
  "документы: create/get/list/query/delete с app-generated ID",
  "ссылки: add атомарен и идемпотентен",
  "ссылки: удаление ref очищает связи с обеих сторон",
  "транзакция коммитится после завершения async callback",
  "rejected Promise внутри транзакции откатывает изменения",
  "поиск: индексирует, находит и полностью переиндексирует",
] as const;

const suite = createStorageProviderConformanceSuite({
  createProvider: () => {
    throw new Error("createProvider не используется в integration-проверке");
  },
});

const selected = suite.filter((conformanceCase) =>
  (SELECTED_CASES as readonly string[]).includes(conformanceCase.name),
);

describe("Conformance Suite: явный integration path на четырёх provider-ах", () => {
  it("выбирает существующие case из общего suite", () => {
    expect(selected).toHaveLength(SELECTED_CASES.length);
  });

  for (const variant of variants) {
    describe(variant.name, () => {
      for (const conformanceCase of selected) {
        it(conformanceCase.name, async () => {
          const provider = await variant.create();

          try {
            await conformanceCase.run(provider);
          } finally {
            await provider.close();
          }
        });
      }
    });
  }
});
