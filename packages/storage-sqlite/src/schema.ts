/**
 * Минимальная стабильная схема, необходимая runner-у миграций до применения
 * версионируемой схемы.
 *
 * `open()` создаёт только журнал миграций. Все остальные core-таблицы создаёт
 * инфраструктурная миграция в общей транзакции с записью журнала.
 */
export const JOURNAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS core_plugin_migrations (
  backend_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, plugin_id, version)
);

CREATE INDEX IF NOT EXISTS core_plugin_migrations_backend_idx
  ON core_plugin_migrations (backend_id, plugin_id, version);
`;

/**
 * Внутренняя схема SQLite provider-а.
 *
 * Имена таблиц, SQL и FTS-колонок не входят в публичный контракт SDK.
 * Версионируемая схема применяется только инфраструктурной миграцией
 * в транзакции; `CORE_SCHEMA_SQL` не выполняется в `open()`.
 */
export const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS core_plugin_migrations (
  backend_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, plugin_id, version)
);

CREATE INDEX IF NOT EXISTS core_plugin_migrations_backend_idx
  ON core_plugin_migrations (backend_id, plugin_id, version);

CREATE TABLE IF NOT EXISTS core_documents (
  plugin_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  indexed_fields_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, collection, id)
);

CREATE INDEX IF NOT EXISTS core_documents_plugin_collection_idx
  ON core_documents (plugin_id, collection);

CREATE INDEX IF NOT EXISTS core_documents_plugin_updated_idx
  ON core_documents (plugin_id, updated_at);

CREATE TABLE IF NOT EXISTS core_plugins (
  plugin_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS core_plugins_updated_idx
  ON core_plugins (updated_at);

CREATE TABLE IF NOT EXISTS core_resource_links (
  id TEXT PRIMARY KEY,
  source_ref TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_ref, target_ref, relation)
);

CREATE INDEX IF NOT EXISTS core_resource_links_source_idx
  ON core_resource_links (source_ref, relation);

CREATE INDEX IF NOT EXISTS core_resource_links_target_idx
  ON core_resource_links (target_ref, relation);

CREATE TABLE IF NOT EXISTS core_search_documents (
  ref TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT,
  updated_at TEXT NOT NULL,
  metadata_json TEXT,
  normalized TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS core_search_documents_plugin_idx
  ON core_search_documents (plugin_id, ref);

CREATE INDEX IF NOT EXISTS core_search_documents_kind_idx
  ON core_search_documents (kind, ref);

CREATE VIRTUAL TABLE IF NOT EXISTS core_search_fts USING fts5(
  ref UNINDEXED,
  title,
  body,
  normalized,
  tokenize = 'unicode61'
);
`;

/** Plugin ID инфраструктурных миграций ядра. */
export const CORE_INFRASTRUCTURE_PLUGIN_ID = "kanbaner.core";

/** Версия baseline-схемы provider-а. */
export const CORE_INFRASTRUCTURE_VERSION = 1;

/** Имя инфраструктурной миграции. */
export const CORE_INFRASTRUCTURE_NAME = "core-foundation";
