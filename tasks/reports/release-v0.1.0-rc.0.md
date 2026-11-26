# Release v0.1.0-rc.0

Дата публикации: 2026-11-22.

## Решение и границы

Пользователь явно выбрал публикацию текущего среза как **prerelease**
`v0.1.0-rc.0`, а не стабильный `0.1.0`. Это разовое исключение из правила «нет
публичных релизов до завершения этапа 8», не изменяющее общий workflow.

В release notes прямо зафиксировано:

- отдельный глобальный search-плагин и универсальный discovery-driven MCP ещё
  не реализованы, поэтому Definition of Done MVP не закрыт;
- по решению пользователя выполнены полные Linux-проверки, но новая чистая
  Windows-проверка не выполнялась;
- RC не влит в `main`, поскольку `main` предназначен для стабильных релизов;
  `release/0.1.0` сохранена для последующего stable и исправлений RC.

## Коммиты и ветки

- `c5d7f62` — интеграция OpenCode, HTTP API/CLI и обновление интерфейса;
- `8d223a7` — завершение KAN-054–KAN-058;
- `88d600d` — `chore: release v0.1.0-rc.0`;
- `f99fee3` — исправление документированной offline restore команды.

`dev` и `release/0.1.0` опубликованы. Версия development-ветки не менялась после
RC; следующий development bump относится к будущему stable-процессу.

## Версии

- Application и private workspace packages: `0.1.0-rc.0`.
- Production built-in plugin manifests: `0.1.0-rc.0`.
- `kanbaner.projects` требует `kanbaner.tasks ^0.1.0-rc.0`.
- Plugin Contract: независимый `v1`; Host API: `1.0.0`.
- Fixtures и generic SemVer examples не изменялись.

## Проверки перед публикацией

- Frozen strict install, без deprecated-зависимостей и unmet peer dependencies.
- `pnpm check`: format, lint, typecheck, **136 test files / 1844 tests** и
  production build.
- Полный production Playwright Chromium: **151/151**.
- `pnpm check:imports`, `pnpm test:sqlite` и `pnpm check:composition` — успешно.
- Production smoke на чистой базе: проект создан, повторный запуск успешен,
  данные сохранены, миграции не мешают повторному bootstrap.
- Online `.backup()` активного provider: `integrity: ok`, 122880 bytes / 30 pages.
- Offline restore через `scripts/restore.mjs` в новый каталог, затем production
  запуск восстановленной базы и проверка сохранённого проекта.
- Source archive от финального `f99fee3`: чистая frozen install, native
  `better-sqlite3` smoke и production build успешны.
- Git history: не найдено tracked secret/data files и распространённых
  private-key/GitHub-token markers. Dedicated gitleaks в окружении отсутствовал.
- Независимый release review: blocker/high/medium отсутствуют; low-замечания о
  версии в `plugin-projects/README` и Plugin Contract/Host API в changelog
  исправлены до публикации.

Найденная в ходе проверки документационная ошибка `pnpm storage:restore --
--backup ...` исправлена на рабочую команду без дополнительного `--`; restore
после этого фактически выполнен.

## Публикация

- Tag: annotated `v0.1.0-rc.0`, dereferenced commit
  `f99fee39b35ca50f4ca74ee2cf41c72b713b5d3d`.
- Release: https://github.com/ramgml/kanbaner/releases/tag/v0.1.0-rc.0
- GitHub Release имеет `isPrerelease: true`.
- Assets:
  - `kanbaner-0.1.0-rc.0.tar.gz` — проверенный source archive с lockfile,
    документацией и changelog;
  - `kanbaner-0.1.0-rc.0.tar.gz.sha256` — SHA-256.
- SHA-256:
  `4d19f9dab7e95c25a1d148202e328c6821ac5037fd38050dea973807a4576cfb`.
- Оба assets после публикации скачаны; checksum скачанного архива совпал.

## Остаточные риски

- Windows install/build/native SQLite/миграции/E2E не проверялись на этом RC.
- Отдельный search и универсальный MCP остаются обязательными для закрытия MVP
  Definition of Done перед stable `0.1.0`.
- Production build сохраняет 6 прежних Turbopack warnings о dynamic filesystem
  tracing в `kernel` и `storage-sqlite`; ошибок сборки нет.
- Release-ветка намеренно не удалена и не влита в `main`/`dev`: она нужна для
  RC-исправлений и последующего stable. Локальный release worktree удалён после
  успешной публикации.
