import type {
  ResourceRef,
  SearchDocumentInput,
  SearchIndexStore,
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
});
