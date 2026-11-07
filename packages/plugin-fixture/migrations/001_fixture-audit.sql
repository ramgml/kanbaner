-- Fixture-owned audit table.
--
-- Миграция демонстрирует backend-specific артефакт Plugin Contract. Код
-- плагина не выполняет SQL и не импортирует драйвер: таблица принадлежит
-- namespace-у fixture-плагина и создаётся runner-ом один раз.
CREATE TABLE plugin_kanbaner_fixture_audit (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  resource_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO plugin_kanbaner_fixture_audit (id, event_id, resource_ref, created_at)
VALUES (
  'fixture-seed',
  'fixture-seed-event',
  'kanbaner.fixture:item:fixture-seed',
  '2026-11-07T00:00:00.000Z'
);
