import { describe, expect, it } from "vitest";

import { createStorageProviderConformanceSuite } from "./conformance.ts";
import { InMemoryStorageProvider } from "./in-memory-provider.ts";

const NOW = () => new Date("2026-11-06T12:00:00.000Z");

interface Variant {
  readonly name: string;
  readonly noSavepointsBackendId: string;
  createProvider(): InMemoryStorageProvider;
}

const variants: readonly Variant[] = [
  {
    name: "обычный in-memory provider",
    noSavepointsBackendId: "memory-conformance-no-savepoints",
    createProvider: () =>
      new InMemoryStorageProvider({
        backendId: "memory-conformance",
        now: NOW,
      }),
  },
  {
    name: "in-memory provider с искусственными задержками",
    noSavepointsBackendId: "memory-conformance-delayed-no-savepoints",
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
    });
  });
}
