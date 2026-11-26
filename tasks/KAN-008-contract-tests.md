---
id: KAN-008
title: Тестовый плагин и контрактные проверки
status: done
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

- [x] Создать `packages/plugin-fixture`.
- [x] Зарегистрировать тестовую команду.
- [x] Зарегистрировать тестовый запрос.
- [x] Публиковать тестовое событие после операции.
- [x] Зарегистрировать тестовый тип ресурса.
- [x] Добавить тестовую миграцию и данные.
- [x] Зарегистрировать UI-вклад.
- [x] Реализовать контрактный набор тестов.
- [x] Проверить дублирование command ID.
- [x] Проверить отсутствующую зависимость и цикл.
- [x] Проверить safe mode.
- [x] Проверить однократное применение миграции.
- [x] Проверить идемпотентность обработки события.
- [x] Проверить отсутствие импортов внутренностей ядра.
- [x] Добавить интеграционный запуск ядра с fixture-плагином.
- [x] Использовать отдельные in-memory provider instances для тестов.
- [x] Прогнать Storage Provider Conformance Suite на SQLite и in-memory provider.
- [x] Прогнать conformance suite на provider с асинхронными задержками.
- [x] Проверить отсутствие синхронных предположений в fixture-плагине.
- [x] Проверить production build с нативным `better-sqlite3`.
- [ ] Прогнать контрактные тесты на Linux и Windows. Linux проверен; Windows недоступен в текущем окружении.
- [x] Описать, как новый плагин использует контрактные тесты.

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

- [x] Fixture-плагин активируется только через публичный lifecycle.
- [x] Команда и запрос выполняются через общие шины.
- [x] Событие публикуется после успешной операции.
- [x] Тестовый ресурс разрешается через `ResourceRef`.
- [x] UI-вклад появляется в согласованном слоте.
- [x] Миграция применяется ровно один раз.
- [x] Дублирующийся command ID блокируется.
- [x] Отсутствующая зависимость блокирует только зависимый плагин.
- [x] Цикл зависимостей блокируется.
- [x] Ошибка плагина приводит к safe mode без падения ядра.
- [x] Повторная обработка события не создаёт дубль.
- [x] Импорт внутренностей ядра из плагина обнаруживается тестом.
- [x] Ядро не импортирует fixture-плагин в production-коде.
- [x] Добавлена инструкция запуска контрактных тестов в документацию.
- [x] Тесты не требуют Docker, внешней СУБД и TCP-порта.
- [x] E2E-сценарии выполняются на `@playwright/test` 1.65.
- [ ] Контрактные тесты проходят на Linux и Windows. Linux проверен; Windows не проверен.
- [x] Production build корректно загружает нативный модуль `better-sqlite3`.
- [x] Storage Provider Conformance Suite проходит на SQLite и in-memory provider.
- [x] Conformance suite проходит на provider с асинхронными задержками.
- [x] Fixture-плагин не содержит синхронных предположений о хранилище.
- [x] Все критерии этапа 1 из `specs/roadmap.md` проверены.

## Проверки

- [x] Typecheck.
- [x] Линтер.
- [x] Contract tests на Vitest 5.
- [x] Integration tests.
- [x] Проверка границ импортов.
- [x] Проверка отсутствия deprecated-зависимостей и unmet peer dependencies.
- [x] Production build.
- [x] In-memory provider integration tests.
- [x] SQLite provider conformance tests.
- [x] Delayed async provider conformance tests.
- [x] Linux test run.
- [ ] Windows test run — окружение недоступно, проверка не выполнялась.
- [x] Чистая база и повторный запуск миграций.

## Риски

- Контрактные тесты начнут зависеть от деталей реализации ядра. Проверять только публичное поведение.
- Fixture-плагин случайно попадёт в production bundle. Добавить проверку отсутствия зависимости.
- Различия Windows и Linux проявятся только в путях и production bundle. Обязательный matrix-run.
- Тесты ослабят ради зелёного результата. Любое расхождение со спецификацией эскалировать.

## Журнал

- 2026-11-07 — KAN-008 влита в `dev` merge-коммитом `109d9b5bcff55af2234c49019a1b2e88f4737a0b`; strict install, `check:imports`, полный check, Playwright и deferred SIGTERM зелёные на ветке и `dev`, финальное ревью разрешило интеграцию. Feature-ветка и worktree удалены, задача переведена в done; Windows-проверки явно оставлены невыполненными.
- 2026-11-07 — Worker коммитом `2a3a35b` подключил search cleanup и сделал reindex атомарным через provider transaction и per-plugin queues; 63 focused-теста, 37 Conformance integration, 733 workspace-теста, 7 E2E и deferred SIGTERM зелёные. Задача повторно в review.
- 2026-11-07 — Повторное ревью подтвердило закрытие 10 findings, но нашло неподключённый search cleanup в composition root и lost update при concurrent reindex. Требуется передать search service, выполнять замену индекса внутри provider transaction и сериализовать fixture-мутации с regression-тестами.
- 2026-11-07 — Worker коммитом `a52720a` реализовал bound PluginStorage, поисковый lifecycle, AST import boundaries и остальные исправления; 61 focused-тест, 37 Conformance integration, 729 workspace-тестов, 7 E2E и deferred SIGTERM зелёные. Задача повторно в review.
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

- Коммит: merge `109d9b5bcff55af2234c49019a1b2e88f4737a0b`; feature-коммиты `167bce3`, `c63e4dc`, `4360927`.
- Ветка: `feat/kan-008-contract-tests` влита в `dev`; ветка и worktree удалены после успеха.
- Проверки: strict frozen install, `check:imports` и self-test, полный `pnpm check`, 4 focused test files / 63 tests и 54 workspace test files / 733 tests, 37 integration Conformance-тестов на 4 provider-вариантах, 7 Playwright E2E и deferred-write SIGTERM test зелёные на ветке и `dev`; финальное ревью разрешило интеграцию.
- Остаточные риски: Windows и нативный `better-sqlite3` на Windows не проверены; полный provider Conformance выполняется в unit-тестах провайдеров, integration запускает выбранные 9 case на четырёх вариантах; E2E выполнен только в Chromium.
