import type {
  ResourceRef,
  SearchDocumentInput,
  SearchHit,
  SearchIndexStore,
  SearchProvider,
  StorageTransaction,
} from "@kanbaner/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStorageProvider } from "../storage/in-memory-provider.ts";
import { createSearchService } from "./search-service.ts";

const providers: InMemoryStorageProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    await provider.close();
  }
});

function document(pluginId: string, id: string, title: string): SearchDocumentInput {
  return {
    ref: `${pluginId}:item:${id}`,
    title,
    text: title,
  };
}

function ref(pluginId: string, id: string): ResourceRef {
  return `${pluginId}:item:${id}`;
}

/**
 * Provider, который останавливает `tx.searchIndex.list` до явного release.
 *
 * Тест доказывает, что reindex читает foreign-документы именно внутри
 * транзакции provider-а, а последующий upsert ждёт её завершения.
 */
class PausedReindexProvider extends InMemoryStorageProvider {
  #releaseGate!: () => void;
  #startedList!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.#releaseGate = resolve;
  });
  readonly listStarted = new Promise<void>((resolve) => {
    this.#startedList = resolve;
  });

  release(): void {
    this.#releaseGate();
  }

  override withTransaction<T>(
    callback: (transaction: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    return super.withTransaction(async (transaction) => {
      const store = transaction.searchIndex;
      const gatedStore = new Proxy(store, {
        get: (target: SearchIndexStore, property: string | symbol): unknown => {
          if (property === "list") {
            return async () => {
              this.#startedList();
              await this.gate;

              return target.list();
            };
          }

          const value = Reflect.get(target, property, target);

          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      return callback({ ...transaction, searchIndex: gatedStore });
    });
  }
}

function pausedProvider(): PausedReindexProvider {
  const provider = new PausedReindexProvider({
    backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
  });

  providers.push(provider);

  return provider;
}

function providerById(id: string, overrides: Partial<SearchProvider> = {}): SearchProvider {
  return {
    id,
    kinds: [{ id: "item", title: "Элементы" }],
    filterFields: [],
    listFacets: async () => [],
    search: async () => [],
    reindex: async () => 0,
    ...overrides,
  };
}

function hit(ref: ResourceRef, score: number): SearchHit {
  return { ref, title: ref, excerpt: "", score, strategy: "substring" };
}

function expectSearchFailure(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect((error as { readonly error?: { readonly code?: string } }).error?.code).toBe(code);

    return;
  }

  throw new Error(`Ожидалась ошибка ${code}`);
}

describe("KernelSearchService", () => {
  it("reindex сохраняет документы другого plugin namespace", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);

    await provider.open();
    await service.upsert("kanbaner.alpha", [document("kanbaner.alpha", "old", "alpha old")]);
    await service.upsert("kanbaner.beta", [document("kanbaner.beta", "keep", "beta keep")]);

    const count = await service.reindex("kanbaner.alpha", [
      document("kanbaner.alpha", "new", "alpha new"),
    ]);

    expect(count).toBe(1);
    expect((await service.list("kanbaner.alpha")).map((item) => item.ref)).toEqual([
      ref("kanbaner.alpha", "new"),
    ]);
    expect((await service.list("kanbaner.beta")).map((item) => item.ref)).toEqual([
      ref("kanbaner.beta", "keep"),
    ]);
  });

  it("upsert того же plugin ждёт reindex и не теряется между чтением и заменой", async () => {
    const provider = pausedProvider();
    const service = createSearchService(provider);

    await provider.open();

    const reindex = service.reindex("kanbaner.alpha", [
      document("kanbaner.alpha", "base", "alpha base"),
    ]);

    await provider.listStarted;

    let upsertSettled = false;
    const upsert = service
      .upsert("kanbaner.alpha", [document("kanbaner.alpha", "late", "alpha late")])
      .then((count) => {
        upsertSettled = true;

        return count;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(upsertSettled).toBe(false);

    provider.release();

    await expect(reindex).resolves.toBe(1);
    await expect(upsert).resolves.toBe(1);

    expect((await service.list("kanbaner.alpha")).map((item) => item.ref).sort()).toEqual(
      [ref("kanbaner.alpha", "base"), ref("kanbaner.alpha", "late")].sort(),
    );
  });

  it("отклоняет регистрацию под чужим ID и невалидные объявления провайдера", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);

    await provider.open();

    expectSearchFailure(
      () => service.registerProvider("kanbaner.alpha", providerById("kanbaner.beta")),
      "PERMISSION_DENIED",
    );
    expectSearchFailure(
      () =>
        service.registerProvider("kanbaner.alpha", providerById("kanbaner.alpha", { kinds: [] })),
      "VALIDATION_ERROR",
    );
    expectSearchFailure(
      () =>
        service.registerProvider(
          "kanbaner.alpha",
          providerById("kanbaner.alpha", {
            kinds: [
              { id: "item", title: "Первый" },
              { id: "item", title: "Второй" },
            ],
          }),
        ),
      "VALIDATION_ERROR",
    );
    expectSearchFailure(
      () =>
        service.registerProvider(
          "kanbaner.alpha",
          providerById("kanbaner.alpha", { filterFields: ["tags", "tags"] }),
        ),
      "VALIDATION_ERROR",
    );
    expectSearchFailure(
      () =>
        service.registerProvider(
          "kanbaner.alpha",
          providerById("kanbaner.alpha", { filterFields: ["bad-field"] }),
        ),
      "VALIDATION_ERROR",
    );

    service.registerProvider("kanbaner.alpha", providerById("kanbaner.alpha"));

    expectSearchFailure(
      () => service.registerProvider("kanbaner.alpha", providerById("kanbaner.alpha")),
      "VALIDATION_ERROR",
    );
  });

  it("снимает провайдера по unregisterProviders и не вызывает его больше", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);
    let calls = 0;

    await provider.open();

    service.registerProvider(
      "kanbaner.alpha",
      providerById("kanbaner.alpha", {
        search: async () => {
          calls += 1;

          return [hit(ref("kanbaner.alpha", "one"), 1)];
        },
      }),
    );

    expect((await service.aggregate({ text: "anything" })).hits).toHaveLength(1);
    expect(calls).toBe(1);

    service.unregisterProviders("kanbaner.alpha");

    expect(await service.aggregate({ text: "anything" })).toEqual({
      hits: [],
      hasMore: false,
      warnings: [],
    });
    expect(await service.listFacets()).toEqual({ kinds: [], facets: [], warnings: [] });
    expect(calls).toBe(1);
  });

  it("агрегирует по score/ref, дедуплицирует и применяет offset+hasMore", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);
    const hits = [
      hit(ref("kanbaner.alpha", "r1"), 1),
      hit(ref("kanbaner.alpha", "r2"), 3),
      hit(ref("kanbaner.alpha", "r3"), 3),
      hit(ref("kanbaner.alpha", "r4"), 2),
      hit(ref("kanbaner.alpha", "r5"), 5),
      hit(ref("kanbaner.alpha", "r5"), 5),
    ];

    await provider.open();
    service.registerProvider(
      "kanbaner.alpha",
      providerById("kanbaner.alpha", {
        search: async () => hits,
      }),
    );

    const first = await service.aggregate({ text: "anything", limit: 2 });

    expect(first.hits.map((item) => item.ref)).toEqual([
      ref("kanbaner.alpha", "r5"),
      ref("kanbaner.alpha", "r2"),
    ]);
    expect(first.hasMore).toBe(true);

    const second = await service.aggregate({ text: "anything", limit: 2, offset: 3 });

    expect(second.hits.map((item) => item.ref)).toEqual([
      ref("kanbaner.alpha", "r4"),
      ref("kanbaner.alpha", "r1"),
    ]);
    expect(second.hasMore).toBe(false);
  });

  it("сохраняет выдачу с warning provider_failed при отказе одного провайдера", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);

    await provider.open();
    service.registerProvider(
      "kanbaner.alpha",
      providerById("kanbaner.alpha", {
        search: async () => {
          throw new Error("provider down");
        },
      }),
    );
    service.registerProvider(
      "kanbaner.beta",
      providerById("kanbaner.beta", {
        search: async () => [hit(ref("kanbaner.beta", "ok"), 1)],
      }),
    );

    const result = await service.aggregate({ text: "anything" });

    expect(result.hits.map((item) => item.ref)).toEqual([ref("kanbaner.beta", "ok")]);
    expect(result.warnings).toEqual([{ providerId: "kanbaner.alpha", code: "provider_failed" }]);
  });

  it("отбрасывает чужой ResourceRef с warning foreign_ref", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);

    await provider.open();
    service.registerProvider(
      "kanbaner.alpha",
      providerById("kanbaner.alpha", {
        search: async () => [hit(ref("kanbaner.beta", "foreign"), 10)],
      }),
    );

    expect(await service.aggregate({ text: "anything" })).toEqual({
      hits: [],
      hasMore: false,
      warnings: [{ providerId: "kanbaner.alpha", code: "foreign_ref" }],
    });
  });

  it("возвращает DEPENDENCY_UNAVAILABLE, если упали все провайдеры", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);

    await provider.open();
    service.registerProvider(
      "kanbaner.alpha",
      providerById("kanbaner.alpha", {
        search: async () => {
          throw new Error("provider down");
        },
      }),
    );
    service.registerProvider(
      "kanbaner.beta",
      providerById("kanbaner.beta", {
        search: async () => {
          throw new Error("provider down");
        },
        listFacets: async () => {
          throw new Error("facets down");
        },
      }),
    );

    await expect(service.aggregate({ text: "anything" })).rejects.toMatchObject({
      error: { code: "DEPENDENCY_UNAVAILABLE" },
    });
    expect(await service.listFacets()).toEqual({
      kinds: [{ id: "item", title: "Элементы" }],
      facets: [],
      warnings: [{ providerId: "kanbaner.beta", code: "provider_failed" }],
    });
  });

  it("валидирует kind и filter до раннего выхода без провайдеров", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `memory-search-${globalThis.crypto.randomUUID()}`,
    });
    providers.push(provider);
    const service = createSearchService(provider);

    await provider.open();

    await expect(service.aggregate({ text: "anything", kinds: ["unknown"] })).rejects.toMatchObject(
      { error: { code: "VALIDATION_ERROR" } },
    );
    await expect(
      service.aggregate({
        text: "anything",
        filters: [{ field: "unknown", operator: "eq", value: "x" }],
      }),
    ).rejects.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    await expect(service.aggregate({ text: "anything" })).resolves.toEqual({
      hits: [],
      hasMore: false,
      warnings: [],
    });
  });
});
