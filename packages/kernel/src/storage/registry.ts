import { isContractId } from "@kanbaner/plugin-sdk";

import type {
  BackendId,
  StorageCapabilities,
  StorageHealth,
  StorageProvider,
  StorageProviderInfo,
  StorageStoreContract,
  StorageStoreRegistration,
} from "./contracts.ts";
import { storageError } from "./errors.ts";
import { assertBackendId, assertPositiveVersion } from "./validation.ts";

interface ProviderEntry {
  readonly provider: StorageProvider;
  readonly stores: Map<string, StorageStoreRegistration<unknown>>;
}

function contractKey(contract: StorageStoreContract<unknown>): string {
  return `${contract.id}@${contract.version}`;
}

function isFunction(value: unknown): value is (...parameters: readonly unknown[]) => unknown {
  return typeof value === "function";
}

/**
 * Реестр Storage Provider.
 *
 * Регистрирует провайдеры по стабильному `backendId`, отклоняет дубликат и
 * провайдер без обязательной capability `transactions`. Плагин получает
 * capabilities до выполнения операции.
 */
export class StorageProviderRegistry {
  readonly #entries = new Map<BackendId, ProviderEntry>();
  #activeBackendId: BackendId | null = null;

  /** Регистрирует провайдер; повторный `backendId` отклоняется. */
  register(provider: StorageProvider): void {
    this.#assertProvider(provider);

    if (this.#entries.has(provider.backendId)) {
      throw storageError("DUPLICATE_BACKEND", "Storage backend уже зарегистрирован", {
        details: { backendId: provider.backendId },
      });
    }

    if (provider.capabilities.transactions !== true) {
      throw storageError(
        "MISSING_TRANSACTIONS_CAPABILITY",
        "Storage Provider без capability transactions несовместим с MVP",
        { details: { backendId: provider.backendId } },
      );
    }

    this.#entries.set(provider.backendId, {
      provider,
      stores: new Map<string, StorageStoreRegistration<unknown>>(),
    });
  }

  has(backendId: BackendId): boolean {
    return this.#entries.has(backendId);
  }

  /** Возвращает провайдер или структурированную ошибку `UNKNOWN_BACKEND`. */
  get(backendId: BackendId): StorageProvider {
    assertBackendId(backendId);

    const entry = this.#entries.get(backendId);

    if (entry === undefined) {
      throw storageError("UNKNOWN_BACKEND", "Storage backend не зарегистрирован", {
        details: { backendId },
      });
    }

    return entry.provider;
  }

  list(): readonly StorageProviderInfo[] {
    return [...this.#entries.values()]
      .map((entry) => ({
        backendId: entry.provider.backendId,
        capabilities: entry.provider.capabilities,
      }))
      .sort((left, right) =>
        left.backendId < right.backendId ? -1 : left.backendId > right.backendId ? 1 : 0,
      );
  }

  capabilitiesOf(backendId: BackendId): StorageCapabilities {
    return this.get(backendId).capabilities;
  }

  /**
   * Открывает провайдер и проверяет здоровье до каких-либо миграций.
   *
   * Активным может быть только один backend (MVP).
   */
  async open(backendId: BackendId): Promise<StorageProvider> {
    const provider = this.get(backendId);

    if (this.#activeBackendId !== null && this.#activeBackendId !== backendId) {
      throw storageError("ACTIVE_BACKEND_CONFLICT", "Другой Storage backend уже активен", {
        details: { backendId, activeBackendId: this.#activeBackendId },
      });
    }

    await provider.open();

    let health: StorageHealth;

    try {
      health = await provider.healthCheck();
    } catch (error) {
      await provider.close();

      throw storageError("HEALTH_CHECK_FAILED", "Health check Storage Provider не выполнен", {
        details: { backendId },
        cause: error,
      });
    }

    if (!health.ok) {
      await provider.close();

      throw storageError("HEALTH_CHECK_FAILED", "Storage Provider не прошёл health check", {
        details: { backendId },
      });
    }

    this.#activeBackendId = backendId;

    return provider;
  }

  async close(backendId: BackendId): Promise<void> {
    const provider = this.get(backendId);

    await provider.close();

    if (this.#activeBackendId === backendId) {
      this.#activeBackendId = null;
    }
  }

  async healthCheck(backendId: BackendId): Promise<StorageHealth> {
    return this.get(backendId).healthCheck();
  }

  /** Активный провайдер; до открытия возвращает структурированную ошибку. */
  getActive(): StorageProvider {
    if (this.#activeBackendId === null) {
      throw storageError("NO_ACTIVE_BACKEND", "Нет активного Storage backend");
    }

    return this.get(this.#activeBackendId);
  }

  /** Регистрирует реализацию доменного Store-контракта для backend. */
  registerStore<TStore>(
    backendId: BackendId,
    registration: StorageStoreRegistration<TStore>,
  ): void {
    const entry = this.#entry(backendId);

    this.#assertStoreRegistration(registration);

    const key = contractKey(registration.contract);

    if (entry.stores.has(key)) {
      throw storageError("DUPLICATE_STORE_CONTRACT", "Store-контракт уже зарегистрирован", {
        details: { backendId, contractId: registration.contract.id },
      });
    }

    entry.stores.set(key, registration as StorageStoreRegistration<unknown>);
  }

  /** Создаёт Store по зарегистрированному контракту. */
  async createStore<TStore>(
    backendId: BackendId,
    contract: StorageStoreContract<TStore>,
  ): Promise<TStore> {
    const entry = this.#entry(backendId);

    this.#assertContract(contract);

    const registration = entry.stores.get(contractKey(contract));

    if (registration === undefined) {
      throw storageError("NOT_FOUND", "Store-контракт не зарегистрирован для backend", {
        details: { backendId, contractId: contract.id },
      });
    }

    return entry.provider.createStore(registration as StorageStoreRegistration<TStore>);
  }

  async closeAll(): Promise<void> {
    const providers = [...this.#entries.values()].map((entry) => entry.provider);

    for (const provider of providers) {
      await provider.close();
    }

    this.#activeBackendId = null;
  }

  #entry(backendId: BackendId): ProviderEntry {
    const entry = this.#entries.get(backendId);

    if (entry === undefined) {
      throw storageError("UNKNOWN_BACKEND", "Storage backend не зарегистрирован", {
        details: { backendId },
      });
    }

    return entry;
  }

  #assertProvider(provider: StorageProvider): void {
    if (typeof provider !== "object" || provider === null) {
      throw storageError("INVALID_PROVIDER", "Некорректный Storage Provider");
    }

    assertBackendId(provider.backendId);

    const capabilities = provider.capabilities;

    if (typeof capabilities !== "object" || capabilities === null) {
      throw storageError("INVALID_PROVIDER", "Storage Provider не объявил capabilities", {
        details: { backendId: provider.backendId },
      });
    }

    const methodNames = ["open", "close", "healthCheck", "withTransaction", "createStore"] as const;

    for (const methodName of methodNames) {
      if (!isFunction(provider[methodName])) {
        throw storageError("INVALID_PROVIDER", "Storage Provider не реализует обязательный метод", {
          details: { backendId: provider.backendId, method: methodName },
        });
      }
    }

    const storeNames = ["documents", "links", "pluginStates", "migrations", "searchIndex"] as const;

    for (const storeName of storeNames) {
      if (typeof provider[storeName] !== "object" || provider[storeName] === null) {
        throw storageError("INVALID_PROVIDER", "Storage Provider не предоставляет Store", {
          details: { backendId: provider.backendId, store: storeName },
        });
      }
    }
  }

  #assertStoreRegistration<TStore>(registration: StorageStoreRegistration<TStore>): void {
    if (typeof registration !== "object" || registration === null) {
      throw storageError("INVALID_ARGUMENT", "Некорректная регистрация Store-контракта");
    }

    this.#assertContract(registration.contract);

    if (typeof registration.create !== "function") {
      throw storageError("INVALID_ARGUMENT", "Store-контракт должен содержать create");
    }
  }

  #assertContract<TStore>(contract: StorageStoreContract<TStore>): void {
    if (typeof contract !== "object" || contract === null || !isContractId(contract.id)) {
      throw storageError("INVALID_ARGUMENT", "Некорректный идентификатор Store-контракта");
    }

    assertPositiveVersion(contract.version, "contract.version");
  }
}
