import { describe, expect, it } from "vitest";

import { createStorageProviderConformanceSuite } from "./conformance.ts";
import { InMemoryStorageProvider, type InMemoryStorageDelays } from "./in-memory-provider.ts";

const NOW = () => new Date("2026-11-06T12:00:00.000Z");

interface Variant {
  readonly name: string;
  readonly noSavepointsBackendId: string;
  readonly alternateBackendId: string;
  readonly delays?: InMemoryStorageDelays;
  createProvider(): InMemoryStorageProvider;
}

const variants: readonly Variant[] = [
  {
    name: "обычный in-memory provider",
    noSavepointsBackendId: "memory-conformance-no-savepoints",
    alternateBackendId: "memory-conformance-alternate",
    createProvider: () =>
      new InMemoryStorageProvider({
        backendId: "memory-conformance",
        now: NOW,
      }),
  },
  {
    name: "in-memory provider с искусственными задержками",
    noSavepointsBackendId: "memory-conformance-delayed-no-savepoints",
    alternateBackendId: "memory-conformance-delayed-alternate",
    delays: {
      openMs: 1,
      healthCheckMs: 1,
      operationMs: 1,
      transactionMs: 1,
    },
    createProvider: () =>
      new InMemoryStorageProvider({
        backendId: "memory-conformance-delayed",
        now: NOW,
        delays: {
          openMs: 1,
          healthCheckMs: 1,
          operationMs: 1,
          transactionMs: 1,
        },
      }),
  },
];

for (const variant of variants) {
  describe(`Storage Provider Conformance Suite: ${variant.name}`, () => {
    const suite = createStorageProviderConformanceSuite({
      createProvider: variant.createProvider,
      createProviderWithoutSavepoints: () =>
        new InMemoryStorageProvider({
          backendId: variant.noSavepointsBackendId,
          now: NOW,
          capabilities: { savepoints: false },
          ...(variant.delays === undefined ? {} : { delays: variant.delays }),
        }),
      createAlternateProvider: () =>
        new InMemoryStorageProvider({
          backendId: variant.alternateBackendId,
          now: NOW,
          ...(variant.delays === undefined ? {} : { delays: variant.delays }),
        }),
    });

    for (const conformanceCase of suite) {
      it(conformanceCase.name, async () => {
        const provider = variant.createProvider();

        await provider.open();

        try {
          await conformanceCase.run(provider);
        } finally {
          await provider.close();
        }
      });
    }

    it("suite содержит ключевые группы проверок", () => {
      const names = suite.map((conformanceCase) => conformanceCase.name).join("\n");

      expect(names).toContain("транзакция");
      expect(names).toContain("savepoint");
      expect(names).toContain("миграции");
      expect(names).toContain("ссылки");
      expect(names).toContain("документы");
      expect(names).toContain("поиск");
      expect(names).toContain("конкурентн");
      expect(names).toContain("rollback");
      expect(names).toContain("backend isolation");
    });
  });
}
