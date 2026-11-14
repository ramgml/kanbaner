---
id: KAN-040
title: Стабилизировать contract-тесты под полной нагрузкой
status: done
stage: 1
priority: high
owner: opencode-worker
blocked_by: []
branch: fix/kan-040-contract-timeouts
worktree: .worktrees/kan-040-contract-timeouts
created: 2026-11-14
updated: 2026-11-14
specs:
  - specs/development-workflow.md
  - specs/plugin-contract.md
---

# KAN-040 — Стабилизировать contract-тесты под полной нагрузкой

## Цель

Устранить воспроизводимые 5-секундные timeout в полном `pnpm check`, которые дважды сорвали merge queue KAN-039.

## Результат

Полный набор тестов стабильно проходит без отключения проверок и скрытия реальных зависаний.

## Объём работ

- [x] Воспроизвести timeout `fixture-activation` и `task-list-disabled` в полном наборе.
- [x] Определить, является ли причиной cold start/нагрузка или дефект lifecycle.
- [x] Применить минимальное исправление тестовой инфраструктуры или lifecycle по доказанной причине.
- [x] Прогнать полный набор минимум дважды и `pnpm check`.

## Владение файлами

Разрешено:
- `tests/**`
- `packages/plugin-fixture/**`
- `vitest.config.ts`
- `tasks/reports/KAN-040.md`

Запрещено:
- продуктовые плагины и их публичные контракты;
- отключение/пропуск тестов, скрытие красных проверок;
- изменения KAN-039.

## Критерии приёмки

- [x] Причина timeout задокументирована.
- [x] Два последовательных полных test run зелёные.
- [x] `pnpm check` зелёный.
- [x] Тесты не удалены и не переведены в skip.

## Журнал

- 2026-11-14 — Задача создана по решению пользователя после двух срывов merge queue.
- 2026-11-14 — Профилирование подтвердило cold start composition root под нагрузкой; адресный timeout 30 секунд применён к четырём тяжёлым suite через `tests/suite-timeouts.ts`.
- 2026-11-14 — Ветка влита в `dev`; `pnpm check` после merge зелёный, worktree и feature-ветка удалены merge queue.

## Итог

- Коммит: worker `e6491e8`, merge `d1e6af1a098fdb4919853ff7acd92bbf9e669d1f`.
- Проверки: два полных `pnpm vitest run` по 1638/1638, `pnpm check` до и после merge, lint и format. E2E не запускались, тестовая инфраструктура UI не затронута.
