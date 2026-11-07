---
id: KAN-008
title: Тестовый плагин и контрактные проверки
status: in_progress
stage: 1
priority: high
owner: worker-kan-008
blocked_by: []
branch: feat/kan-008-contract-tests
worktree: .worktrees/kan-008-contract-tests
created: 2026-11-06
updated: 2026-11-07
specs:
  - specs/technology-stack.md
  - specs/plugin-contract.md
  - specs/architecture.md
  - specs/roadmap.md
---

# KAN-008 — Тестовый плагин и контрактные проверки

## Цель

Доказать, что ядро расширяется только через публичный SDK, и зафиксировать обязательные проверки Plugin Contract v1.

## Результат

Тестовый плагин регистрирует команду, запрос, событие, ресурс, миграцию и UI-вклад. Контрактный набор проверок проходит без импорта внутренностей ядра.

## Объём работ

- [ ] Создать `packages/plugin-fixture`.
- [ ] Зарегистрировать тестовую команду.
- [ ] Зарегистрировать тестовый запрос.
- [ ] Публиковать тестовое событие после операции.
- [ ] Зарегистрировать тестовый тип ресурса.
- [ ] Добавить тестовую миграцию и данные.
- [ ] Зарегистрировать UI-вклад.
- [ ] Реализовать контрактный набор тестов.
- [ ] Проверить дублирование command ID.
- [ ] Проверить отсутствующую зависимость и цикл.
- [ ] Проверить safe mode.
- [ ] Проверить однократное применение миграции.
- [ ] Проверить идемпотентность обработки события.
- [ ] Проверить отсутствие импортов внутренностей ядра.
- [ ] Добавить интеграционный запуск ядра с fixture-плагином.
- [ ] Использовать отдельные in-memory provider instances для тестов.
- [ ] Прогнать Storage Provider Conformance Suite на SQLite и in-memory provider.
- [ ] Прогнать conformance suite на provider с асинхронными задержками.
- [ ] Проверить отсутствие синхронных предположений в fixture-плагине.
- [ ] Проверить production build с нативным `better-sqlite3`.
- [ ] Прогнать контрактные тесты на Linux и Windows.
- [ ] Описать, как новый плагин использует контрактные тесты.

## Владение файлами

Разрешено:

- `packages/plugin-fixture/**`;
- `tests/contract/**`;
- `tests/integration/**`;
- `scripts/check-import-boundaries.*`;
- публичные lifecycle/execution-контракты SDK и их реализации в KAN-003/KAN-004/KAN-005, только для согласованного расширения;
- bootstrap/composition-файлы `apps/web/src/server/**`, UI composition и E2E, только для общих сервисов и fixture-проверок;
- корневой `package.json`, `vitest.config.ts`, `tsconfig.tools.json` и lock-файл по координации с оркестратором;
- собственный отчёт `tasks/reports/KAN-008.md`.

Запрещено:

- изменение ядра кроме явно согласованного расширения lifecycle и composition services;
- ослабление Plugin Contract без решения пользователя;
- `specs/**`;
- файлы задач, кроме собственного отчёта;
- доменные плагины `tasks`, `notes`, `kanban` и `search`.

Общие файлы:

- Корневой `package.json`, lock-файл и общая конфигурация тестов изменяются по координации с оркестратором.
- При конфликте между тестом и спецификацией остановиться и сообщить о расхождении.

## Контракты и зависимости

- Использует только `@kanbaner/plugin-sdk`.
- Тесты выполняются на Vitest 5 с обязательным Vite 8; E2E — на `@playwright/test` 1.65 согласно `specs/technology-stack.md`.
- В тестовой установке нет deprecated-пакетов и unmet peer dependencies.
- Тесты не требуют Docker, Testcontainers или внешней СУБД.
- Зависит от завершённых KAN-002 — KAN-007 и KAN-009.
- Не добавляет production-зависимость ядра от fixture-плагина.
- Контрактные тесты должны быть пригодны для будущих сторонних плагинов.
- Один набор проверок хранилища запускается на SQLite и in-memory provider.

## Критерии приёмки

- [ ] Fixture-плагин активируется только через публичный lifecycle.
- [ ] Команда и запрос выполняются через общие шины.
- [ ] Событие публикуется после успешной операции.
- [ ] Тестовый ресурс разрешается через `ResourceRef`.
- [ ] UI-вклад появляется в согласованном слоте.
- [ ] Миграция применяется ровно один раз.
- [ ] Дублирующийся command ID блокируется.
- [ ] Отсутствующая зависимость блокирует только зависимый плагин.
- [ ] Цикл зависимостей блокируется.
- [ ] Ошибка плагина приводит к safe mode без падения ядра.
- [ ] Повторная обработка события не создаёт дубль.
- [ ] Импорт внутренностей ядра из плагина обнаруживается тестом.
- [ ] Ядро не импортирует fixture-плагин в production-коде.
- [ ] Добавлена инструкция запуска контрактных тестов в документацию.
- [ ] Тесты не требуют Docker, внешней СУБД и TCP-порта.
- [ ] E2E-сценарии выполняются на `@playwright/test` 1.65.
- [ ] Контрактные тесты проходят на Linux и Windows.
- [ ] Production build корректно загружает нативный модуль `better-sqlite3`.
- [ ] Storage Provider Conformance Suite проходит на SQLite и in-memory provider.
- [ ] Conformance suite проходит на provider с асинхронными задержками.
- [ ] Fixture-плагин не содержит синхронных предположений о хранилище.
- [ ] Все критерии этапа 1 из `specs/roadmap.md` проверены.

## Проверки

- [ ] Typecheck.
- [ ] Линтер.
- [ ] Contract tests на Vitest 5.
- [ ] Integration tests.
- [ ] Проверка границ импортов.
- [ ] Проверка отсутствия deprecated-зависимостей и unmet peer dependencies.
- [ ] Production build.
- [ ] In-memory provider integration tests.
- [ ] SQLite provider conformance tests.
- [ ] Delayed async provider conformance tests.
- [ ] Linux test run.
- [ ] Windows test run.
- [ ] Чистая база и повторный запуск миграций.

## Риски

- Контрактные тесты начнут зависеть от деталей реализации ядра. Проверять только публичное поведение.
- Fixture-плагин случайно попадёт в production bundle. Добавить проверку отсутствия зависимости.
- Различия Windows и Linux проявятся только в путях и production bundle. Обязательный matrix-run.
- Тесты ослабят ради зелёного результата. Любое расхождение со спецификацией эскалировать.

## Журнал

- 2026-11-07 — Независимое ревью нашло blocker raw StorageProvider в plugin context и отсутствие обязательного search provider, а также transaction/event lifecycle/ownership/import-boundary/pagination дефекты. Задача возвращена worker-у для bound Storage facade, поискового lifecycle и остальных исправлений без изменения storage providers.
- 2026-11-07 — Worker завершил fixture и контрактные проверки коммитом `9424ad9`; 53 focused-теста, 37 Conformance integration, 718 workspace-тестов, 7 Playwright E2E и deferred SIGTERM test зелёные. `check:imports` и self-test работают, production fixture загружается через public lifecycle. Создан отчёт, задача переведена в review.
- 2026-11-07 — Пользователь выбрал расширение lifecycle. Оркестратор назначил worker-kan-008, ветку `feat/kan-008-contract-tests` и worktree `.worktrees/kan-008-contract-tests`; разрешены точечные изменения SDK/KAN-003/KAN-004/KAN-005 и composition services для commands/queries/resources/storage/events, обновление Plugin Contract и согласованных test configs.
- 2026-11-07 — Все зависимости завершены, но запуск заблокирован конфликтом: фактический `PluginActivationContext` из KAN-003 содержит только `pluginId`, `manifest`, `directory`, `hostApiVersion`, `logger`, тогда как fixture должен зарегистрировать commands/queries/events/resources через lifecycle без изменения ядра. Требуется явное решение пользователя о расширении composition-контракта и границ KAN-008.
- 2026-11-06 — Задача создана.
- 2026-11-06 — Добавлены in-memory PGlite и matrix Linux/Windows.
- 2026-11-06 — PGlite заменён на SQLite WAL; добавлен Storage Provider Conformance Suite.
- 2026-11-06 — Добавлена проверка provider с асинхронными задержками.
- 2026-11-06 — Инструменты тестирования привязаны к `specs/technology-stack.md`.
- 2026-11-06 — E2E-пакет уточнён до `@playwright/test`; добавлены проверки peer-зависимостей.

## Итог

Заполняется оркестратором после интеграции:

- Коммит:
- Ветка:
- Проверки:
- Остаточные риски:
