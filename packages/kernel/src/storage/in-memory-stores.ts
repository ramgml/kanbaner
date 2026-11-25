import {
  validateJsonValue,
  validateRelation,
  validateResourceLink,
  validateResourceRef,
  validateUtcTimestamp,
} from "@kanbaner/plugin-sdk";
import type { JsonObject, ResourceLink } from "@kanbaner/plugin-sdk";

import type {
  AppliedMigration,
  LinkStore,
  LinkStoreAddResult,
  MigrationStore,
  PluginDocument,
  PluginDocumentSort,
  PluginDocumentStore,
  PluginStateRecord,
  PluginStateStore,
  SearchHit,
  SearchFilter,
  SearchIndexDocument,
  SearchIndexStore,
  SearchIndexStrategy,
} from "./contracts.ts";
import { storageError } from "./errors.ts";
import {
  documentKey,
  linkKey,
  migrationKey,
  type InMemoryState,
  type StoreRunner,
} from "./in-memory-state.ts";
import {
  assertApplicationId,
  assertBackendId,
  assertCollectionName,
  assertExpectedVersion,
  assertJsonObject,
  assertJsonValue,
  assertPageNumber,
  assertPluginIdValue,
  assertPluginVersion,
  assertPositiveVersion,
  assertUtcTimestamp,
  cloneJson,
  currentUtcTimestamp,
} from "./validation.ts";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

function assertOptionalExpectedVersion(value: number | undefined): void {
  if (value !== undefined) {
    assertExpectedVersion(value);
  }
}

function assertPageSize(value: number | undefined, label: string): void {
  if (value !== undefined) {
    assertPageNumber(value, label);

    if (value > MAX_PAGE_SIZE) {
      throw storageError("INVALID_ARGUMENT", `Поле ${label} не может превышать ${MAX_PAGE_SIZE}`);
    }
  }
}

function assertResourceRefValue(value: unknown, label: string): void {
  if (!validateResourceRef(value).ok) {
    throw storageError("INVALID_ARGUMENT", `Поле ${label} должно быть ResourceRef`);
  }
}

function assertRelationValue(value: unknown): void {
  if (!validateRelation(value).ok) {
    throw storageError("INVALID_ARGUMENT", "Некорректный тип связи");
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function compareDocuments(left: PluginDocument, right: PluginDocument): number {
  return (
    compareStrings(left.pluginId, right.pluginId) ||
    compareStrings(left.collection, right.collection) ||
    compareStrings(left.id, right.id)
  );
}

function sortDocuments(
  documents: readonly PluginDocument[],
  sort: PluginDocumentSort | undefined,
): readonly PluginDocument[] {
  const field = sort?.field ?? "id";
  const direction = sort?.direction ?? "asc";
  const multiplier = direction === "desc" ? -1 : 1;

  return [...documents].sort((left, right) => {
    const primary =
      field === "id"
        ? compareStrings(left.id, right.id)
        : compareStrings(left[field], right[field]);

    if (primary !== 0) {
      return primary * multiplier;
    }

    return compareDocuments(left, right) * multiplier;
  });
}

function matchesIndexedFields(document: PluginDocument, filter: JsonObject | undefined): boolean {
  if (filter === undefined) {
    return true;
  }

  return Object.entries(filter).every(
    ([key, value]) =>
      document.indexedFields !== undefined &&
      JSON.stringify(document.indexedFields[key]) === JSON.stringify(value),
  );
}

function cloneDocument(document: PluginDocument): PluginDocument {
  return cloneJson(document);
}

function cloneLink(link: ResourceLink): ResourceLink {
  return cloneJson(link);
}

function compareLinks(left: ResourceLink, right: ResourceLink): number {
  return (
    compareStrings(left.sourceRef, right.sourceRef) ||
    compareStrings(left.targetRef, right.targetRef) ||
    compareStrings(left.relation, right.relation)
  );
}

function compareStates(left: PluginStateRecord, right: PluginStateRecord): number {
  return compareStrings(left.pluginId, right.pluginId);
}

function compareMigrations(left: AppliedMigration, right: AppliedMigration): number {
  return (
    compareStrings(left.backendId, right.backendId) ||
    compareStrings(left.pluginId, right.pluginId) ||
    left.version - right.version
  );
}

/** Создаёт Store документов, привязанный к области выполнения. */
export function createDocumentStore(run: StoreRunner, now: () => Date): PluginDocumentStore {
  return {
    async get(pluginId, collection, id) {
      assertPluginIdValue(pluginId);
      assertCollectionName(collection);
      assertApplicationId(id);

      return run((state) => {
        const document = state.documents.get(documentKey(pluginId, collection, id));

        return document === undefined ? null : cloneDocument(document);
      });
    },

    async put(input) {
      assertPluginIdValue(input.pluginId);
      assertCollectionName(input.collection);
      assertApplicationId(input.id);
      assertJsonValue(input.data, "data");
      assertOptionalExpectedVersion(input.expectedVersion);

      if (input.indexedFields !== undefined) {
        assertJsonObject(input.indexedFields, "indexedFields");
      }

      return run((state) => {
        const key = documentKey(input.pluginId, input.collection, input.id);
        const existing = state.documents.get(key);
        const timestamp = currentUtcTimestamp(now);

        if (existing === undefined) {
          if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
            throw storageError("VERSION_CONFLICT", "Документ не существует или версия устарела");
          }

          const created = buildDocument(input, 1, timestamp, timestamp);
          state.documents.set(key, created);

          return cloneDocument(created);
        }

        if (input.expectedVersion === undefined || input.expectedVersion !== existing.version) {
          throw storageError("VERSION_CONFLICT", "Версия документа изменилась");
        }

        const updated = buildDocument(input, existing.version + 1, existing.createdAt, timestamp);
        state.documents.set(key, updated);

        return cloneDocument(updated);
      });
    },

    async delete(pluginId, collection, id, options) {
      assertPluginIdValue(pluginId);
      assertCollectionName(collection);
      assertApplicationId(id);
      assertOptionalExpectedVersion(options?.expectedVersion);

      return run((state) => {
        const key = documentKey(pluginId, collection, id);
        const existing = state.documents.get(key);

        if (existing === undefined) {
          return false;
        }

        if (
          options?.expectedVersion !== undefined &&
          options.expectedVersion !== existing.version
        ) {
          throw storageError("VERSION_CONFLICT", "Версия документа изменилась");
        }

        state.documents.delete(key);

        return true;
      });
    },

    async query(query) {
      assertPluginIdValue(query.pluginId);
      assertPageSize(query.limit, "limit");
      assertPageNumber(query.offset ?? 0, "offset");

      if (query.collection !== undefined) {
        assertCollectionName(query.collection);
      }

      if (query.indexedFields !== undefined) {
        assertJsonObject(query.indexedFields, "indexedFields");
      }

      const ids = query.ids;

      if (ids !== undefined) {
        for (const id of ids) {
          assertApplicationId(id);
        }
      }

      return run((state) => {
        const idSet = ids === undefined ? undefined : new Set(ids);
        const documents = [...state.documents.values()].filter(
          (document) =>
            document.pluginId === query.pluginId &&
            (query.collection === undefined || document.collection === query.collection) &&
            (idSet === undefined || idSet.has(document.id)) &&
            matchesIndexedFields(document, query.indexedFields),
        );
        const sorted = sortDocuments(documents, query.sort);
        const offset = query.offset ?? 0;
        const limit = query.limit ?? DEFAULT_PAGE_SIZE;

        return sorted.slice(offset, offset + limit).map(cloneDocument);
      });
    },

    async list(pluginId, collection) {
      assertPluginIdValue(pluginId);

      if (collection !== undefined) {
        assertCollectionName(collection);
      }

      return run((state) =>
        [...state.documents.values()]
          .filter(
            (document) =>
              document.pluginId === pluginId &&
              (collection === undefined || document.collection === collection),
          )
          .sort(compareDocuments)
          .map(cloneDocument),
      );
    },
  };
}

function buildDocument(
  input: {
    readonly pluginId: string;
    readonly collection: string;
    readonly id: string;
    readonly data: unknown;
    readonly indexedFields?: JsonObject;
  },
  version: number,
  createdAt: string,
  updatedAt: string,
): PluginDocument {
  const document: {
    pluginId: string;
    collection: string;
    id: string;
    version: number;
    data: PluginDocument["data"];
    indexedFields?: JsonObject;
    createdAt: string;
    updatedAt: string;
  } = {
    pluginId: input.pluginId,
    collection: input.collection,
    id: input.id,
    version,
    data: cloneJson(input.data) as PluginDocument["data"],
    createdAt,
    updatedAt,
  };

  if (input.indexedFields !== undefined) {
    document.indexedFields = cloneJson(input.indexedFields);
  }

  return document;
}

/** Создаёт Store универсальных связей. */
export function createLinkStore(run: StoreRunner, now: () => Date): LinkStore {
  return {
    async add(link) {
      const validation = validateResourceLink(link);

      if (!validation.ok) {
        throw storageError("INVALID_ARGUMENT", "Некорректная связь ресурсов");
      }

      const createdAt = link.createdAt ?? currentUtcTimestamp(now);

      if (!validateUtcTimestamp(createdAt).ok) {
        throw storageError("INVALID_ARGUMENT", "createdAt связи должен быть UTC timestamp");
      }

      const storedLink: ResourceLink = {
        sourceRef: link.sourceRef,
        targetRef: link.targetRef,
        relation: link.relation,
        createdAt,
      };

      return run((state): LinkStoreAddResult => {
        const key = linkKey(link.sourceRef, link.targetRef, link.relation);
        const existing = state.links.get(key);

        if (existing !== undefined) {
          return { inserted: false, link: cloneLink(existing) };
        }

        state.links.set(key, cloneLink(storedLink));

        return { inserted: true, link: cloneLink(storedLink) };
      });
    },

    async remove(sourceRef, targetRef, relation) {
      assertResourceRefValue(sourceRef, "sourceRef");
      assertResourceRefValue(targetRef, "targetRef");
      assertRelationValue(relation);

      return run((state) => state.links.delete(linkKey(sourceRef, targetRef, relation)));
    },

    async listByRef(ref, relation) {
      assertResourceRefValue(ref, "ref");

      if (relation !== undefined) {
        assertRelationValue(relation);
      }

      return run((state) =>
        [...state.links.values()]
          .filter(
            (link) =>
              (link.sourceRef === ref || link.targetRef === ref) &&
              (relation === undefined || link.relation === relation),
          )
          .sort(compareLinks)
          .map(cloneLink),
      );
    },

    async deleteByRef(ref) {
      assertResourceRefValue(ref, "ref");

      return run((state) => {
        let removed = 0;

        for (const [key, link] of state.links) {
          if (link.sourceRef === ref || link.targetRef === ref) {
            state.links.delete(key);
            removed += 1;
          }
        }

        return removed;
      });
    },
  };
}

/** Создаёт Store состояния плагинов. */
export function createPluginStateStore(run: StoreRunner, now: () => Date): PluginStateStore {
  return {
    async get(pluginId) {
      assertPluginIdValue(pluginId);

      return run((state) => {
        const record = state.pluginStates.get(pluginId);

        return record === undefined ? null : cloneJson(record);
      });
    },

    async put(input) {
      assertPluginIdValue(input.pluginId);
      assertPluginVersion(input.version);
      assertJsonObject(input.state, "state");

      if (typeof input.enabled !== "boolean") {
        throw storageError("INVALID_ARGUMENT", "Поле enabled должно быть boolean");
      }

      return run((state) => {
        const record: PluginStateRecord = {
          pluginId: input.pluginId,
          version: input.version,
          enabled: input.enabled,
          state: cloneJson(input.state),
          updatedAt: currentUtcTimestamp(now),
        };

        state.pluginStates.set(input.pluginId, record);

        return cloneJson(record);
      });
    },

    async delete(pluginId) {
      assertPluginIdValue(pluginId);

      return run((state) => state.pluginStates.delete(pluginId));
    },

    async list() {
      return run((state) =>
        [...state.pluginStates.values()].sort(compareStates).map((record) => cloneJson(record)),
      );
    },
  };
}

function assertChecksum(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw storageError("INVALID_ARGUMENT", "checksum миграции должен быть SHA-256 hex");
  }
}

function validateMigration(migration: AppliedMigration): void {
  assertBackendId(migration.backendId);
  assertPluginIdValue(migration.pluginId);
  assertPositiveVersion(migration.version, "version");
  assertChecksum(migration.checksum);
  assertUtcTimestamp(migration.appliedAt, "appliedAt");

  if (typeof migration.name !== "string" || migration.name.trim().length === 0) {
    throw storageError("INVALID_ARGUMENT", "Имя миграции не может быть пустым");
  }
}

/** Создаёт Store журнала миграций. */
export function createMigrationStore(run: StoreRunner): MigrationStore {
  return {
    async list(backendId) {
      if (backendId !== undefined) {
        assertBackendId(backendId);
      }

      return run((state) =>
        [...state.migrations.values()]
          .filter((migration) => backendId === undefined || migration.backendId === backendId)
          .sort(compareMigrations)
          .map((migration) => cloneJson(migration)),
      );
    },

    async find(backendId, pluginId, version) {
      assertBackendId(backendId);
      assertPluginIdValue(pluginId);
      assertPositiveVersion(version, "version");

      return run((state) => {
        const migration = state.migrations.get(migrationKey(backendId, pluginId, version));

        return migration === undefined ? null : cloneJson(migration);
      });
    },

    async record(migration) {
      validateMigration(migration);

      return run((state) => {
        const key = migrationKey(migration.backendId, migration.pluginId, migration.version);
        const existing = state.migrations.get(key);

        if (existing !== undefined) {
          if (existing.checksum !== migration.checksum) {
            throw storageError(
              "MIGRATION_CHECKSUM_MISMATCH",
              "Checksum применённой миграции не совпадает",
            );
          }

          return;
        }

        state.migrations.set(key, cloneJson(migration));
      });
    },
  };
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function tokenize(value: string): readonly string[] {
  return normalizeSearchText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function makeExcerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 80);

  return text.slice(start, end);
}

function validateSearchDocument(document: SearchIndexDocument): void {
  assertResourceRefValue(document.ref, "ref");
  assertPluginIdValue(document.pluginId);

  if (typeof document.title !== "string" || document.title.trim().length === 0) {
    throw storageError("INVALID_ARGUMENT", "Заголовок поискового документа не может быть пустым");
  }

  if (typeof document.text !== "string") {
    throw storageError("INVALID_ARGUMENT", "Текст поискового документа должен быть строкой");
  }

  if (document.kind !== undefined && typeof document.kind !== "string") {
    throw storageError("INVALID_ARGUMENT", "kind поискового документа должен быть строкой");
  }

  if (document.updatedAt !== undefined) {
    assertUtcTimestamp(document.updatedAt, "updatedAt");
  }

  if (document.metadata !== undefined) {
    assertJsonObject(document.metadata, "metadata");
  }
}

function compareSearchDocuments(left: SearchIndexDocument, right: SearchIndexDocument): number {
  return compareStrings(left.ref, right.ref);
}

const SEARCH_FILTER_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const MAX_SEARCH_FILTERS = 10;
const MAX_SEARCH_FILTER_VALUE_LENGTH = 200;

function assertSearchFilters(filters: readonly SearchFilter[] | undefined): void {
  if (filters === undefined) {
    return;
  }

  if (!Array.isArray(filters) || filters.length > MAX_SEARCH_FILTERS) {
    throw storageError(
      "INVALID_ARGUMENT",
      `Количество фильтров поиска не может превышать ${String(MAX_SEARCH_FILTERS)}`,
    );
  }

  for (const filter of filters) {
    if (
      typeof filter.field !== "string" ||
      !SEARCH_FILTER_FIELD_PATTERN.test(filter.field) ||
      filter.field.length > 64
    ) {
      throw storageError("INVALID_ARGUMENT", "Поле фильтра поиска имеет недопустимый формат");
    }

    if (filter.operator !== "eq" && filter.operator !== "contains") {
      throw storageError("INVALID_ARGUMENT", "Оператор фильтра поиска должен быть eq или contains");
    }

    if (
      typeof filter.value !== "string" ||
      filter.value.length === 0 ||
      filter.value.length > MAX_SEARCH_FILTER_VALUE_LENGTH
    ) {
      throw storageError(
        "INVALID_ARGUMENT",
        `Значение фильтра поиска должно быть строкой длиной до ${String(MAX_SEARCH_FILTER_VALUE_LENGTH)}`,
      );
    }
  }
}

/**
 * Семантика metadata-фильтров SearchProvider.
 *
 * - `eq` сравнивает только строковый scalar: точное совпадение.
 * - `contains` для строки — подстрока, для массива — точное совпадение
 *   строкового элемента.
 * - object, number, boolean и null не участвуют в фильтрах и не матчатся.
 *
 * Та же семантика реализована SQLite-провайдером; расхождение закрыто
 * Conformance Suite.
 */
function metadataMatches(document: SearchIndexDocument, filter: SearchFilter): boolean {
  const value = document.metadata?.[filter.field];

  if (filter.operator === "eq") {
    return typeof value === "string" && value === filter.value;
  }

  if (typeof value === "string") {
    return value.includes(filter.value);
  }

  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && item === filter.value);
  }

  return false;
}

function matchScore(
  document: SearchIndexDocument,
  query: string,
  strategy: SearchIndexStrategy,
): { readonly score: number; readonly index: number } | null {
  const text = `${document.title}\n${document.text}`;
  const normalized = normalizeSearchText(text);

  if (strategy === "substring") {
    const needle = normalizeSearchText(query.trim());

    if (needle.length === 0) {
      return null;
    }

    const index = normalized.indexOf(needle);

    return index < 0 ? null : { score: 1, index };
  }

  const tokens = tokenize(query);

  if (tokens.length === 0) {
    return null;
  }

  const haystack = tokenize(text);
  let score = 0;
  let index = -1;

  for (const token of tokens) {
    let tokenMatches = 0;

    for (const candidate of haystack) {
      if (candidate.includes(token)) {
        tokenMatches += 1;
      }
    }

    if (tokenMatches === 0) {
      return null;
    }

    score += tokenMatches;

    if (index < 0) {
      index = normalized.indexOf(token);
    }
  }

  return { score, index: index < 0 ? 0 : index };
}

/** Создаёт Store поискового индекса с явной стратегией fallback. */
export function createSearchIndexStore(
  run: StoreRunner,
  now: () => Date,
  strategy: SearchIndexStrategy,
): SearchIndexStore {
  return {
    strategy,

    async upsert(documents) {
      for (const document of documents) {
        validateSearchDocument(document);
      }

      return run((state) => {
        const timestamp = currentUtcTimestamp(now);

        for (const document of documents) {
          const stored: SearchIndexDocument = {
            ...cloneJson(document),
            updatedAt: document.updatedAt ?? timestamp,
          };

          state.search.set(document.ref, stored);
        }

        return documents.length;
      });
    },

    async delete(ref) {
      assertResourceRefValue(ref, "ref");

      return run((state) => state.search.delete(ref));
    },

    async deleteMany(refs) {
      for (const ref of refs) {
        assertResourceRefValue(ref, "ref");
      }

      return run((state) => {
        let removed = 0;

        for (const ref of refs) {
          if (state.search.delete(ref)) {
            removed += 1;
          }
        }

        return removed;
      });
    },

    async clear(pluginId) {
      if (pluginId !== undefined) {
        assertPluginIdValue(pluginId);
      }

      return run((state) => {
        let removed = 0;

        for (const [ref, document] of state.search) {
          if (pluginId === undefined || document.pluginId === pluginId) {
            state.search.delete(ref);
            removed += 1;
          }
        }

        return removed;
      });
    },

    async search(query) {
      if (typeof query.text !== "string" || query.text.trim().length === 0) {
        throw storageError("INVALID_ARGUMENT", "Поисковый запрос не может быть пустым");
      }

      if (query.pluginId !== undefined) {
        assertPluginIdValue(query.pluginId);
      }

      assertSearchFilters(query.filters);
      assertPageSize(query.limit, "limit");
      assertPageNumber(query.offset ?? 0, "offset");

      return run((state) => {
        const hits: SearchHit[] = [];
        const filters = query.filters ?? [];

        for (const document of state.search.values()) {
          if (query.pluginId !== undefined && document.pluginId !== query.pluginId) {
            continue;
          }

          if (query.kind !== undefined && document.kind !== query.kind) {
            continue;
          }

          if (!filters.every((filter) => metadataMatches(document, filter))) {
            continue;
          }

          const match = matchScore(document, query.text, strategy);

          if (match === null) {
            continue;
          }

          const text = `${document.title}\n${document.text}`;
          const hit: {
            ref: string;
            title: string;
            excerpt: string;
            score: number;
            strategy: SearchIndexStrategy;
            kind?: string;
            metadata?: JsonObject;
          } = {
            ref: document.ref,
            title: document.title,
            excerpt: makeExcerpt(text, match.index, query.text.length),
            score: match.score,
            strategy,
          };

          if (document.kind !== undefined) {
            hit.kind = document.kind;
          }

          if (document.metadata !== undefined) {
            hit.metadata = cloneJson(document.metadata);
          }

          hits.push(hit);
        }

        const offset = query.offset ?? 0;
        const limit = query.limit ?? 50;

        return hits
          .sort((left, right) => right.score - left.score || compareStrings(left.ref, right.ref))
          .slice(offset, offset + limit);
      });
    },

    async list() {
      return run((state) =>
        [...state.search.values()]
          .sort(compareSearchDocuments)
          .map((document) => cloneJson(document)),
      );
    },

    async reindex(documents) {
      for (const document of documents) {
        validateSearchDocument(document);
      }

      return run((state) => {
        state.search.clear();
        const timestamp = currentUtcTimestamp(now);

        for (const document of documents) {
          state.search.set(document.ref, {
            ...cloneJson(document),
            updatedAt: document.updatedAt ?? timestamp,
          });
        }

        return documents.length;
      });
    },
  };
}

/** Проверяет JSON-совместимость значения без привязки к полю. */
export function isJsonValue(value: unknown): boolean {
  return validateJsonValue(value).ok;
}

export type { InMemoryState };
