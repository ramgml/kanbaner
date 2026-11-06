---
id: KAN-004
title: Шина команд и запросов
status: done
stage: 1
priority: high
owner: worker-kan-004
blocked_by: []
branch: feat/kan-004-command-query-bus
worktree: .worktrees/kan-004-command-query-bus
created: 2026-11-06
updated: 2026-11-06
specs:
  - specs/technology-stack.md
  - specs/plugin-contract.md
  - specs/architecture.md
---

# KAN-004 — Шина команд и запросов

## Цель

Реализовать единый типизированный механизм регистрации и выполнения команд и запросов с валидацией, контекстом и стандартными ошибками.

## Результат

Плагин регистрирует mutation или query, а ядро проверяет уникальность ID, вход, выход и возвращает единый конверт результата.

## Объём работ

- [x] Реализовать реестр команд.
- [x] Реализовать реестр запросов.
- [x] Блокировать дублирующиеся operation ID.
- [x] Проверять metadata: kind, risk, exposure, version.
- [x] Валидировать вход по JSON Schema до вызова обработчика.
- [x] Валидировать выход в тестовом режиме.
- [x] Создавать контекст с `requestId`, `traceId` и `source`.
- [x] Передавать `idempotencyKey` без самостоятельного хранения.
- [x] Реализовать единый успешный конверт.
- [x] Реализовать конверт ошибок и маппинг исключений.
- [x] Поддержать cooperative cancellation через `AbortSignal`.
- [x] Ограничить глубину вложенных команд.
- [x] Обнаруживать циклы вложенных вызовов.
- [x] Добавить unit- и integration-тесты.

## Владение файлами

Разрешено:

- `packages/kernel/src/operations/**`;
- тесты внутри каталога.

Запрещено:

- `packages/kernel/src/plugins/**`;
- `packages/kernel/src/events/**`;
- `packages/kernel/src/resources/**`;
- `packages/kernel/src/storage/**`;
- `packages/plugin-sdk/**`;
- `apps/web/**`;
- `specs/**`;
- `tasks/**`, кроме собственного отчёта.

Общие файлы:

- Корневой composition point ядра и `packages/kernel/package.json` изменяются по координации с оркестратором.

## Контракты и зависимости

- Использует типы и конверты из KAN-002.
- Не реализует HTTP API.
- Не хранит idempotency-ключи в БД; передаёт ключ плагину.
- Не выполняет миграции и не публикует события.
- Не содержит определений конкретных команд.

## Критерии приёмки

- [x] Команда регистрируется и выполняется через шину.
- [x] Запрос регистрируется отдельно от mutation.
- [x] Дублирующийся ID отклоняется при регистрации.
- [x] Неверный вход не вызывает обработчик.
- [x] Ошибка валидации имеет код `VALIDATION_ERROR`.
- [x] Неизвестная операция возвращает `NOT_FOUND`.
- [x] `source` и `requestId` доступны обработчику.
- [x] `traceId` сохраняется во вложенных вызовах.
- [x] Циклический вызов завершается ошибкой.
- [x] Отмена через `AbortSignal` возвращает `CANCELLED`.
- [x] Внутренние стектрейсы не попадают во внешний конверт.

## Проверки

- [x] Typecheck.
- [x] Линтер.
- [x] Unit-тесты реестра и конвертов.
- [x] Integration-тест выполнения команды тестового плагина.
- [x] Тесты таймаута, отмены и вложенных вызовов.

## Риски

- Шина станет скрытым сервис-локатором. Разрешить только публичные операции и явный контекст.
- Двойная валидация схем. Использовать общий валидатор SDK.
- Неясная семантика отмены после записи. Не обещать откат уже закоммиченной операции.

## Журнал

- 2026-11-06 — KAN-004 влита в `dev` merge-коммитом `ebd7d49007df185791a15ff1608fa1987533bd9b`; merge queue зелёный на ветке и `dev`, повторное ревью разрешило интеграцию. Feature-ветка и worktree удалены, задача переведена в done.
- 2026-11-06 — Worker коммитом `02ce495` устранил abort-race и остальные findings, добавил внешний requestId, immutable metadata, timeout retryable=false и generic ResourceService error adapter. 70 focused-тестов операций и 222 теста workspace зелёные, задача повторно в review.
- 2026-11-06 — Независимое ревью нашло blocker гонки abort до фактического старта handler, небезопасный retryable TIMEOUT, отсутствие внешнего requestId, изменяемые metadata и потерю кодов ResourceServiceError. Задача возвращена worker-у; ветка перебазируется на dev с KAN-005 для integration-адаптера.
- 2026-11-06 — Worker завершил шину операций коммитом `a8fd6a4`; 55 focused-тестов и 143 теста workspace, strict install и полный check зелёные. Создан `tasks/reports/KAN-004.md`, задача переведена в review.
- 2026-11-06 — KAN-001/KAN-002 завершены. Оркестратор подтвердил готовность, назначил worker-kan-004, ветку `feat/kan-004-command-query-bus` и worktree `.worktrees/kan-004-command-query-bus`; корневой index ядра остаётся за оркестратором.
- 2026-11-06 — Задача создана.

## Итог

- Коммит: merge `ebd7d49007df185791a15ff1608fa1987533bd9b`; feature-коммиты `19e046c` и `cecc7df`.
- Ветка: `feat/kan-004-command-query-bus` влита в `dev`; ветка и worktree удалены после успеха.
- Проверки: strict frozen install, полный `pnpm check`, 4 focused test files / 70 tests и 21 workspace test file / 222 tests, production build и `git diff --check` зелёные; повторное ревью разрешило интеграцию.
- Остаточные риски: отмена/timeout не откатывают записи; идемпотентность реализует доменный плагин; корневой exports и ResourceService mapper подключает оркестратор в composition root; Windows не проверен.
