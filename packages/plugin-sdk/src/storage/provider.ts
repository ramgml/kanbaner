import type { JsonObject } from "../json.ts";
import type { StorageCapabilities } from "./capabilities.ts";
import type { BackendId } from "./common.ts";
import type { UtcTimestamp } from "./time.ts";
import type {
  StorageStoreContract,
  StorageStoreRegistration,
  StorageStoreScope,
} from "./stores.ts";

/** Результат проверки здоровья открытого backend. */
export interface StorageHealth {
  readonly ok: boolean;
  readonly backendId: BackendId;
  readonly checkedAt: UtcTimestamp;
  readonly details?: JsonObject;
}

export interface StorageProviderInfo {
  readonly backendId: BackendId;
  readonly capabilities: StorageCapabilities;
}

/**
 * Транзакционная область провайдера.
 *
 * Все операции Store внутри области участвуют в текущей транзакции.
 */
export interface StorageTransaction extends StorageStoreScope {
  readonly backendId: BackendId;
  /** Глубина вложенности: 1 для корневой транзакции. */
  readonly depth: number;
  /**
   * Вложенная транзакция через savepoint.
   *
   * Требует capability `savepoints`; без неё возвращает структурированную
   * ошибку `SAVEPOINTS_UNSUPPORTED`.
   */
  withSavepoint<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T>;
  /** Создаёт Store, привязанный к текущей транзакции. */
  createStore<TStore>(registration: StorageStoreRegistration<TStore>): Promise<TStore>;
}

/**
 * Storage Provider.
 *
 * Провайдер управляет соединением с backend; доменный и UI-плагин не
 * открывает собственное соединение. Публичные операции асинхронны.
 */
export interface StorageProvider extends StorageStoreScope {
  readonly backendId: BackendId;
  readonly capabilities: StorageCapabilities;
  /** Открывает backend. Повторный вызов идемпотентен. */
  open(): Promise<void>;
  /** Закрывает backend. Повторный вызов идемпотентен. */
  close(): Promise<void>;
  /** Проверяет доступность открытого backend. */
  healthCheck(): Promise<StorageHealth>;
  /**
   * Выполняет callback в транзакции.
   *
   * Граница остаётся открытой до завершения async callback. Rejected Promise
   * откатывает транзакцию. Транзакция монополизирует соединение: операции
   * других вызовов ждут и не попадают в чужую транзакцию.
   */
  withTransaction<T>(callback: (transaction: StorageTransaction) => Promise<T>): Promise<T>;
  /** Создаёт Store, привязанный к провайдеру (вне транзакции). */
  createStore<TStore>(registration: StorageStoreRegistration<TStore>): Promise<TStore>;
}

/** Проверяет, что контракт относится к ожидаемому Store. */
export function isSameStoreContract<TStore>(
  left: StorageStoreContract<TStore>,
  right: StorageStoreContract<TStore>,
): boolean {
  return left.id === right.id && left.version === right.version;
}

/**
 * Публичный контракт реестра Storage Provider.
 *
 * Регистрация и жизненный цикл — операции уровня bootstrap; операции Store
 * асинхронны. Реализация находится в ядре.
 */
export interface StorageProviderRegistry {
  register(provider: StorageProvider): void;
  has(backendId: BackendId): boolean;
  get(backendId: BackendId): StorageProvider;
  list(): readonly StorageProviderInfo[];
  capabilitiesOf(backendId: BackendId): StorageCapabilities;
  open(backendId: BackendId): Promise<StorageProvider>;
  close(backendId: BackendId): Promise<void>;
  healthCheck(backendId: BackendId): Promise<StorageHealth>;
  getActive(): StorageProvider;
  registerStore<TStore>(backendId: BackendId, registration: StorageStoreRegistration<TStore>): void;
  createStore<TStore>(
    backendId: BackendId,
    contract: StorageStoreContract<TStore>,
  ): Promise<TStore>;
}
