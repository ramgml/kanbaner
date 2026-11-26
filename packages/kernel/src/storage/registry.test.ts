import { describe, expect, it } from "vitest";

import type {
  StorageProvider,
  StorageStoreContract,
  StorageStoreRegistration,
  StorageStoreScope,
} from "./contracts.ts";
import { InMemoryStorageProvider } from "./in-memory-provider.ts";
import { StorageProviderRegistry } from "./registry.ts";

const NOW = () => new Date("2026-11-06T12:00:00.000Z");

function provider(backendId: string): InMemoryStorageProvider {
  return new InMemoryStorageProvider({ backendId, now: NOW });
}

async function expectCode(work: () => unknown, code: string): Promise<void> {
  try {
    await work();
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(code);

    return;
  }

  throw new Error(`Ожидалась ошибка ${code}`);
}

class UnhealthyProvider extends InMemoryStorageProvider {
  override async healthCheck() {
    return {
      ok: false,
      backendId: this.backendId,
      checkedAt: "2026-11-06T12:00:00.000Z",
    } as const;
  }
}

describe("StorageProviderRegistry", () => {
  it("регистрирует провайдера по backendId и отдаёт capabilities", () => {
    const registry = new StorageProviderRegistry();
    const memory = provider("memory-one");

    registry.register(memory);

    expect(registry.has("memory-one")).toBe(true);
    expect(registry.get("memory-one")).toBe(memory);
    expect(registry.capabilitiesOf("memory-one").transactions).toBe(true);
    expect(registry.list()).toEqual([
      { backendId: "memory-one", capabilities: memory.capabilities },
    ]);
  });

  it("отклоняет дублирующий backendId без изменения реестра", async () => {
    const registry = new StorageProviderRegistry();
    const first = provider("memory-duplicate");
    const second = provider("memory-duplicate");

    registry.register(first);
    await expectCode(() => registry.register(second), "DUPLICATE_BACKEND");

    expect(registry.get("memory-duplicate")).toBe(first);
    expect(registry.list()).toHaveLength(1);
  });

  it("возвращает структурированную ошибку для неизвестного backend", async () => {
    const registry = new StorageProviderRegistry();

    await expectCode(() => registry.get("missing-backend"), "UNKNOWN_BACKEND");
    await expectCode(() => registry.capabilitiesOf("missing-backend"), "UNKNOWN_BACKEND");
    await expectCode(() => registry.open("missing-backend"), "UNKNOWN_BACKEND");
  });

  it("не регистрирует провайдер без capability transactions", async () => {
    const registry = new StorageProviderRegistry();
    const noTransactions = new InMemoryStorageProvider({
      backendId: "memory-no-transactions",
      capabilities: { transactions: false },
    });

    await expectCode(() => registry.register(noTransactions), "MISSING_TRANSACTIONS_CAPABILITY");
    expect(registry.has("memory-no-transactions")).toBe(false);
  });

  it("отклоняет некорректный provider и backendId", async () => {
    const registry = new StorageProviderRegistry();

    await expectCode(
      () => registry.register(null as unknown as StorageProvider),
      "INVALID_PROVIDER",
    );
    await expectCode(
      () =>
        registry.register({ ...provider("valid"), backendId: "Bad Backend" } as StorageProvider),
      "INVALID_BACKEND_ID",
    );
  });

  it("открывает провайдер, делает его активным и закрывает", async () => {
    const registry = new StorageProviderRegistry();
    const memory = provider("memory-active");

    registry.register(memory);

    const opened = await registry.open("memory-active");
    expect(opened).toBe(memory);
    expect(registry.getActive()).toBe(memory);
    expect((await registry.healthCheck("memory-active")).ok).toBe(true);

    await registry.close("memory-active");
    expect(() => registry.getActive()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_BACKEND" }),
    );
  });

  it("не допускает второй активный backend", async () => {
    const registry = new StorageProviderRegistry();
    const first = provider("memory-first");
    const second = provider("memory-second");

    registry.register(first);
    registry.register(second);

    await registry.open("memory-first");
    await expectCode(() => registry.open("memory-second"), "ACTIVE_BACKEND_CONFLICT");
    expect(registry.getActive()).toBe(first);

    await registry.closeAll();
    expect(first.capabilities.transactions).toBe(true);
  });

  it("не активирует провайдер с неуспешным health check", async () => {
    const registry = new StorageProviderRegistry();
    const unhealthy = new UnhealthyProvider({ backendId: "memory-unhealthy", now: NOW });

    registry.register(unhealthy);
    await expectCode(() => registry.open("memory-unhealthy"), "HEALTH_CHECK_FAILED");

    expect((await unhealthy.healthCheck()).ok).toBe(false);
    expect(() => registry.getActive()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_BACKEND" }),
    );
  });

  it("сериализует конкурентные open и не открывает два backend", async () => {
    const registry = new StorageProviderRegistry();
    const first = new InMemoryStorageProvider({
      backendId: "memory-race-first",
      now: NOW,
      delays: { openMs: 1, healthCheckMs: 1 },
    });
    const second = new InMemoryStorageProvider({
      backendId: "memory-race-second",
      now: NOW,
      delays: { openMs: 1, healthCheckMs: 1 },
    });

    registry.register(first);
    registry.register(second);

    const results = await Promise.allSettled([
      registry.open("memory-race-first"),
      registry.open("memory-race-second"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedResult = rejected[0];

    if (rejectedResult !== undefined && rejectedResult.status === "rejected") {
      expect((rejectedResult.reason as { readonly code?: string }).code).toBe(
        "ACTIVE_BACKEND_CONFLICT",
      );
    }

    const healths = await Promise.all([first.healthCheck(), second.healthCheck()]);

    expect(healths.filter((health) => health.ok)).toHaveLength(1);
  });

  it("возвращает один проверенный health при openChecked", async () => {
    const registry = new StorageProviderRegistry();
    const memory = provider("memory-open-checked");

    registry.register(memory);

    const opened = await registry.openChecked("memory-open-checked");

    expect(opened.provider).toBe(memory);
    expect(opened.health.ok).toBe(true);
    expect(opened.health.backendId).toBe("memory-open-checked");
    expect(registry.getActive()).toBe(memory);
  });

  it("регистрирует и создаёт доменный Store по контракту", async () => {
    interface CountStore {
      count(): Promise<number>;
    }

    const registry = new StorageProviderRegistry();
    const memory = provider("memory-stores");
    const contract: StorageStoreContract<CountStore> = {
      id: "acme.widgets.store.v1",
      version: 1,
    };
    const registration: StorageStoreRegistration<CountStore> = {
      contract,
      create(scope: StorageStoreScope) {
        return {
          async count() {
            return (await scope.documents.list("acme.widgets")).length;
          },
        };
      },
    };

    registry.register(memory);
    registry.registerStore("memory-stores", registration);
    await memory.open();

    const store = await registry.createStore("memory-stores", contract);
    expect(await store.count()).toBe(0);

    await expectCode(
      () => registry.registerStore("memory-stores", registration),
      "DUPLICATE_STORE_CONTRACT",
    );
  });

  it("возвращает ошибку для незарегистрированного Store-контракта", async () => {
    const registry = new StorageProviderRegistry();

    registry.register(provider("memory-no-store"));

    await expectCode(
      () =>
        registry.createStore("memory-no-store", {
          id: "acme.widgets.absent.v1",
          version: 1,
        }),
      "NOT_FOUND",
    );
  });

  it("валидирует контракт Store при регистрации", async () => {
    const registry = new StorageProviderRegistry();

    registry.register(provider("memory-invalid-store"));

    await expectCode(
      () =>
        registry.registerStore("memory-invalid-store", {
          contract: { id: "not-a-contract", version: 1 },
          create: () => ({
            async noop() {
              return undefined;
            },
          }),
        }),
      "INVALID_ARGUMENT",
    );
  });
});
