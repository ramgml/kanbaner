// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";

import type { SearchAggregateResult, SearchFacetSet } from "@kanbaner/plugin-sdk";

import { createSearchService } from "../search/search-service.ts";
import { InMemoryStorageProvider } from "../storage/in-memory-provider.ts";
import { createUnavailableHostServices } from "./activation-services.ts";
import { createPluginRuntime } from "./plugin-runtime.ts";
import { fixtureEvents, fixturePath, resetFixtures } from "./test-support.ts";

beforeEach(() => {
  resetFixtures();
});

async function searchHost(): Promise<{
  readonly provider: InMemoryStorageProvider;
  readonly services: ReturnType<typeof createUnavailableHostServices>;
  readonly aggregate: () => Promise<SearchAggregateResult>;
  readonly facets: () => Promise<SearchFacetSet>;
  close(): Promise<void>;
}> {
  const provider = new InMemoryStorageProvider({
    backendId: `runtime-search-${globalThis.crypto.randomUUID()}`,
  });

  await provider.open();
  const search = createSearchService(provider);

  return {
    provider,
    services: { ...createUnavailableHostServices(), search },
    aggregate: () => search.aggregate({ text: "anything" }),
    facets: () => search.listFacets(),
    async close() {
      await provider.close();
    },
  };
}

describe("SearchProvider Registry и lifecycle runtime", () => {
  it(
    "снимает провайдера при откате упавшей активации и safe mode",
    { timeout: 10_000 },
    async () => {
      const host = await searchHost();

      try {
        const runtime = createPluginRuntime({
          pluginDirectories: [fixturePath("search-provider", "rollback")],
          services: host.services,
        });
        const snapshot = await runtime.start();

        expect(snapshot.safeMode).toBe(true);
        expect(snapshot.activationOrder).toEqual([]);
        expect(
          snapshot.diagnostics.some(
            (diagnostic) =>
              diagnostic.pluginId === "fixture.search-leaky" &&
              diagnostic.code === "activation_failed",
          ),
        ).toBe(true);
        expect(fixtureEvents()).toEqual([
          "activate:fixture.search-leaky",
          "deactivate:fixture.search-leaky",
        ]);

        // Провайдер зарегистрировался до throw, но rollback обязан его снять.
        expect(await host.aggregate()).toEqual({ hits: [], hasMore: false, warnings: [] });
        expect(await host.facets()).toEqual({ kinds: [], facets: [], warnings: [] });

        await runtime.stop();
      } finally {
        await host.close();
      }
    },
  );

  it("снимает провайдера при деактивации runtime.stop", { timeout: 10_000 }, async () => {
    const host = await searchHost();

    try {
      const runtime = createPluginRuntime({
        pluginDirectories: [fixturePath("search-provider", "deactivation")],
        services: host.services,
      });
      const started = await runtime.start();

      expect(started.safeMode).toBe(false);
      expect(started.activationOrder).toEqual(["fixture.search-stable"]);
      expect((await host.facets()).kinds).toEqual([{ id: "item", title: "Элементы" }]);

      const stopped = await runtime.stop();

      expect(stopped.deactivationOrder).toEqual(["fixture.search-stable"]);
      expect(fixtureEvents()).toEqual([
        "activate:fixture.search-stable",
        "deactivate:fixture.search-stable",
      ]);
      expect(await host.facets()).toEqual({ kinds: [], facets: [], warnings: [] });
      expect(await host.aggregate()).toEqual({ hits: [], hasMore: false, warnings: [] });
    } finally {
      await host.close();
    }
  });

  it(
    "safe mode не импортирует модуль и не регистрирует провайдера",
    { timeout: 10_000 },
    async () => {
      const host = await searchHost();

      try {
        const runtime = createPluginRuntime({
          pluginDirectories: [fixturePath("search-provider", "deactivation")],
          services: host.services,
          safeMode: true,
        });
        const snapshot = await runtime.start();

        expect(snapshot.mode).toBe("safe_mode");
        expect(snapshot.safeMode).toBe(true);
        expect(snapshot.activationOrder).toEqual([]);
        expect(fixtureEvents()).toEqual([]);
        expect(await host.facets()).toEqual({ kinds: [], facets: [], warnings: [] });
      } finally {
        await host.close();
      }
    },
  );
});
