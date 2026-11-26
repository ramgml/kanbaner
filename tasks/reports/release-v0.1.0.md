# Release v0.1.0

Статус: **draft подготовки release-ветки**. Публикация, тег и проверки
оркестратора ещё не выполнены.

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

Раздел заполняется по факту; в draft-отчёте результаты не предполагаются.

- [ ] Полный production Playwright Chromium
- [ ] Production smoke на чистой базе и повторный запуск
- [ ] Online backup активного Storage Provider (`.backup()`)
- [ ] Offline restore в новый каталог и запуск восстановленной базы
- [ ] Source archive: чистая frozen install, native `better-sqlite3` smoke,
      production build
- [ ] Проверка отсутствия секретов
- [ ] Release review

## Публикация

Раздел заполняется оркестратором после мержа и тега; значения ниже намеренно
не заполнены.

- Merge `release/0.1.0` в `main`: не выполнялся.
- Annotated tag `v0.1.0`: не создавался.
- GitHub Release и assets: не публиковались.
- SHA-256 архива: не вычислялся.
- Merge обратно в `dev` и следующий development bump: не выполнялись.

## Известные риски

- Windows install/build/native SQLite/migrations/E2E не проверялись; это
  осознанный waiver, а не подтверждённая совместимость.
- Release-проверки backup/restore, архива и публикации выполняет оркестратор
  после этого коммита.
- Новый универсальный MCP по умолчанию не экспортирует destructive-операции и
  не подключается к базе данных; ручной OpenCode allowlist из 14 инструментов
  остаётся неизменным.
