import {
  parseResourceRef,
  toSearchDocument,
  type PluginId,
  type ResourceRef,
  type SearchDocumentInput,
  type SearchHit,
  type SearchIndexDocument,
  type SearchQuery,
  type SearchRegistrar,
  type StorageProvider,
} from "@kanbaner/plugin-sdk";

import { OperationFailure } from "../operations/errors.ts";

function denied(): OperationFailure {
  return new OperationFailure("PERMISSION_DENIED", "Поисковый индекс другого плагина недоступен");
}

function assertRefOwnedBy(ref: ResourceRef, pluginId: PluginId): void {
  const parts = parseResourceRef(ref);

  if (parts.pluginId !== pluginId) {
    throw denied();
  }
}

interface PluginQueue {
  tail: Promise<void>;
}

/**
 * Хост-реализация поискового контракта поверх активного Storage Provider.
 *
 * Каждая операция принимает ответственный pluginId от доверенного runtime.
 * Плагин получает только bound-фасад `PluginSearchService`.
 *
 * Мутации одного plugin ID сериализуются в памяти сервиса, а reindex читает
 * foreign-документы и заменяет индекс внутри одной транзакции provider-а.
 * Поэтому параллельный upsert/delete того же плагина не может потеряться
 * между чтением и заменой.
 */
export class KernelSearchService implements SearchRegistrar {
  readonly #provider: StorageProvider;
  readonly #queues = new Map<PluginId, PluginQueue>();

  constructor(provider: StorageProvider) {
    this.#provider = provider;
  }

  async upsert(pluginId: PluginId, documents: readonly SearchDocumentInput[]): Promise<number> {
    const normalized = documents.map((document) => toSearchDocument(pluginId, document));

    if (normalized.length === 0) {
      return 0;
    }

    return this.#enqueue(pluginId, async () => {
      await this.#provider.searchIndex.upsert(normalized);

      return normalized.length;
    });
  }

  async delete(pluginId: PluginId, ref: ResourceRef): Promise<boolean> {
    assertRefOwnedBy(ref, pluginId);

    return this.#enqueue(pluginId, () => this.#provider.searchIndex.delete(ref));
  }

  async list(pluginId: PluginId): Promise<readonly SearchIndexDocument[]> {
    const documents = await this.#provider.searchIndex.list();

    return documents.filter((document) => document.pluginId === pluginId);
  }

  async search(
    pluginId: PluginId,
    query: Omit<SearchQuery, "pluginId">,
  ): Promise<readonly SearchHit[]> {
    return this.#provider.searchIndex.search({ ...query, pluginId });
  }

  /**
   * Полностью переиндексирует документы одного плагина.
   *
   * Чтение foreign-документов и замена индекса выполняются внутри одной
   * исключительной транзакции provider-а. Остальные мутации ждут её коммита,
   * поэтому чужой namespace сохраняется, а параллельная запись не теряется.
   * Возвращается количество нормализованных документов плагина, а не raw count
   * backend-а.
   */
  async reindex(pluginId: PluginId, documents: readonly SearchDocumentInput[]): Promise<number> {
    const normalized = documents.map((document) => toSearchDocument(pluginId, document));

    return this.#enqueue(pluginId, () =>
      this.#provider.withTransaction(async (transaction) => {
        const existing = await transaction.searchIndex.list();
        const foreign = existing.filter((document) => document.pluginId !== pluginId);

        await transaction.searchIndex.reindex([...foreign, ...normalized]);

        return normalized.length;
      }),
    );
  }

  #enqueue<T>(pluginId: PluginId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(pluginId)?.tail ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );

    this.#queues.set(pluginId, { tail });

    void tail.then(() => {
      if (this.#queues.get(pluginId)?.tail === tail) {
        this.#queues.delete(pluginId);
      }
    });

    return current;
  }
}

export function createSearchService(provider: StorageProvider): SearchRegistrar {
  return new KernelSearchService(provider);
}
