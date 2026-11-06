---
id: KAN-001
title: Каркас репозитория, workspace и SQLite
status: review
stage: 1
priority: high
owner: worker-kan-001
blocked_by: []
branch: feat/kan-001-repository-scaffold
worktree: .worktrees/kan-001-repository-scaffold
created: 2026-11-06
updated: 2026-11-06
specs:
  - specs/product-mvp.md
  - specs/technology-stack.md
  - specs/architecture.md
  - specs/development-workflow.md
  - specs/roadmap.md
---

# KAN-001 — Каркас репозитория, workspace и SQLite

## Цель

Создать воспроизводимый кроссплатформенный TypeScript-workspace для приложения и плагинов, чтобы последующие задачи реализовывались в стабильных границах пакетов.

## Результат

Чистый checkout устанавливает зависимости и запускает базовое Next.js-приложение на Linux и Windows. Typecheck, линтер, тесты и сборка доступны едиными кроссплатформенными командами. `better-sqlite3` подключён и проходит smoke-проверку. Версия приложения — `0.1.0-dev.0`, пакеты остаются private.

## Объём работ

- [ ] Создать private pnpm workspace с версией приложения `0.1.0-dev.0` и корневыми скриптами.
- [ ] Зафиксировать Node.js 24.22.2 и pnpm 12.18 через `engines` и `packageManager`.
- [ ] Создать пакеты `kernel` и `plugin-sdk` без доменной логики.
- [ ] Создать базовое приложение `apps/web` на Next.js 16 с Node.js runtime.
- [ ] Создать server composition root приложения без Storage Provider и доменных плагинов.
- [ ] Включить строгую проверку TypeScript 6.0.x.
- [ ] Настроить ESLint 10 с `eslint-config-next` и `typescript-eslint`, Prettier 3.
- [ ] Настроить Vitest 5 с обязательным Vite 8 и smoke-тест.
- [ ] Добавить обязательные peer-пакеты Testing Library, Tailwind и shadcn/ui по `specs/technology-stack.md`.
- [ ] Добавить зависимости `better-sqlite3` и `@types/better-sqlite3`.
- [ ] Добавить smoke-тест in-memory SQLite с `SELECT 1`.
- [ ] Добавить `.gitignore` и `.env.example` без секретов.
- [ ] Добавить `CHANGELOG.md` с пустым разделом `Unreleased`.
- [ ] Описать `KANBANER_DATA_DIR` и кроссплатформенные каталоги данных.
- [ ] Убедиться, что скрипты не зависят от bash и Unix-утилит.
- [ ] Добавить инструкции запуска для Linux и Windows в `README.md`.
- [ ] Заполнить раздел `## 14. Команды проекта` в `AGENTS.md`.

## Владение файлами

Разрешено:

- корневые конфигурационные файлы workspace, TypeScript, линтера, форматтера и тестов;
- lock-файл `pnpm-lock.yaml`;
- `.gitignore`;
- `.env.example`;
- `CHANGELOG.md`;
- `apps/web/**`;
- `packages/kernel/**`;
- `packages/plugin-sdk/**`;
- `README.md`;
- раздел `## 14. Команды проекта` в `AGENTS.md`.

Запрещено:

- `specs/**`;
- `tasks/**`, кроме собственного отчёта;
- реализация задач, заметок, канбана, поиска, HTTP API или MCP;
- доменные таблицы и миграции плагинов;
- Storage Provider Registry, Store-контракты и миграционный runner;
- `compose.yaml`, Dockerfile и конфигурация внешней СУБД.

Общие файлы:

- Корневой `package.json` и lock-файл принадлежат этой задаче до её завершения.
- Будущие изменения корневых зависимостей требуют координации с оркестратором.

## Контракты и зависимости

- Использует архитектурные решения из `specs/architecture.md`.
- Использует технологии и версии из `specs/technology-stack.md`.
- Работает в ветке `feat/kan-001-repository-scaffold` от `dev` согласно `specs/development-workflow.md`.
- Корневая версия приложения — `0.1.0-dev.0`; пакеты workspace остаются private.
- Package manager — pnpm 12; TypeScript — 6.0.x; test runner — Vitest 5; линтер — ESLint 9; форматтер — Prettier 3.
- Установка не содержит unmet peer dependencies; единственный deprecated-пакет — явно разрешённый спецификацией `eslint@9.39.x`.
- SQLite WAL является единственным backend MVP.
- `better-sqlite3` используется как драйвер SQLite.
- Пакет `pg` и `DATABASE_URL` не добавляются.
- Docker и внешняя СУБД не используются.
- Не создаёт публичных команд, событий или ресурсов.
- Создаёт только каркас пакетов и smoke-проверку драйвера.
- Storage Provider Registry, Store-контракты и миграции входят в KAN-006.
- SQLite-провайдер, WAL-настройки, FTS5 и backup входят в KAN-009.
- Проверка production-загрузки нативного модуля входит в KAN-009, где появляется реальный провайдер.
- Application composition root находится в `apps/web`; регистрация Storage Provider добавляется в KAN-009 по координации.

## Критерии приёмки

- [ ] Чистая установка зависимостей завершается успешно на Linux и Windows.
- [ ] Установка проходит с `--strict-peer-dependencies` без предупреждений.
- [ ] В дереве зависимостей нет deprecated-пакетов, кроме явно разрешённого спецификацией `eslint@9.39.x`.
- [ ] Базовое приложение запускается и открывает страницу-заглушку.
- [ ] Server composition root запускается и не содержит доменной логики или Storage Provider.
- [ ] `build`, `typecheck`, `lint` и `test` доступны документированными командами.
- [ ] TypeScript работает в строгом режиме.
- [ ] Пакеты `kernel` и `plugin-sdk` собираются и импортируются.
- [ ] In-memory SQLite выполняет `SELECT 1` в smoke-тесте.
- [ ] `better-sqlite3` устанавливается из prebuilt binary или собирается из исходников на обеих ОС.
- [ ] Production build не использует Edge runtime для серверной части.
- [ ] Команды запуска не требуют bash, Docker или установленного сервера БД.
- [ ] В репозитории нет секретов.
- [ ] `README.md` описывает запуск на Linux и Windows.
- [ ] `AGENTS.md` содержит фактические кроссплатформенные команды проекта.
- [ ] Версии и инструменты соответствуют `specs/technology-stack.md`.
- [ ] Корневая версия — `0.1.0-dev.0`, все пакеты workspace private.
- [ ] `CHANGELOG.md` существует и содержит раздел `Unreleased`.
- [ ] Доменной логики и плагинных функций нет.

## Проверки

- [ ] Установка зависимостей на Linux.
- [ ] Установка зависимостей на Windows.
- [ ] Установка с `--strict-peer-dependencies` и разбор предупреждений.
- [ ] Проверка отсутствия deprecated-зависимостей.
- [ ] Typecheck.
- [ ] Линтер.
- [ ] Unit-тест и SQLite smoke-тест.
- [ ] Production build приложения без проверки реального провайдера.
- [ ] Запуск приложения.
- [ ] Проверка запуска server composition root.
- [ ] Проверка отсутствия Docker-конфигурации.
- [ ] Проверка отсутствия секретов в отслеживаемых файлах.
- [ ] Проверка версии `0.1.0-dev.0` и private-статуса пакетов.

## Риски

- Слишком тяжёлый стартовый набор зависимостей. Ограничиться инструментами, нужными для каркаса.
- Нативный модуль `better-sqlite3` может требовать сборки из исходников. Проверить prebuilt binaries и toolchain на обеих ОС.
- Отклонение от `specs/technology-stack.md`. Не заменять зафиксированные инструменты аналогами без решения пользователя.
- TypeScript 7 несовместим с текущим `typescript-eslint` и `eslint-config-next`. Оставаться на `6.0.x` до появления совместимого lint-стека.
- Peer-зависимости Vitest, Testing Library, MCP и Tailwind могут быть пропущены при ручном наборе пакетов. Сверять установку со спецификацией и `--strict-peer-dependencies`.
- Расхождение документации и команд. Обновить `README.md` и `AGENTS.md` в этой же задаче.
- Unix-only команды в скриптах. Использовать кроссплатформенные Node.js-скрипты.

## Журнал

- 2026-11-06 — Worker коммитом `403ad00` исключил `.worktrees` из Git, Prettier и ESLint; focused-проверка ignore-правил и полный `pnpm check` зелёные, задача готова к повторной интеграции.
- 2026-11-06 — Первая интеграция остановлена на проверке `dev`: Prettier просканировал вложенный `.worktrees`. Merge откачен инструментом через revert; требуется исключить служебные worktree из конфигурации проверок и повторить интеграцию.
- 2026-11-06 — Worker исправил замечание ревью коммитом `d728a66`: добавлен `.gitattributes` с LF, полный `pnpm check` зелёный; задача повторно переведена в review.
- 2026-11-06 — Независимое ревью нашло риск CRLF при Windows checkout: для воспроизводимого Prettier check требуется `.gitattributes` с LF. Задача возвращена worker-у для исправления.
- 2026-11-06 — Worker завершил реализацию коммитами `abc6524` и `c297024`, создал `tasks/reports/KAN-001.md`; Linux-проверки зелёные, задача переведена в review для независимого ревью и интеграции.
- 2026-11-06 — Пользователь явно разрешил временный deprecated `eslint@9.39.x` как единственное исключение; спецификация обновлена, строгие peer-проверки сохранены, задача возвращена в работу.
- 2026-11-06 — После коммита worker-а проверка npm registry показала, что все стабильные версии ESLint 9 deprecated. Для завершения требуется явное исключение либо из запрета deprecated (ESLint 9), либо из peer-совместимости (ESLint 10); интеграция приостановлена до решения пользователя.
- 2026-11-06 — Пользователь выбрал переход на ESLint 9.x для сохранения строгой peer-совместимости; `specs/technology-stack.md` обновлён, задача возвращена в работу.
- 2026-11-06 — Реализация приостановлена перед коммитом: `eslint-config-next@16.4.5` и актуальные версии его транзитивных плагинов не объявляют peer-поддержку ESLint 10. Требуется решение пользователя: изменить версию ESLint в спецификации либо официально разрешить локальное расширение peer-диапазонов.
- 2026-11-06 — Оркестратор назначил worker-kan-001, создана ветка `feat/kan-001-repository-scaffold` и worktree `.worktrees/kan-001-repository-scaffold`.
- 2026-11-06 — Задача создана.
- 2026-11-06 — Хранилище изменено с внешнего PostgreSQL на PGlite; добавлены требования Linux/Windows.
- 2026-11-06 — PGlite заменён на SQLite WAL и `better-sqlite3`.
- 2026-11-06 — Production-проверка нативного модуля перенесена в KAN-009.
- 2026-11-06 — Добавлен server composition root в `apps/web` без Storage Provider.
- 2026-11-06 — Инструменты привязаны к `specs/technology-stack.md`.
- 2026-11-06 — Версии сверены с npm registry: Node.js 24.22.2, TypeScript 6.0.3 и обязательные peer-пакеты.
- 2026-11-06 — Зафиксированы GitFlow, версия `0.1.0-dev.0` и `CHANGELOG.md` согласно `specs/development-workflow.md`.

## Итог

Заполняется оркестратором после интеграции:

- Коммит:
- Ветка:
- Проверки:
- Остаточные риски:
