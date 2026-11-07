import { assertContractId, assertPluginId } from "./common.ts";
import type { PluginDocumentStore } from "./documents.ts";
import { StorageError } from "./errors.ts";
import type { LinkStore } from "./links.ts";
import type { MigrationStore } from "./migrations.ts";
import type { PluginStateStore } from "./plugin-state.ts";
import type { SearchIndexStore } from "./search.ts";

declare const storeType: unique symbol;

/**
 * Типизированный идентификатор Store-контракта плагина.
 *
 * Контракт описывает операции уровня домена. Имена таблиц, SQL и типы
 * драйвера в него не входят.
 */
export interface StorageStoreContract<TStore> {
  readonly id: string;
  readonly version: number;
  readonly [storeType]?: TStore;
}

/**
 * Доступные Store внутри текущей области провайдера или транзакции.
 *
 * Встроенные контракты ядра уже привязаны к области: обращение через
 * транзакцию выполняется в её границе.
 */
export interface StorageStoreScope {
  readonly documents: PluginDocumentStore;
  readonly links: LinkStore;
  readonly pluginStates: PluginStateStore;
  readonly migrations: MigrationStore;
  readonly searchIndex: SearchIndexStore;
}

/**
 * Реализация Store-контракта, которую регистрирует провайдер или плагин.
 *
 * `create` получает область и возвращает объект, операции которого обязаны
 * быть асинхронными.
 */
export interface StorageStoreRegistration<TStore> {
  readonly contract: StorageStoreContract<TStore>;
  create(scope: StorageStoreScope): TStore | Promise<TStore>;
}

/** Создаёт и валидирует идентификатор Store-контракта. */
export function defineStorageStore<TStore>(
  id: string,
  version: number,
): StorageStoreContract<TStore> {
  assertContractId(id);

  if (!Number.isInteger(version) || version < 1) {
    throw new StorageError(
      "INVALID_ARGUMENT",
      "Версия Store-контракта должна быть целым числом ≥ 1",
    );
  }

  return Object.freeze({ id, version });
}

/** Проверяет идентификатор плагина в контракте Store. */
export function definePluginStore<TStore>(
  pluginId: string,
  id: string,
  version: number,
): StorageStoreContract<TStore> {
  assertPluginId(pluginId);

  return defineStorageStore<TStore>(id, version);
}

/** Встроенные Store-контракты ядра. */
export const CORE_STORAGE_STORES = Object.freeze({
  documents: defineStorageStore<PluginDocumentStore>("kanbaner.core.documents.v1", 1),
  links: defineStorageStore<LinkStore>("kanbaner.core.resource-links.v1", 1),
  pluginStates: defineStorageStore<PluginStateStore>("kanbaner.core.plugin-states.v1", 1),
  migrations: defineStorageStore<MigrationStore>("kanbaner.core.migrations.v1", 1),
  searchIndex: defineStorageStore<SearchIndexStore>("kanbaner.core.search-index.v1", 1),
});
