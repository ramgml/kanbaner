// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import type { SearchProvider } from "@kanbaner/plugin-sdk";

import { createSearchService } from "../search/search-service.ts";
import { InMemoryStorageProvider } from "../storage/in-memory-provider.ts";
import { bindPluginServices, createUnavailableHostServices } from "./activation-services.ts";

const providers: InMemoryStorageProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    await provider.close();
  }
});

function searchProvider(id: string): SearchProvider {
  return {
    id,
    kinds: [{ id: "item", title: "Элементы" }],
    filterFields: [],
    listFacets: async () => [],
    search: async () => [],
    reindex: async () => 0,
  };
}

describe("BoundPluginServices и SearchProvider Registry", () => {
  it(
    "dispose снимает провайдера при деактивации и откате активации",
    { timeout: 10_000 },
    async () => {
      const provider = new InMemoryStorageProvider({
        backendId: `activation-services-${globalThis.crypto.randomUUID()}`,
      });
      providers.push(provider);
      const search = createSearchService(provider);

      await provider.open();

      const services = bindPluginServices(
        { ...createUnavailableHostServices(), search },
        "kanbaner.alpha",
      );

      services.search.registerProvider(searchProvider("kanbaner.alpha"));

      expect((await search.listFacets()).kinds).toEqual([{ id: "item", title: "Элементы" }]);

      // Runtime вызывает dispose и при deactivate, и при rollback упавшей
      // активации; после него провайдер не должен оставаться в реестре.
      services.dispose();

      expect(await search.aggregate({ text: "anything" })).toEqual({
        hits: [],
        hasMore: false,
        warnings: [],
      });
      expect(await search.listFacets()).toEqual({ kinds: [], facets: [], warnings: [] });

      // Повторный dispose идемпотентен.
      services.dispose();

      expect(await search.listFacets()).toEqual({ kinds: [], facets: [], warnings: [] });
    },
  );
});
