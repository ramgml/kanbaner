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

/**
 * Состояние области транзакции или savepoint.
 *
 * `active` сбрасывается сразу после завершения callback: новые операции
 * запрещены, а уже начатые обязаны завершиться до commit/rollback/release.
 * `rolledBack` фиксирует фактический откат области, а не только sealing.
 * `pending` хранит все начатые, но ещё не завершённые Store-операции области.
 */
interface TransactionScope {
  active: boolean;
  rolledBack: boolean;
  readonly parent: TransactionScope | null;
  readonly pending: Set<Promise<unknown>>;
}

function createScope(parent: TransactionScope | null): TransactionScope {
  return { active: true, rolledBack: false, parent, pending: new Set<Promise<unknown>>() };
}

function isScopeActive(scope: TransactionScope): boolean {
  let current: TransactionScope | null = scope;

  while (current !== null) {
    if (!current.active) {
      return false;
    }

    current = current.parent;
  }

  return true;
}

/**
 * Проверяет, что предок уже фактически откатился.
 *
 * Sealed-предок ещё не означает rollback: родитель ждёт завершения tracked
 * child-областей. Поэтому вложенный rejected savepoint обязан восстановить
 * собственный snapshot при sealed-родителе и пропустить restore только после
 * реального rollback предка.
 */
function hasRolledBackAncestor(scope: TransactionScope): boolean {
  let current: TransactionScope | null = scope;

  while (current !== null) {
    if (current.rolledBack) {
      return true;
    }

    current = current.parent;
  }

  return false;
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
      const scope = createScope(null);
      const transaction = this.#createTransaction(1, scope);
      const { failed, failure, result } = await this.#runScopedCallback(scope, () =>
        callback(transaction),
      );

      if (failed) {
        this.#state = snapshot;
        scope.rolledBack = true;
        throw failure;
      }

      return result;
    } finally {
      release();
    }
  }

  async createStore<TStore>(registration: StorageStoreRegistration<TStore>): Promise<TStore> {
    this.#assertStoreRegistration(registration);

    return registration.create(this);
  }

  #createTransaction(depth: number, scope: TransactionScope): StorageTransaction {
    const runner = this.#createRunner(scope);
    const storeScope: StorageStoreScope = {
      documents: createDocumentStore(runner, this.#now),
      links: createLinkStore(runner, this.#now),
      pluginStates: createPluginStateStore(runner, this.#now),
      migrations: createMigrationStore(runner),
      searchIndex: createSearchIndexStore(runner, this.#now, this.#searchStrategy()),
    };

    const transaction: StorageTransaction = {
      backendId: this.backendId,
      depth,
      ...storeScope,

      createStore: async <TStore>(
        registration: StorageStoreRegistration<TStore>,
      ): Promise<TStore> => {
        if (!isScopeActive(scope)) {
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

        if (!isScopeActive(scope)) {
          throw storageError("TRANSACTION_CLOSED", "Транзакция уже завершена");
        }

        const task = this.#executeSavepoint(depth + 1, scope, callback);

        return this.#track(scope, task);
      },
    };

    return transaction;
  }

  /**
   * Создаёт runner Store-операций области.
   *
   * Каждая начатая операция регистрируется в `scope.pending`. После callback
   * область запечатывается: новые операции отклоняются, а начатые дожидаются
   * через `allSettled` до commit/rollback. Проверка `active` повторяется и
   * после искусственной задержки, поэтому операция, чья задержка завершилась
   * уже после callback, не может записать данные.
   */
  #createRunner(scope: TransactionScope): StoreRunner {
    return async (operation) => {
      if (!isScopeActive(scope)) {
        throw storageError("TRANSACTION_CLOSED", "Транзакция уже завершена");
      }

      const task = (async () => {
        await this.#delay(this.#delays.operationMs);

        if (!isScopeActive(scope)) {
          throw storageError("TRANSACTION_CLOSED", "Транзакция уже завершена");
        }

        this.#assertOpen();

        return operation(this.#state);
      })();

      return this.#track(scope, task);
    };
  }

  async #executeSavepoint<T>(
    depth: number,
    parent: TransactionScope,
    callback: (transaction: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    await this.#delay(this.#delays.transactionMs);

    if (!isScopeActive(parent)) {
      throw storageError("TRANSACTION_CLOSED", "Транзакция уже завершена");
    }

    const snapshot = cloneState(this.#state);
    const child = createScope(parent);
    const childTransaction = this.#createTransaction(depth, child);
    const { failed, failure, result } = await this.#runScopedCallback(child, () =>
      callback(childTransaction),
    );

    if (failed) {
      // Родитель может быть уже sealed, но ещё не откатился: он ждёт drain
      // этой tracked child-области. Восстанавливаем свой snapshot, пока
      // фактического rollback предка не было; иначе не перезаписываем его.
      if (!hasRolledBackAncestor(parent)) {
        this.#state = snapshot;
      }

      child.rolledBack = true;
      throw failure;
    }

    return result;
  }

  /**
   * Запускает callback области, затем запечатывает область и ждёт все начатые
   * операции. Возвращает результат или ошибку callback без потери исходного
   * значения (включая `throw undefined`).
   */
  async #runScopedCallback<T>(
    scope: TransactionScope,
    callback: () => Promise<T>,
  ): Promise<{ readonly failed: boolean; readonly failure: unknown; readonly result: T }> {
    let failed = false;
    let failure: unknown;
    let result: T | undefined;

    try {
      result = await callback();
    } catch (error) {
      failed = true;
      failure = error;
    }

    scope.active = false;

    while (scope.pending.size > 0) {
      await Promise.allSettled([...scope.pending]);
    }

    return { failed, failure, result: result as T };
  }

  /**
   * Регистрирует задачу области и снимает регистрацию после завершения.
   *
   * Провайдер не подавляет reject внешнего Promise: вызывающий обязан
   * обработать возвращённое значение, как в обычном JS. Внутренняя задача
   * дожидается через `allSettled` при sealing, но это не делает внешний
   * Promise «обработанным».
   */
  async #track<T>(scope: TransactionScope, task: Promise<T>): Promise<T> {
    scope.pending.add(task);

    try {
      return await task;
    } finally {
      scope.pending.delete(task);
    }
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
