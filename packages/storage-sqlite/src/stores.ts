import { randomUUID } from "node:crypto";

import type {
  AppliedMigration,
  JsonObject,
  JsonValue,
  LinkStore,
  LinkStoreAddResult,
  MigrationStore,
  PluginDocument,
  PluginDocumentSort,
  PluginDocumentStore,
  PluginId,
  PluginStateRecord,
  PluginStateStore,
  ResourceLink,
  SearchFilter,
  SearchHit,
  SearchIndexDocument,
  SearchIndexStore,
  SearchIndexStrategy,
} from "@kanbaner/plugin-sdk";
import { currentUtcTimestamp } from "@kanbaner/plugin-sdk";
import type Database from "better-sqlite3";

import { sqliteError } from "./errors.ts";
import { buildSearchExcerpt, normalizeSearchQuery, normalizeSearchText } from "./normalizer.ts";
import {
  assertApplicationId,
  assertBackendId,
  assertChecksum,
  assertCollectionName,
  assertExpectedVersion,
  assertJsonObjectValue,
  assertJsonValueInput,
  assertPageNumber,
  assertPageSize,
  assertPluginId,
  assertPluginVersion,
  assertPositiveVersion,
  assertRelationValue,
  assertResourceLinkValue,
  assertResourceRefValue,
  assertUtcTimestampValue,
  cloneJson,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SEARCH_PAGE_SIZE,
} from "./validation.ts";

/** Асинхронная граница Store-операции: read или write в текущей области. */
export interface StoreRunner {
  read<T>(operation: () => T): Promise<T>;
  write<T>(operation: () => T): Promise<T>;
}

interface DocumentRow {
  readonly plugin_id: string;
  readonly collection: string;
  readonly id: string;
  readonly version: number;
  readonly data_json: string;
  readonly indexed_fields_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PluginStateRow {
  readonly plugin_id: string;
  readonly version: string;
  readonly enabled: number;
  readonly state_json: string;
  readonly updated_at: string;
}

interface LinkRow {
  readonly source_ref: string;
  readonly target_ref: string;
  readonly relation: string;
  readonly created_at: string;
}

interface MigrationRow {
  readonly backend_id: string;
  readonly plugin_id: string;
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

interface SearchDocumentRow {
  readonly ref: string;
  readonly plugin_id: string;
  readonly title: string;
  readonly body: string;
  readonly kind: string | null;
  readonly updated_at: string;
  readonly metadata_json: string | null;
}

interface SearchHitRow extends SearchDocumentRow {
  readonly rank: number;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function rowToDocument(row: DocumentRow): PluginDocument {
  const document: {
    pluginId: string;
    collection: string;
    id: string;
    version: number;
    data: JsonValue;
    indexedFields?: JsonObject;
    createdAt: string;
    updatedAt: string;
  } = {
    pluginId: row.plugin_id,
    collection: row.collection,
    id: row.id,
    version: row.version,
    data: parseJson<JsonValue>(row.data_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.indexed_fields_json !== null) {
    document.indexedFields = parseJson<JsonObject>(row.indexed_fields_json);
  }

  return document;
}

function rowToPluginState(row: PluginStateRow): PluginStateRecord {
  return {
    pluginId: row.plugin_id,
    version: row.version,
    enabled: row.enabled === 1,
    state: parseJson<JsonObject>(row.state_json),
    updatedAt: row.updated_at,
  };
}

function rowToLink(row: LinkRow): ResourceLink {
  return {
    sourceRef: row.source_ref,
    targetRef: row.target_ref,
    relation: row.relation,
    createdAt: row.created_at,
  };
}

function rowToMigration(row: MigrationRow): AppliedMigration {
  return {
    backendId: row.backend_id,
    pluginId: row.plugin_id,
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  };
}

function rowToSearchDocument(row: SearchDocumentRow): SearchIndexDocument {
  const document: {
    ref: string;
    pluginId: string;
    title: string;
    text: string;
    kind?: string;
    updatedAt?: string;
    metadata?: JsonObject;
  } = {
    ref: row.ref,
    pluginId: row.plugin_id,
    title: row.title,
    text: row.body,
    updatedAt: row.updated_at,
  };

  if (row.kind !== null) {
    document.kind = row.kind;
  }

  if (row.metadata_json !== null) {
    document.metadata = parseJson<JsonObject>(row.metadata_json);
  }

  return document;
}

function rowToSearchHit(
  row: SearchHitRow,
  excerpt: string,
  strategy: SearchIndexStrategy,
): SearchHit {
  const hit: {
    ref: string;
    title: string;
    excerpt: string;
    score: number;
    strategy: SearchIndexStrategy;
    kind?: string;
    metadata?: JsonObject;
  } = {
    ref: row.ref,
    title: row.title,
    excerpt,
    score: -row.rank,
    strategy,
  };

  if (row.kind !== null) {
    hit.kind = row.kind;
  }

  if (row.metadata_json !== null) {
    hit.metadata = parseJson<JsonObject>(row.metadata_json);
  }

  return hit;
}

const SEARCH_FILTER_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const MAX_SEARCH_FILTERS = 10;
const MAX_SEARCH_FILTER_VALUE_LENGTH = 200;

function assertSearchFilters(filters: readonly SearchFilter[] | undefined): void {
  if (filters === undefined) {
    return;
  }

  if (!Array.isArray(filters) || filters.length > MAX_SEARCH_FILTERS) {
    throw sqliteError(
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
      throw sqliteError("INVALID_ARGUMENT", "Поле фильтра поиска имеет недопустимый формат");
    }

    if (filter.operator !== "eq" && filter.operator !== "contains") {
      throw sqliteError("INVALID_ARGUMENT", "Оператор фильтра поиска должен быть eq или contains");
    }

    if (
      typeof filter.value !== "string" ||
      filter.value.length === 0 ||
      filter.value.length > MAX_SEARCH_FILTER_VALUE_LENGTH
    ) {
      throw sqliteError(
        "INVALID_ARGUMENT",
        `Значение фильтра поиска должно быть строкой длиной до ${String(MAX_SEARCH_FILTER_VALUE_LENGTH)}`,
      );
    }
  }
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

function optionalExpectedVersion(value: number | undefined): void {
  if (value !== undefined) {
    assertExpectedVersion(value);
  }
}

function validatePluginStateInput(input: {
  readonly pluginId: PluginId;
  readonly version: string;
  readonly enabled: boolean;
  readonly state: JsonObject;
}): void {
  assertPluginId(input.pluginId);
  assertPluginVersion(input.version);
  assertJsonObjectValue(input.state, "state");

  if (typeof input.enabled !== "boolean") {
    throw sqliteError("INVALID_ARGUMENT", "Поле enabled должно быть boolean");
  }
}

function validateMigration(migration: AppliedMigration): void {
  assertBackendId(migration.backendId);
  assertPluginId(migration.pluginId);
  assertPositiveVersion(migration.version, "version");
  assertChecksum(migration.checksum);
  assertUtcTimestampValue(migration.appliedAt, "appliedAt");

  if (typeof migration.name !== "string" || migration.name.trim().length === 0) {
    throw sqliteError("INVALID_ARGUMENT", "Имя миграции не может быть пустым");
  }
}

function validateSearchDocument(document: SearchIndexDocument): void {
  assertResourceRefValue(document.ref, "ref");
  assertPluginId(document.pluginId);

  if (typeof document.title !== "string" || document.title.trim().length === 0) {
    throw sqliteError("INVALID_ARGUMENT", "Заголовок поискового документа не может быть пустым");
  }

  if (typeof document.text !== "string") {
    throw sqliteError("INVALID_ARGUMENT", "Текст поискового документа должен быть строкой");
  }

  if (document.kind !== undefined && typeof document.kind !== "string") {
    throw sqliteError("INVALID_ARGUMENT", "kind поискового документа должен быть строкой");
  }

  if (document.updatedAt !== undefined) {
    assertUtcTimestampValue(document.updatedAt, "updatedAt");
  }

  if (document.metadata !== undefined) {
    assertJsonObjectValue(document.metadata, "metadata");
  }
}

/** Создаёт Store документов, привязанный к области выполнения. */
export function createDocumentStore(
  database: () => Database.Database,
  run: StoreRunner,
  now: () => Date,
): PluginDocumentStore {
  return {
    async get(pluginId, collection, id) {
      assertPluginId(pluginId);
      assertCollectionName(collection);
      assertApplicationId(id);

      return run.read(() => {
        const row = database()
          .prepare(
            `SELECT plugin_id, collection, id, version, data_json, indexed_fields_json, created_at, updated_at
             FROM core_documents
             WHERE plugin_id = ? AND collection = ? AND id = ?`,
          )
          .get(pluginId, collection, id) as DocumentRow | undefined;

        return row === undefined ? null : rowToDocument(row);
      });
    },

    async put(input) {
      assertPluginId(input.pluginId);
      assertCollectionName(input.collection);
      assertApplicationId(input.id);
      assertJsonValueInput(input.data, "data");
      optionalExpectedVersion(input.expectedVersion);

      if (input.indexedFields !== undefined) {
        assertJsonObjectValue(input.indexedFields, "indexedFields");
      }

      return run.write(() => {
        const db = database();
        const existing = db
          .prepare(
            `SELECT plugin_id, collection, id, version, data_json, indexed_fields_json, created_at, updated_at
             FROM core_documents
             WHERE plugin_id = ? AND collection = ? AND id = ?`,
          )
          .get(input.pluginId, input.collection, input.id) as DocumentRow | undefined;
        const timestamp = currentUtcTimestamp(now);
        const dataJson = JSON.stringify(input.data);
        const indexedFieldsJson =
          input.indexedFields === undefined ? null : JSON.stringify(input.indexedFields);

        if (existing === undefined) {
          if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
            throw sqliteError("VERSION_CONFLICT", "Документ не существует или версия устарела");
          }

          const created: PluginDocument = {
            pluginId: input.pluginId,
            collection: input.collection,
            id: input.id,
            version: 1,
            data: cloneJson(input.data),
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(input.indexedFields === undefined
              ? {}
              : { indexedFields: cloneJson(input.indexedFields) }),
          };

          db.prepare(
            `INSERT INTO core_documents
               (plugin_id, collection, id, version, data_json, indexed_fields_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.pluginId,
            input.collection,
            input.id,
            1,
            dataJson,
            indexedFieldsJson,
            timestamp,
            timestamp,
          );

          return created;
        }

        if (input.expectedVersion === undefined || input.expectedVersion !== existing.version) {
          throw sqliteError("VERSION_CONFLICT", "Версия документа изменилась");
        }

        const result = db
          .prepare(
            `UPDATE core_documents
             SET version = version + 1, data_json = ?, indexed_fields_json = ?, updated_at = ?
             WHERE plugin_id = ? AND collection = ? AND id = ? AND version = ?`,
          )
          .run(
            dataJson,
            indexedFieldsJson,
            timestamp,
            input.pluginId,
            input.collection,
            input.id,
            existing.version,
          );

        if (result.changes !== 1) {
          throw sqliteError("VERSION_CONFLICT", "Версия документа изменилась");
        }

        const updated: PluginDocument = {
          pluginId: input.pluginId,
          collection: input.collection,
          id: input.id,
          version: existing.version + 1,
          data: cloneJson(input.data),
          createdAt: existing.created_at,
          updatedAt: timestamp,
          ...(input.indexedFields === undefined
            ? {}
            : { indexedFields: cloneJson(input.indexedFields) }),
        };

        return updated;
      });
    },

    async delete(pluginId, collection, id, options) {
      assertPluginId(pluginId);
      assertCollectionName(collection);
      assertApplicationId(id);
      optionalExpectedVersion(options?.expectedVersion);

      return run.write(() => {
        const db = database();
        const existing = db
          .prepare(
            `SELECT version FROM core_documents
             WHERE plugin_id = ? AND collection = ? AND id = ?`,
          )
          .get(pluginId, collection, id) as { readonly version: number } | undefined;

        if (existing === undefined) {
          return false;
        }

        if (
          options?.expectedVersion !== undefined &&
          options.expectedVersion !== existing.version
        ) {
          throw sqliteError("VERSION_CONFLICT", "Версия документа изменилась");
        }

        const result = db
          .prepare("DELETE FROM core_documents WHERE plugin_id = ? AND collection = ? AND id = ?")
          .run(pluginId, collection, id);

        return result.changes > 0;
      });
    },

    async query(query) {
      assertPluginId(query.pluginId);
      assertPageSize(query.limit, "limit");
      assertPageNumber(query.offset ?? 0, "offset");

      if (query.collection !== undefined) {
        assertCollectionName(query.collection);
      }

      if (query.indexedFields !== undefined) {
        assertJsonObjectValue(query.indexedFields, "indexedFields");
      }

      const ids = query.ids;

      if (ids !== undefined) {
        for (const id of ids) {
          assertApplicationId(id);
        }
      }

      if (ids !== undefined && ids.length === 0) {
        return [];
      }

      return run.read(() => {
        const db = database();
        const conditions = ["plugin_id = ?"];
        const parameters: unknown[] = [query.pluginId];

        if (query.collection !== undefined) {
          conditions.push("collection = ?");
          parameters.push(query.collection);
        }

        if (ids !== undefined) {
          conditions.push(`id IN (${ids.map(() => "?").join(", ")})`);
          parameters.push(...ids);
        }

        const rows = db
          .prepare(
            `SELECT plugin_id, collection, id, version, data_json, indexed_fields_json, created_at, updated_at
             FROM core_documents
             WHERE ${conditions.join(" AND ")}`,
          )
          .all(...parameters) as DocumentRow[];
        const documents = rows
          .map(rowToDocument)
          .filter((document) => matchesIndexedFields(document, query.indexedFields));
        const sorted = sortDocuments(documents, query.sort);
        const offset = query.offset ?? 0;
        const limit = query.limit ?? DEFAULT_PAGE_SIZE;

        return sorted.slice(offset, offset + limit);
      });
    },

    async list(pluginId, collection) {
      assertPluginId(pluginId);

      if (collection !== undefined) {
        assertCollectionName(collection);
      }

      return run.read(() => {
        const db = database();
        const rows =
          collection === undefined
            ? (db
                .prepare(
                  `SELECT plugin_id, collection, id, version, data_json, indexed_fields_json, created_at, updated_at
                   FROM core_documents
                   WHERE plugin_id = ?
                   ORDER BY plugin_id, collection, id`,
                )
                .all(pluginId) as DocumentRow[])
            : (db
                .prepare(
                  `SELECT plugin_id, collection, id, version, data_json, indexed_fields_json, created_at, updated_at
                   FROM core_documents
                   WHERE plugin_id = ? AND collection = ?
                   ORDER BY plugin_id, collection, id`,
                )
                .all(pluginId, collection) as DocumentRow[]);

        return rows.map(rowToDocument);
      });
    },
  };
}

/** Создаёт Store универсальных связей. */
export function createLinkStore(
  database: () => Database.Database,
  run: StoreRunner,
  now: () => Date,
): LinkStore {
  return {
    async add(link) {
      assertResourceLinkValue(link);

      const createdAt = link.createdAt ?? currentUtcTimestamp(now);
      assertUtcTimestampValue(createdAt, "createdAt");

      const storedLink: ResourceLink = {
        sourceRef: link.sourceRef,
        targetRef: link.targetRef,
        relation: link.relation,
        createdAt,
      };

      return run.write((): LinkStoreAddResult => {
        const db = database();
        const result = db
          .prepare(
            `INSERT OR IGNORE INTO core_resource_links
               (id, source_ref, target_ref, relation, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            storedLink.sourceRef,
            storedLink.targetRef,
            storedLink.relation,
            storedLink.createdAt,
          );

        if (result.changes === 1) {
          return { inserted: true, link: cloneJson(storedLink) };
        }

        const existing = db
          .prepare(
            `SELECT source_ref, target_ref, relation, created_at
             FROM core_resource_links
             WHERE source_ref = ? AND target_ref = ? AND relation = ?`,
          )
          .get(storedLink.sourceRef, storedLink.targetRef, storedLink.relation) as
          LinkRow | undefined;

        if (existing === undefined) {
          throw sqliteError("INTERNAL_ERROR", "Не удалось прочитать существующую связь");
        }

        return { inserted: false, link: rowToLink(existing) };
      });
    },

    async remove(sourceRef, targetRef, relation) {
      assertResourceRefValue(sourceRef, "sourceRef");
      assertResourceRefValue(targetRef, "targetRef");
      assertRelationValue(relation);

      return run.write(() => {
        const result = database()
          .prepare(
            `DELETE FROM core_resource_links
             WHERE source_ref = ? AND target_ref = ? AND relation = ?`,
          )
          .run(sourceRef, targetRef, relation);

        return result.changes > 0;
      });
    },

    async listByRef(ref, relation) {
      assertResourceRefValue(ref, "ref");

      if (relation !== undefined) {
        assertRelationValue(relation);
      }

      return run.read(() => {
        const db = database();
        const rows =
          relation === undefined
            ? (db
                .prepare(
                  `SELECT source_ref, target_ref, relation, created_at
                   FROM core_resource_links
                   WHERE source_ref = ? OR target_ref = ?
                   ORDER BY source_ref, target_ref, relation`,
                )
                .all(ref, ref) as LinkRow[])
            : (db
                .prepare(
                  `SELECT source_ref, target_ref, relation, created_at
                   FROM core_resource_links
                   WHERE (source_ref = ? OR target_ref = ?) AND relation = ?
                   ORDER BY source_ref, target_ref, relation`,
                )
                .all(ref, ref, relation) as LinkRow[]);

        return rows.map(rowToLink);
      });
    },

    async deleteByRef(ref) {
      assertResourceRefValue(ref, "ref");

      return run.write(() => {
        const result = database()
          .prepare("DELETE FROM core_resource_links WHERE source_ref = ? OR target_ref = ?")
          .run(ref, ref);

        return result.changes;
      });
    },
  };
}

/** Создаёт Store состояния плагинов. */
export function createPluginStateStore(
  database: () => Database.Database,
  run: StoreRunner,
  now: () => Date,
): PluginStateStore {
  return {
    async get(pluginId) {
      assertPluginId(pluginId);

      return run.read(() => {
        const row = database()
          .prepare(
            `SELECT plugin_id, version, enabled, state_json, updated_at
             FROM core_plugins WHERE plugin_id = ?`,
          )
          .get(pluginId) as PluginStateRow | undefined;

        return row === undefined ? null : rowToPluginState(row);
      });
    },

    async put(input) {
      validatePluginStateInput(input);

      return run.write(() => {
        const timestamp = currentUtcTimestamp(now);

        database()
          .prepare(
            `INSERT INTO core_plugins (plugin_id, version, enabled, state_json, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(plugin_id) DO UPDATE SET
               version = excluded.version,
               enabled = excluded.enabled,
               state_json = excluded.state_json,
               updated_at = excluded.updated_at`,
          )
          .run(
            input.pluginId,
            input.version,
            input.enabled ? 1 : 0,
            JSON.stringify(input.state),
            timestamp,
          );

        return {
          pluginId: input.pluginId,
          version: input.version,
          enabled: input.enabled,
          state: cloneJson(input.state),
          updatedAt: timestamp,
        };
      });
    },

    async delete(pluginId) {
      assertPluginId(pluginId);

      return run.write(() => {
        const result = database()
          .prepare("DELETE FROM core_plugins WHERE plugin_id = ?")
          .run(pluginId);

        return result.changes > 0;
      });
    },

    async list() {
      return run.read(() => {
        const rows = database()
          .prepare(
            `SELECT plugin_id, version, enabled, state_json, updated_at
             FROM core_plugins ORDER BY plugin_id`,
          )
          .all() as PluginStateRow[];

        return rows.map(rowToPluginState);
      });
    },
  };
}

/** Создаёт Store журнала миграций. */
export function createMigrationStore(
  database: () => Database.Database,
  run: StoreRunner,
): MigrationStore {
  return {
    async list(backendId) {
      if (backendId !== undefined) {
        assertBackendId(backendId);
      }

      return run.read(() => {
        const db = database();
        const rows =
          backendId === undefined
            ? (db
                .prepare(
                  `SELECT backend_id, plugin_id, version, name, checksum, applied_at
                   FROM core_plugin_migrations ORDER BY backend_id, plugin_id, version`,
                )
                .all() as MigrationRow[])
            : (db
                .prepare(
                  `SELECT backend_id, plugin_id, version, name, checksum, applied_at
                   FROM core_plugin_migrations WHERE backend_id = ?
                   ORDER BY backend_id, plugin_id, version`,
                )
                .all(backendId) as MigrationRow[]);

        return rows.map(rowToMigration);
      });
    },

    async find(backendId, pluginId, version) {
      assertBackendId(backendId);
      assertPluginId(pluginId);
      assertPositiveVersion(version, "version");

      return run.read(() => {
        const row = database()
          .prepare(
            `SELECT backend_id, plugin_id, version, name, checksum, applied_at
             FROM core_plugin_migrations
             WHERE backend_id = ? AND plugin_id = ? AND version = ?`,
          )
          .get(backendId, pluginId, version) as MigrationRow | undefined;

        return row === undefined ? null : rowToMigration(row);
      });
    },

    async record(migration) {
      validateMigration(migration);

      return run.write(() => {
        const db = database();
        const existing = db
          .prepare(
            `SELECT checksum FROM core_plugin_migrations
             WHERE backend_id = ? AND plugin_id = ? AND version = ?`,
          )
          .get(migration.backendId, migration.pluginId, migration.version) as
          { readonly checksum: string } | undefined;

        if (existing !== undefined) {
          if (existing.checksum !== migration.checksum) {
            throw sqliteError(
              "MIGRATION_CHECKSUM_MISMATCH",
              "Checksum применённой миграции не совпадает",
            );
          }

          return;
        }

        db.prepare(
          `INSERT INTO core_plugin_migrations
             (backend_id, plugin_id, version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          migration.backendId,
          migration.pluginId,
          migration.version,
          migration.name,
          migration.checksum,
          migration.appliedAt,
        );
      });
    },
  };
}

/** Создаёт Store поискового индекса на FTS5. */
export function createSearchIndexStore(
  database: () => Database.Database,
  run: StoreRunner,
  now: () => Date,
  strategy: SearchIndexStrategy,
): SearchIndexStore {
  const replaceDocument = (
    db: Database.Database,
    document: SearchIndexDocument,
    timestamp: string,
  ): void => {
    const updatedAt = document.updatedAt ?? timestamp;
    const normalized = normalizeSearchText(`${document.title}\n${document.text}`);
    const metadataJson = document.metadata === undefined ? null : JSON.stringify(document.metadata);
    const kind = document.kind ?? null;

    db.prepare(
      `INSERT INTO core_search_documents
         (ref, plugin_id, title, body, kind, updated_at, metadata_json, normalized)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         plugin_id = excluded.plugin_id,
         title = excluded.title,
         body = excluded.body,
         kind = excluded.kind,
         updated_at = excluded.updated_at,
         metadata_json = excluded.metadata_json,
         normalized = excluded.normalized`,
    ).run(
      document.ref,
      document.pluginId,
      document.title,
      document.text,
      kind,
      updatedAt,
      metadataJson,
      normalized,
    );

    db.prepare("DELETE FROM core_search_fts WHERE ref = ?").run(document.ref);
    db.prepare(
      "INSERT INTO core_search_fts (ref, title, body, normalized) VALUES (?, ?, ?, ?)",
    ).run(document.ref, document.title, document.text, normalized);
  };

  return {
    strategy,

    async upsert(documents) {
      for (const document of documents) {
        validateSearchDocument(document);
      }

      return run.write(() => {
        const db = database();
        const timestamp = currentUtcTimestamp(now);

        for (const document of documents) {
          replaceDocument(db, document, timestamp);
        }

        return documents.length;
      });
    },

    async delete(ref) {
      assertResourceRefValue(ref, "ref");

      return run.write(() => {
        const db = database();

        db.prepare("DELETE FROM core_search_fts WHERE ref = ?").run(ref);

        const result = db.prepare("DELETE FROM core_search_documents WHERE ref = ?").run(ref);

        return result.changes > 0;
      });
    },

    async deleteMany(refs) {
      for (const ref of refs) {
        assertResourceRefValue(ref, "ref");
      }

      return run.write(() => {
        const db = database();
        let removed = 0;

        for (const ref of refs) {
          db.prepare("DELETE FROM core_search_fts WHERE ref = ?").run(ref);

          const result = db.prepare("DELETE FROM core_search_documents WHERE ref = ?").run(ref);

          if (result.changes > 0) {
            removed += 1;
          }
        }

        return removed;
      });
    },

    async clear(pluginId) {
      if (pluginId !== undefined) {
        assertPluginId(pluginId);
      }

      return run.write(() => {
        const db = database();
        const refs =
          pluginId === undefined
            ? (db.prepare("SELECT ref FROM core_search_documents").all() as {
                readonly ref: string;
              }[])
            : (db
                .prepare("SELECT ref FROM core_search_documents WHERE plugin_id = ?")
                .all(pluginId) as { readonly ref: string }[]);

        for (const { ref } of refs) {
          db.prepare("DELETE FROM core_search_fts WHERE ref = ?").run(ref);
        }

        const result =
          pluginId === undefined
            ? db.prepare("DELETE FROM core_search_documents").run()
            : db.prepare("DELETE FROM core_search_documents WHERE plugin_id = ?").run(pluginId);

        return result.changes;
      });
    },

    async search(query) {
      if (typeof query.text !== "string" || query.text.trim().length === 0) {
        throw sqliteError("INVALID_ARGUMENT", "Поисковый запрос не может быть пустым");
      }

      if (query.pluginId !== undefined) {
        assertPluginId(query.pluginId);
      }

      if (query.kind !== undefined && typeof query.kind !== "string") {
        throw sqliteError("INVALID_ARGUMENT", "kind поискового запроса должен быть строкой");
      }

      assertSearchFilters(query.filters);
      assertPageSize(query.limit, "limit");
      assertPageNumber(query.offset ?? 0, "offset");

      const normalized = normalizeSearchQuery(query.text);

      if (normalized === null) {
        throw sqliteError("INVALID_ARGUMENT", "Поисковый запрос не содержит терминов");
      }

      const filterClauses: string[] = [];
      const filterParams: string[] = [];

      for (const filter of query.filters ?? []) {
        const path = `$."${filter.field}"`;

        // Семантика совпадает с in-memory provider: eq — только строковый
        // scalar, contains — подстрока строки или точный строковый элемент
        // массива. object/number/boolean/null не фильтруются.
        if (filter.operator === "eq") {
          filterClauses.push(
            "(json_type(d.metadata_json, ?) = 'text' AND json_extract(d.metadata_json, ?) = ?)",
          );
          filterParams.push(path, path, filter.value);
          continue;
        }

        filterClauses.push(
          `((json_type(d.metadata_json, ?) = 'text'
              AND instr(json_extract(d.metadata_json, ?), ?) > 0)
            OR (json_type(d.metadata_json, ?) = 'array' AND EXISTS (
              SELECT 1 FROM json_each(d.metadata_json, ?) AS filter_value
              WHERE filter_value.type = 'text' AND filter_value.value = ?
            )))`,
        );
        filterParams.push(path, path, filter.value, path, path, filter.value);
      }

      const filterSql = filterClauses.length === 0 ? "" : ` AND ${filterClauses.join(" AND ")}`;

      return run.read(() => {
        const db = database();
        const pluginId = query.pluginId ?? null;
        const kind = query.kind ?? null;
        const offset = query.offset ?? 0;
        const limit = query.limit ?? DEFAULT_SEARCH_PAGE_SIZE;
        const match = `normalized : (${normalized.match})`;
        const rows = db
          .prepare(
            `SELECT d.ref, d.plugin_id, d.title, d.body, d.kind, d.updated_at,
                    d.metadata_json, bm25(core_search_fts) AS rank
             FROM core_search_fts
             JOIN core_search_documents d ON d.ref = core_search_fts.ref
             WHERE core_search_fts MATCH ?
               AND (? IS NULL OR d.plugin_id = ?)
               AND (? IS NULL OR d.kind = ?)${filterSql}
             ORDER BY rank ASC, d.ref ASC
             LIMIT ? OFFSET ?`,
          )
          .all(
            match,
            pluginId,
            pluginId,
            kind,
            kind,
            ...filterParams,
            limit,
            offset,
          ) as SearchHitRow[];

        return rows.map((row) =>
          rowToSearchHit(row, buildSearchExcerpt(row.title, row.body, normalized.terms), strategy),
        );
      });
    },

    async list() {
      return run.read(() => {
        const rows = database()
          .prepare(
            `SELECT ref, plugin_id, title, body, kind, updated_at, metadata_json
             FROM core_search_documents ORDER BY ref`,
          )
          .all() as SearchDocumentRow[];

        return rows.map(rowToSearchDocument);
      });
    },

    async reindex(documents) {
      for (const document of documents) {
        validateSearchDocument(document);
      }

      return run.write(() => {
        const db = database();
        const timestamp = currentUtcTimestamp(now);

        db.prepare("DELETE FROM core_search_fts").run();
        db.prepare("DELETE FROM core_search_documents").run();

        for (const document of documents) {
          replaceDocument(db, document, timestamp);
        }

        return documents.length;
      });
    },
  };
}
