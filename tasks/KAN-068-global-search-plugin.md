---
id: KAN-068
title: Отдельный глобальный search-плагин
status: review
stage: 5
priority: high
owner: worker-kan-068
blocked_by: []
branch: feat/kan-068-global-search-plugin
worktree: .worktrees/kan-068-global-search-plugin
created: 2026-11-25
updated: 2026-11-25
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/roadmap.md
  - specs/technology-stack.md
---

# KAN-068 — Отдельный глобальный search-плагин

## Цель

Закрыть поисковую часть MVP: отдельный `kanbaner.search` объединяет задачи,
заметки и тестовый плагин через публичный SearchProvider Registry, не читая их
данные и не импортируя их код.

## Результат

- Полнотекстовый поиск находит задачи и заметки по содержимому, включая
  кириллицу, регистр, фразы и prefix-запросы.
- Доступны фильтры по типу, проекту, статусу и тегам; переход по `ResourceRef`.
- Отключённый доменный плагин исчезает из выдачи без удаления его данных.
- Полная переиндексация восстанавливает индекс после пропущенного события.
- Fixture регистрирует собственного провайдера без изменений ядра.

## Архитектурные решения

- Использовать SearchProvider Registry, а не глобальное чтение чужих namespace.
- Существующий `core_search_*` остаётся инфраструктурой активного Storage
  Provider. Домены пишут только scoped-документы; `kanbaner.search` лишь
  агрегирует активных провайдеров. Обновить §8.7 вместо переноса индекса.
- `SearchHit` может совместимо получить optional `kind` и публичные `metadata`.
  Секреты и служебные данные в metadata запрещены.
- Project/status/tag-фильтры относятся к задачам. При их выборе заметки без
  таких атрибутов исключаются; связи заметок в project-фильтр не выводятся.
- Не добавлять межплагинную reindex-команду с частичным успехом. Полная
  переиндексация выполняется через idempotent `reindex()` каждого провайдера при
  активации и проверяется через registry/lifecycle. Локальный task.list.text
  сохраняется.
- Ограничение KAN-050 на отдельный search-плагин относилось к локальному поиску
  задач и для этой глобальной задачи снято явным решением пользователя.

## Объём работ

- [ ] Добавить публичные SearchProvider/Registry contracts, lifecycle и
  ownership тесты в SDK/kernel.
- [ ] Расширить SearchQuery/SearchHit filters/metadata и синхронизировать SQLite
  WAL, in-memory provider и Conformance Suite; SQL только в storage-sqlite.
- [ ] Создать `packages/plugin-search` с manifest, `kanbaner.search.query`,
  facet/query schema, агрегацией, dedupe, score/ref ordering и bounded pagination.
- [ ] Зарегистрировать providers в tasks, notes и fixture; unregister при
  deactivation, reindex при activation.
- [ ] Добавить `/view/search` через app.main/app.sidebar, текстовый запрос,
  type/project/status/tags filters, loading/error/empty/warnings и keyboard
  resource opening.
- [ ] Подключить HTTP exposure; `mcp:true` у read query декларируется для KAN-069,
  но ручной OpenCode allowlist не расширяется.
- [ ] Добавить unit/integration/contract/E2E и обновить документацию.

## Владение файлами

Worker владеет всеми файлами, необходимыми для search, включая:

- `packages/plugin-search/**`;
- `packages/plugin-sdk/**`, `packages/kernel/**`, `packages/storage-sqlite/**`
  только для search contracts/registry/storage/conformance;
- search-related файлы `plugin-tasks`, `plugin-notes`, `plugin-fixture`;
- `apps/web/package.json`, `apps/web/src/ui/builtin-ui-plugins*`,
  `apps/web/src/components/shell/nav-items.ts`, новые `apps/web/e2e/search*`;
- `apps/web/src/server/*` и integration/contract tests при search-интеграции;
- корневой `package.json`, `pnpm-lock.yaml`, `scripts/check-import-boundaries.mjs`;
- `README.md`, search-разделы specs и `tasks/reports/KAN-068.md`.

Запрещено:

- `packages/mcp/**`, `packages/opencode/**`, ручной OpenCode allowlist;
- dirty `app-shell.tsx`, `shell-nav.tsx`, `shell.test.tsx`, `notes.spec.ts`;
- embeddings, внешний поисковый сервер, новые внешние зависимости;
- перенос индекса в собственный namespace search и межплагинные транзакции;
- файлы задач и release-ветки.

Перед изменением файла, который также нужен MCP integration, зафиксировать его
в отчёте; KAN-069 подключится после merge этой ветки.

## Контракты и границы

- Плагин зависит от SDK, но не от kernel/storage-sqlite/tasks/notes/fixture.
- Домены не импортируют plugin-search. Registry использует только публичный SDK.
- Query read-only; входные схемы bounded, неизвестные filters/kinds отклоняются
  или дают явную пустую выдачу по задокументированному правилу.
- Текст запроса, excerpt и содержимое заметок не логируются.
- Отключение search не влияет на tasks/notes; отключение notes/tasks скрывает их
  результаты без удаления индекса или исходных данных.
- Никаких новых миграций, если существующая схема и metadata_json достаточны.

## Критерии приёмки

- [ ] Integration создаёт/обновляет/находит задачу и заметку по тексту,
  удаляет hit после удаления ресурса.
- [ ] Type/project/status/tag filters работают на SQLite и in-memory parity.
- [ ] Disabled provider не участвует; reindex восстанавливает пропущенный документ.
- [ ] Fixture provider виден через тот же registry без специальных веток ядра.
- [ ] UI позволяет найти и открыть ресурс клавиатурой, mobile 360 не ломается.
- [ ] HTTP discovery/query требуют Bearer и не раскрывают секреты.
- [ ] Полный `pnpm check`, полный Playwright Chromium, imports, composition и
  SQLite smoke зелёные.

## Проверки

- Frozen strict install, отсутствие новых deprecated/unmet peer dependencies.
- Focused SDK/kernel/storage/search/domain tests и обе conformance suites.
- `pnpm check:imports`, `pnpm check:composition`, `pnpm test:sqlite`.
- `pnpm --filter @kanbaner/web test:e2e` и `pnpm check`.
- Windows-проверки не выполняются по явному решению пользователя для текущего
  релиза; это фиксируется в release notes, поддержка Windows не отменяется.

## Риски

- Pagination/merge между провайдерами и детерминированный tie-break.
- Metadata filters не должны стать каналом утечки произвольных документов.
- Ошибка одного provider должна давать bounded warning; полный сбой — стабильную
  ошибку без чужого текста.
- Reindex между плагинами не атомарен; не объявлять частичный успех командой.

## Журнал

- 2026-11-25 — Задача создана для закрытия MVP перед stable `0.1.0`; назначен
  `worker-kan-068`, статус `in_progress`.
- 2026-11-25 — Worker реализовал SearchProvider Registry, search UI, domain
  providers, filters и lifecycle. Коммит `c00dc6a`; focused 502/502, полный
  Playwright 176/176, `pnpm check` зелёный.
- 2026-11-25 — Ревью нашло high в activation/reindex lifecycle, medium в
  validation/JSON parity и пробелы DoD-тестов. Задача возвращена в
  `in_progress`; merge запрещён до повторного ревью.
- 2026-11-25 — Worker закрыл замечания коммитами `acdb252` и `2521f68`.
  Focused 883/883, полный Playwright 177/177, полный Vitest 151 files / 2138
  tests, `pnpm check` зелёный. Статус `review`.

## Итог

Заполняется оркестратором после интеграции.
