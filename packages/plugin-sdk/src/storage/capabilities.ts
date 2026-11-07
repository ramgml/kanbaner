/**
 * Явные capabilities Storage Provider.
 *
 * `transactions` обязательна для любого провайдера MVP: без неё провайдер
 * нельзя зарегистрировать как пригодный. Остальные возможности опциональны,
 * и плагин обязан проверить их до использования либо применить
 * документированный fallback.
 */
export const STORAGE_CAPABILITY_KEYS = [
  "transactions",
  "savepoints",
  "json",
  "fullTextSearch",
  "stemming",
  "onlineBackup",
  "wal",
  "watch",
] as const;

export type StorageCapability = (typeof STORAGE_CAPABILITY_KEYS)[number];

export interface StorageCapabilities {
  /** Обязательная возможность атомарных транзакций. */
  readonly transactions: boolean;
  /** Вложенные savepoint-транзакции. */
  readonly savepoints: boolean;
  /** Хранение JSON-значений без преобразования в строку на границе Store. */
  readonly json: boolean;
  /** Полнотекстовый индекс backend. */
  readonly fullTextSearch: boolean;
  /** Стемминг в полнотекстовом поиске. */
  readonly stemming: boolean;
  /** Online backup средствами провайдера. */
  readonly onlineBackup: boolean;
  /** WAL-режим backend. */
  readonly wal: boolean;
  /** Уведомления об изменениях через backend. */
  readonly watch: boolean;
}

/** Capabilities, без которых провайдер несовместим с MVP. */
export const MVP_REQUIRED_STORAGE_CAPABILITIES = ["transactions"] as const;

/**
 * Создаёт полный набор capabilities.
 *
 * По умолчанию включена только обязательная `transactions`; конкретный
 * провайдер включает остальные возможности явно.
 */
export function createStorageCapabilities(
  overrides: Partial<StorageCapabilities> = {},
): StorageCapabilities {
  return Object.freeze({
    transactions: true,
    savepoints: false,
    json: false,
    fullTextSearch: false,
    stemming: false,
    onlineBackup: false,
    wal: false,
    watch: false,
    ...overrides,
  });
}

/** Проверяет наличие конкретной возможности. */
export function hasStorageCapability(
  capabilities: StorageCapabilities,
  capability: StorageCapability,
): boolean {
  return capabilities[capability] === true;
}

/** Возвращает обязательные возможности, которых не хватает провайдеру. */
export function missingRequiredStorageCapabilities(
  capabilities: StorageCapabilities,
): readonly StorageCapability[] {
  return MVP_REQUIRED_STORAGE_CAPABILITIES.filter(
    (capability) => capabilities[capability] !== true,
  );
}

/** Проверяет пригодность набора capabilities для MVP. */
export function isMvpStorageProvider(capabilities: StorageCapabilities): boolean {
  return missingRequiredStorageCapabilities(capabilities).length === 0;
}
