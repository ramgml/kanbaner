# Release v0.1.0

Статус: **опубликован**. `main`, annotated tag, stable GitHub Release и assets
проверены; `dev` переведён на следующую development-версию.

Дата подготовки: 2026-11-26. Ветка: `release/0.1.0`. Рабочее дерево:
`.worktrees/release-0.1.0`.

## Решение и границы

Пользователь выбрал выпуск стабильного `0.1.0`. Релиз закрывает оставшиеся
MVP gaps, зафиксированные в отчёте `release-v0.1.0-rc.0.md`, и не добавляет
новых продуктовых функций сверх этого объёма.

- Отдельный глобальный поиск реализован в KAN-068: SearchProvider Registry,
  FTS5-индекс SQLite, фильтры и facets, UI `/view/search`, bounded pagination,
  идемпотентная переиндексация и lifecycle.
- Универсальный discovery-driven MCP реализован в KAN-069: binary
  `kanbaner-mcp-universal`, строгая конфигурация, публикация только
  `exposure.http && exposure.mcp`, annotations, `expectedVersion`,
  `Idempotency-Key`, destructive gating, redaction и отсутствие доступа к
  базе данных.
- В релиз также входят KAN-059–KAN-067: глобальный размер шрифта и улучшения
  OpenCode UX (статусы prompt, tool calls, прокрутка, копирование кода,
  черновики, история сессий, автоматические названия, анимация выполнения).

Новые функции в release-ветку не добавлялись. Изменены только версии,
changelog, release-документация и связанные с версиями install-описания.

## Windows waiver

По явному решению пользователя установка, production build, нативный
`better-sqlite3`, миграции и E2E на Windows в этом релизе **не выполнялись**.
Это зафиксировано в changelog и не отменяет поддержку Windows как целевой ОС.

Обязательными остаются проверки на Linux и в Chromium. Результаты этих
проверок фиксируются оркестратором после выполнения, а не в этом draft-отчёте.

## Версии

- Корневой `package.json` и приложение: `0.1.0`.
- Все private workspace packages: `0.1.0`, включая новые `@kanbaner/mcp` и
  `@kanbaner/plugin-search` (ранее `0.1.0-dev.0`).
- Production built-in plugin manifests: `0.1.0`; манифест
  `kanbaner.search` синхронизирован с версией приложения (ранее `1.0.0`).
- `kanbaner.projects` требует `kanbaner.tasks` `^0.1.0`.
- `packages/opencode/src/mcp-server.ts` и
  `packages/mcp/src/server.ts` сообщают версию `0.1.0`.
- `@kanbaner/plugin-fixture` package синхронизирован как workspace package;
  его fixture-манифест намеренно остаётся `1.0.0` и не является production
  built-in manifest.
- Plugin Contract остаётся `v1`, Host API — `1.0.0`.
- Исторические записи `tasks/**`, отчёт RC и секция `[0.1.0-rc.0]` не
  переписывались.

## Changelog и миграции

- Секция `[0.1.0-rc.0] - 2026-11-22` сохранена без изменений.
- Добавлена секция `[0.1.0] - 2026-11-26`; `[Unreleased]` остаётся выше.
- Схема и миграции не менялись относительно `0.1.0-rc.0`; новых миграций нет.
- Порядок обновления с RC: online backup через Storage Provider, остановка
  приложения, установка и запуск `0.1.0`; offline restore — только в новый
  каталог данных на остановленном приложении.
- Откат: предыдущая версия плюс backup, восстановленный в новый каталог;
  автоматического downgrade нет.

## Проверки подготовки

Выполнены в этом worktree на pinned Node.js `24.22.2` и pnpm `12.18.0`.

- [x] Штатный `pnpm install --strict-peer-dependencies`; lockfile не изменился,
      затем `pnpm install --frozen-lockfile --strict-peer-dependencies` прошёл.
- [x] Strict peer install без unmet peer dependencies и без предупреждений о
      deprecated-пакетах; `pnpm outdated` показывает только доступные более
      новые версии, обновление зависимостей в релиз не входило.
- [x] `pnpm check` — format, lint, typecheck, **159 test files / 2221 tests** и
      production build успешны; остаются известные 6 Turbopack warnings о
      dynamic filesystem tracing в `kernel` и `storage-sqlite`.
- [x] `pnpm check:imports` — успешно.
- [x] `pnpm check:composition` — Plugin Contract 1, Host API 1, SQLite provider.
- [x] `pnpm test:sqlite` — **1 file / 1 test**.
- [x] Prettier и `git diff --check` — без ошибок.

## Проверки оркестратора перед публикацией

Все проверки ниже выполнены на Linux с Node.js `24.22.2` и pnpm `12.18.0`.

- [x] Полный production Playwright Chromium на release-ветке: **177/177**.
- [x] Production smoke на восстановленной чистой базе: созданы проект, задача и
      заметка, global search нашёл обе сущности; повторный запуск сохранил данные
      и два search hits, safe mode выключен.
- [x] Online backup активного Storage Provider через `.backup()`:
      `integrity: ok`, **102400 bytes / 25 pages**; независимый integrity check
      подтверждён.
- [x] Offline restore через `scripts/restore.mjs` в новый каталог: маркерный
      документ прочитан, production server запущен на восстановленной базе.
- [x] Обновление копии данных с `v0.1.0-rc.0`: RC source был установлен и собран,
      созданы проект/задача/заметка; после остановки копия запущена на `0.1.0`,
      данные сохранены и найдены через новый global search. Исходный RC каталог
      не изменялся.
- [x] Source archive precheck от `7fc9543`: содержит lockfile, README и
      changelog; чистая frozen install, native `better-sqlite3` + FTS5/unicode61
      smoke и production build успешны. Финальный архив пересоздан от annotated
      tag и повторно прошёл те же проверки.
- [x] Проверка отсутствия секретов: tracked data/private-key paths и
      high-confidence private-key/GitHub/OpenAI token markers во всей истории не
      найдены. Dedicated `gitleaks` недоступен; это явно ограничение сканирования.
- [x] Release review: blocker/high/medium не найдено. Documentation low о
      безусловной MCP output validation исправлено в `README.md` коммитом
      `7fc9543`.

## Публикация

- Merge `release/0.1.0` в `main`: **`54204db`** (`merge: release v0.1.0`). После
  merge полный `pnpm check` на `main` прошёл на Node `24.22.2`; tree совпадает с
  проверенным release HEAD `a351122`.
- Annotated tag: **`v0.1.0`**, tag object `f0ea649`, dereferenced commit
  **`54204db801abd17b37b4689e86e5c235c70dcbfa`**. `origin/main` и tag
  опубликованы без force-push.
- GitHub Release:
  https://github.com/ramgml/kanbaner/releases/tag/v0.1.0 — stable
  (`isPrerelease=false`, не draft) и latest.
- Assets: `kanbaner-0.1.0.tar.gz` и `kanbaner-0.1.0.tar.gz.sha256`. Архив создан
  от annotated tag; чистая frozen install, native SQLite/FTS5 и production build
  из него успешны.
- SHA-256:
  **`a9f001f28dbec05a8b9465124bdbd7ca0496b22c30dfdcdfaa5dda5b2e9d249f`**.
  Оба assets скачаны после публикации; checksum скачанного архива совпал.
- Обратный merge в `dev`: **`438ba16`**, полный `pnpm check` после merge зелёный.
- Следующая development-версия `0.2.0-dev.0`: коммит `767c04e`, merge
  **`7a7a973`**, полные проверки на ветке и `dev` зелёные. Первая попытка merge
  выявила известный flaky `project-settings` тест и была откачена; изолированный
  прогон **34/34** и повторная очередь с новым чистым коммитом успешны.
- Release-ветка удаляется после успешной интеграции; её RC history остаётся в
  `main`, `dev` и неизменном теге `v0.1.0-rc.0`.

## Известные риски

- Windows install/build/native SQLite/migrations/E2E не проверялись; это
  осознанный waiver, а не подтверждённая совместимость.
- Release-проверки backup/restore, обновления RC, архива и скачанных assets
  завершены. Dedicated `gitleaks` оставался недоступен; использованы явно
  описанные history/marker scans.
- Новый универсальный MCP по умолчанию не экспортирует destructive-операции и
  не подключается к базе данных; ручной OpenCode allowlist из 14 инструментов
  остаётся неизменным.
