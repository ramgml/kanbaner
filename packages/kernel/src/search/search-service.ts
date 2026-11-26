import {
  parseResourceRef,
  toSearchDocument,
  type PluginId,
  type ResourceRef,
  type SearchAggregateResult,
  type SearchAggregateWarning,
  type SearchDocumentInput,
  type SearchFacetSet,
  type SearchFilter,
  type SearchHit,
  type SearchIndexDocument,
  type SearchProvider,
  type SearchProviderFacet,
  type SearchProviderKind,
  type SearchProviderQuery,
  type SearchQuery,
  type SearchRegistrar,
  type StorageProvider,
} from "@kanbaner/plugin-sdk";

import { OperationFailure } from "../operations/errors.ts";

const DEFAULT_AGGREGATE_LIMIT = 20;
const MAX_AGGREGATE_LIMIT = 100;
const MAX_AGGREGATE_PAGE = 1000;
const MAX_FILTERS = 10;
const MAX_FILTER_FIELD_LENGTH = 64;
const MAX_FILTER_VALUE_LENGTH = 200;
const MAX_QUERY_TEXT_LENGTH = 500;
const FILTER_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;

function denied(): OperationFailure {
  return new OperationFailure("PERMISSION_DENIED", "Поисковый индекс другого плагина недоступен");
}

function invalid(message: string): OperationFailure {
  return new OperationFailure("VALIDATION_ERROR", message);
}

function assertRefOwnedBy(ref: ResourceRef, pluginId: PluginId): void {
  const parts = parseResourceRef(ref);

  if (parts.pluginId !== pluginId) {
    throw denied();
  }
}

function assertNonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw invalid(`Поле ${label} должно быть непустой строкой длиной до ${String(maxLength)}`);
  }

  return value;
}

function validateFilters(filters: readonly SearchFilter[] | undefined): readonly SearchFilter[] {
  if (filters === undefined) {
    return [];
  }

  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) {
    throw invalid(`Количество фильтров не может превышать ${String(MAX_FILTERS)}`);
  }

  return filters.map((filter) => {
    if (
      typeof filter.field !== "string" ||
      !FILTER_FIELD_PATTERN.test(filter.field) ||
      filter.field.length > MAX_FILTER_FIELD_LENGTH
    ) {
      throw invalid("Поле фильтра имеет недопустимый формат");
    }

    if (filter.operator !== "eq" && filter.operator !== "contains") {
      throw invalid("Оператор фильтра должен быть eq или contains");
    }

    if (
      typeof filter.value !== "string" ||
      filter.value.length === 0 ||
      filter.value.length > MAX_FILTER_VALUE_LENGTH
    ) {
      throw invalid(
        `Значение фильтра должно быть непустой строкой длиной до ${String(MAX_FILTER_VALUE_LENGTH)}`,
      );
    }

    return { field: filter.field, operator: filter.operator, value: filter.value };
  });
}

function validateProvider(pluginId: PluginId, provider: SearchProvider): void {
  if (provider.id !== pluginId) {
    throw denied();
  }

  if (!Array.isArray(provider.kinds) || provider.kinds.length === 0) {
    throw invalid("Поисковый провайдер должен объявить хотя бы один тип");
  }

  if (!Array.isArray(provider.filterFields)) {
    throw invalid("filterFields поискового провайдера должен быть массивом");
  }

  const kindIds = new Set<string>();

  for (const kind of provider.kinds) {
    assertNonEmptyString(kind.id, "kind.id", 64);
    assertNonEmptyString(kind.title, "kind.title", 200);

    if (kindIds.has(kind.id)) {
      throw invalid(`Тип ${kind.id} объявлен дважды`);
    }

    kindIds.add(kind.id);
  }

  const fields = new Set<string>();

  for (const field of provider.filterFields) {
    if (!FILTER_FIELD_PATTERN.test(field) || field.length > MAX_FILTER_FIELD_LENGTH) {
      throw invalid("Поле фильтра провайдера имеет недопустимый формат");
    }

    if (fields.has(field)) {
      throw invalid(`Поле фильтра ${field} объявлено дважды`);
    }

    fields.add(field);
  }
}

function compareHits(left: SearchHit, right: SearchHit): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
}

function mergeKinds(providers: readonly SearchProvider[]): readonly SearchProviderKind[] {
  const merged = new Map<string, SearchProviderKind>();

  // Типы статичны и доступны без вызова провайдера. Ошибка получения facet-ов
  // не скрывает типы: пользователь всё равно может искать по тексту.
  for (const provider of providers) {
    for (const kind of provider.kinds) {
      if (!merged.has(kind.id)) {
        merged.set(kind.id, { ...kind });
      }
    }
  }

  return [...merged.values()].sort((left, right) =>
    left.title < right.title ? -1 : left.title > right.title ? 1 : 0,
  );
}

function mergeFacets(
  entries: readonly (readonly SearchProviderFacet[])[],
): readonly SearchProviderFacet[] {
  const merged = new Map<
    string,
    {
      id: string;
      title: string;
      operators: Set<SearchProviderFacet["operators"][number]>;
      values: Map<string, { value: string; label: string }>;
    }
  >();

  for (const facets of entries) {
    for (const facet of facets) {
      const existing = merged.get(facet.id);

      if (existing === undefined) {
        merged.set(facet.id, {
          id: facet.id,
          title: facet.title,
          operators: new Set(facet.operators),
          values: new Map(facet.values.map((value) => [value.value, { ...value }])),
        });
        continue;
      }

      for (const operator of facet.operators) {
        existing.operators.add(operator);
      }

      for (const value of facet.values) {
        if (!existing.values.has(value.value)) {
          existing.values.set(value.value, { ...value });
        }
      }
    }
  }

  return [...merged.values()]
    .map((facet) => ({
      id: facet.id,
      title: facet.title,
      operators: [...facet.operators].sort(),
      values: [...facet.values.values()].sort((left, right) =>
        left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
      ),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
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
 *
 * SearchProvider Registry хранит только доверенные объекты активных плагинов.
 * Агрегатор не читает их namespace: он вызывает объявленный `search`, сам
 * применяет bounded pagination и не пропускает чужие ResourceRef.
 */
export class KernelSearchService implements SearchRegistrar {
  readonly #provider: StorageProvider;
  readonly #queues = new Map<PluginId, PluginQueue>();
  readonly #providers = new Map<PluginId, SearchProvider>();

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

  registerProvider(pluginId: PluginId, provider: SearchProvider): void {
    validateProvider(pluginId, provider);

    if (this.#providers.has(pluginId)) {
      throw invalid(`Поисковый провайдер ${pluginId} уже зарегистрирован`);
    }

    this.#providers.set(pluginId, provider);
  }

  unregisterProviders(pluginId: PluginId): void {
    this.#providers.delete(pluginId);
  }

  async aggregate(query: SearchProviderQuery): Promise<SearchAggregateResult> {
    const text = assertNonEmptyString(query.text, "text", MAX_QUERY_TEXT_LENGTH);
    const filters = validateFilters(query.filters);
    const limit = query.limit ?? DEFAULT_AGGREGATE_LIMIT;
    const offset = query.offset ?? 0;

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AGGREGATE_LIMIT) {
      throw invalid(`limit должен быть целым числом от 1 до ${String(MAX_AGGREGATE_LIMIT)}`);
    }

    if (!Number.isInteger(offset) || offset < 0 || offset + limit > MAX_AGGREGATE_PAGE) {
      throw invalid(
        `offset должен быть целым числом ≥ 0; offset + limit ≤ ${String(MAX_AGGREGATE_PAGE)}`,
      );
    }

    const requestedKinds = query.kinds === undefined ? [] : query.kinds;

    if (!Array.isArray(requestedKinds)) {
      throw invalid("kinds должен быть массивом");
    }

    for (const kind of requestedKinds) {
      assertNonEmptyString(kind, "kinds[]", 64);
    }

    const allProviders = [...this.#providers.values()];

    if (requestedKinds.length > 0) {
      const knownKinds = new Set(
        allProviders.flatMap((provider) => provider.kinds.map((kind) => kind.id)),
      );
      const unknown = requestedKinds.find((kind) => !knownKinds.has(kind));

      if (unknown !== undefined) {
        throw invalid(`Неизвестный тип поиска: ${unknown}`);
      }
    }

    const declaredFilterFields = new Set(allProviders.flatMap((provider) => provider.filterFields));

    for (const filter of filters) {
      if (!declaredFilterFields.has(filter.field)) {
        throw invalid(`Неизвестный фильтр поиска: ${filter.field}`);
      }
    }

    if (allProviders.length === 0) {
      return { hits: [], hasMore: false, warnings: [] };
    }

    const requestedKindSet = new Set(requestedKinds);
    const selected = allProviders.filter((provider) => {
      if (
        requestedKindSet.size > 0 &&
        !provider.kinds.some((kind) => requestedKindSet.has(kind.id))
      ) {
        return false;
      }

      return filters.every((filter) => provider.filterFields.includes(filter.field));
    });

    if (selected.length === 0) {
      return { hits: [], hasMore: false, warnings: [] };
    }

    const fetchLimit = Math.min(offset + limit + 1, MAX_AGGREGATE_PAGE);
    const settled = await Promise.allSettled(
      selected.map((provider) =>
        provider.search({
          text,
          ...(requestedKinds.length === 0 ? {} : { kinds: requestedKinds }),
          ...(filters.length === 0 ? {} : { filters }),
          limit: fetchLimit,
          offset: 0,
        }),
      ),
    );
    const warnings: SearchAggregateWarning[] = [];
    const collected: SearchHit[] = [];
    let rejected = 0;

    settled.forEach((result, index) => {
      const provider = selected[index];

      if (provider === undefined) {
        return;
      }

      if (result.status === "rejected") {
        rejected += 1;
        warnings.push({ providerId: provider.id, code: "provider_failed" });
        return;
      }

      for (const hit of result.value) {
        try {
          if (parseResourceRef(hit.ref).pluginId !== provider.id) {
            warnings.push({ providerId: provider.id, code: "foreign_ref" });
            continue;
          }
        } catch {
          warnings.push({ providerId: provider.id, code: "foreign_ref" });
          continue;
        }

        collected.push(hit);
      }
    });

    if (rejected === selected.length) {
      throw new OperationFailure("DEPENDENCY_UNAVAILABLE", "Все поисковые провайдеры недоступны");
    }

    const seen = new Set<string>();
    const merged: SearchHit[] = [];

    for (const hit of collected.sort(compareHits)) {
      if (seen.has(hit.ref)) {
        continue;
      }

      seen.add(hit.ref);
      merged.push(hit);
    }

    return {
      hits: merged.slice(offset, offset + limit),
      // Следующая страница должна начинаться внутри окна выдачи: при
      // offset + limit === MAX_AGGREGATE_PAGE продолжение уже недоступно,
      // иначе UI запросил бы недопустимый offset + limit > MAX_AGGREGATE_PAGE.
      hasMore: merged.length > offset + limit && offset + limit < MAX_AGGREGATE_PAGE,
      warnings,
    };
  }

  async listFacets(): Promise<SearchFacetSet> {
    const providers = [...this.#providers.values()];
    const warnings: SearchAggregateWarning[] = [];

    if (providers.length === 0) {
      return { kinds: [], facets: [], warnings };
    }

    const settled = await Promise.allSettled(providers.map((provider) => provider.listFacets()));
    const facetEntries: SearchProviderFacet[][] = [];

    settled.forEach((result, index) => {
      const provider = providers[index];

      if (provider === undefined) {
        return;
      }

      if (result.status === "rejected") {
        warnings.push({ providerId: provider.id, code: "provider_failed" });
        return;
      }

      facetEntries.push([...result.value]);
    });

    return {
      kinds: mergeKinds(providers),
      facets: mergeFacets(facetEntries),
      warnings,
    };
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
