import type {
  BackendId,
  LinkStore,
  MigrationStore,
  PluginDocumentStore,
  PluginStateStore,
  SearchIndexStrategy,
  SearchIndexStore,
  StorageCapabilities,
  StorageHealth,
  StorageProvider,
  StorageStoreRegistration,
  StorageStoreScope,
  StorageTransaction,
} from "./contracts.ts";
import { AsyncMutex } from "./async-mutex.ts";
import { storageError } from "./errors.ts";
import {
  createDocumentStore,
  createLinkStore,
  createMigrationStore,
  createPluginStateStore,
  createSearchIndexStore,
} from "./in-memory-stores.ts";
import {
  cloneState,
  createEmptyState,
  type InMemoryState,
  type StoreRunner,
} from "./in-memory-state.ts";
import { assertBackendId, assertPositiveVersion, currentUtcTimestamp } from "./validation.ts";

export interface InMemoryStorageDelays {
  readonly openMs?: number;
  readonly healthCheckMs?: number;
  readonly operationMs?: number;
  readonly transactionMs?: number;
}

export interface InMemoryStorageProviderOptions {
  readonly backendId?: BackendId;
  readonly capabilities?: Partial<StorageCapabilities>;
  readonly delays?: InMemoryStorageDelays;
  readonly now?: () => Date;
}

interface TransactionState {
  active: boolean;
}

function delayValue(value: number | undefined, label: string): number {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    throw storageError("INVALID_ARGUMENT", `Задержка ${label} должна быть целым числом 0…60000 мс`);
  }

  return value;
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds === 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Тестовый backend-neutral in-memory провайдер.
 *
 * Каждый экземпляр владеет отдельным состоянием. Искусственные асинхронные
 * задержки позволяют выявлять синхронные предположения в доменном коде.
 * Провайдер не является персистентным и не используется в production.
 */
export class InMemoryStorageProvider implements StorageProvider {
  readonly backendId: BackendId;
  readonly capabilities: StorageCapabilities;
  readonly documents: PluginDocumentStore;
  readonly links: LinkStore;
  readonly pluginStates: PluginStateStore;
  readonly migrations: MigrationStore;
  readonly searchIndex: SearchIndexStore;

  readonly #mutex = new AsyncMutex();
  readonly #now: () => Date;
  readonly #delays: Required<InMemoryStorageDelays>;
  #state: InMemoryState;
  #opened = false;

  constructor(options: InMemoryStorageProviderOptions = {}) {
    const backendId = options.backendId ?? "in-memory";

    assertBackendId(backendId);
    this.backendId = backendId;
    this.capabilities = Object.freeze({
      transactions: true,
      savepoints: true,
      json: true,
      fullTextSearch: false,
      stemming: false,
      onlineBackup: false,
      wal: false,
      watch: false,
      ...options.capabilities,
    });
    this.#now = options.now ?? (() => new Date());
    this.#delays = {
      openMs: delayValue(options.delays?.openMs, "openMs"),
      healthCheckMs: delayValue(options.delays?.healthCheckMs, "healthCheckMs"),
      operationMs: delayValue(options.delays?.operationMs, "operationMs"),
      transactionMs: delayValue(options.delays?.transactionMs, "transactionMs"),
    };
    this.#state = createEmptyState();

    const outsideRunner: StoreRunner = async (operation) =>
      this.#mutex.runExclusive(async () => {
        await this.#delay(this.#delays.operationMs);
        this.#assertOpen();

        return operation(this.#state);
      });

    this.documents = createDocumentStore(outsideRunner, this.#now);
    this.links = createLinkStore(outsideRunner, this.#now);
    this.pluginStates = createPluginStateStore(outsideRunner, this.#now);
    this.migrations = createMigrationStore(outsideRunner);
    this.searchIndex = createSearchIndexStore(outsideRunner, this.#now, this.#searchStrategy());
  }

  async open(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      await this.#delay(this.#delays.openMs);
      this.#opened = true;
    });
  }

  async close(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      await this.#delay(this.#delays.openMs);
      this.#opened = false;
    });
  }

  async healthCheck(): Promise<StorageHealth> {
    return this.#mutex.runExclusive(async () => {
      await this.#delay(this.#delays.healthCheckMs);

      return {
        ok: this.#opened,
        backendId: this.backendId,
        checkedAt: currentUtcTimestamp(this.#now),
      };
    });
  }

  async withTransaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T> {
    const release = await this.#mutex.acquire();

    try {
      await this.#delay(this.#delays.transactionMs);
      this.#assertOpen();

      const snapshot = cloneState(this.#state);
      const state: TransactionState = { active: true };
      const transaction = this.#createTransaction(1, state);

      try {
        return await callback(transaction);
      } catch (error) {
        this.#state = snapshot;
        throw error;
      } finally {
        state.active = false;
      }
    } finally {
      release();
    }
  }

  async createStore<TStore>(registration: StorageStoreRegistration<TStore>): Promise<TStore> {
    this.#assertStoreRegistration(registration);

    return registration.create(this);
  }

  #createTransaction(depth: number, state: TransactionState): StorageTransaction {
    const transactionRunner: StoreRunner = async (operation) => {
      if (!state.active) {
        throw storageError("TRANSACTION_CLOSED", "Транзакция уже завершена");
      }

      await this.#delay(this.#delays.operationMs);
      this.#assertOpen();

      return operation(this.#state);
    };

    const scope: StorageStoreScope = {
      documents: createDocumentStore(transactionRunner, this.#now),
      links: createLinkStore(transactionRunner, this.#now),
      pluginStates: createPluginStateStore(transactionRunner, this.#now),
      migrations: createMigrationStore(transactionRunner),
      searchIndex: createSearchIndexStore(transactionRunner, this.#now, this.#searchStrategy()),
    };

    const transaction: StorageTransaction = {
      backendId: this.backendId,
      depth,
      ...scope,

      createStore: async <TStore>(
        registration: StorageStoreRegistration<TStore>,
      ): Promise<TStore> => {
        if (!state.active) {
          throw storageError("TRANSACTION_CLOSED", "Транзакция уже завершена");
        }

        this.#assertStoreRegistration(registration);

        return registration.create(transaction);
      },

      withSavepoint: async <T>(
        callback: (transaction: StorageTransaction) => Promise<T>,
      ): Promise<T> => {
        if (!this.capabilities.savepoints) {
          throw storageError(
            "SAVEPOINTS_UNSUPPORTED",
            "Storage Provider не поддерживает savepoints",
          );
        }

        if (!state.active) {
          throw storageError("TRANSACTION_CLOSED", "Транзакция уже завершена");
        }

        await this.#delay(this.#delays.transactionMs);

        const snapshot = cloneState(this.#state);
        const childState: TransactionState = { active: true };
        const child = this.#createTransaction(depth + 1, childState);

        try {
          return await callback(child);
        } catch (error) {
          this.#state = snapshot;
          throw error;
        } finally {
          childState.active = false;
        }
      },
    };

    return transaction;
  }

  #assertStoreRegistration<TStore>(registration: StorageStoreRegistration<TStore>): void {
    if (typeof registration !== "object" || registration === null) {
      throw storageError("INVALID_ARGUMENT", "Некорректная регистрация Store-контракта");
    }

    const contract = registration.contract;

    if (typeof contract !== "object" || contract === null || typeof contract.id !== "string") {
      throw storageError("INVALID_ARGUMENT", "Некорректный Store-контракт");
    }

    assertPositiveVersion(contract.version, "contract.version");

    if (typeof registration.create !== "function") {
      throw storageError("INVALID_ARGUMENT", "Store-контракт должен содержать create");
    }
  }

  #searchStrategy(): SearchIndexStrategy {
    return this.capabilities.fullTextSearch ? "full-text" : "substring";
  }

  #assertOpen(): void {
    if (!this.#opened) {
      throw storageError("PROVIDER_CLOSED", "Storage Provider не открыт");
    }
  }

  async #delay(milliseconds: number): Promise<void> {
    await wait(milliseconds);
  }
}
