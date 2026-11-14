---
id: KAN-040
title: Стабилизировать contract-тесты под полной нагрузкой
status: in_progress
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

- [ ] Воспроизвести timeout `fixture-activation` и `task-list-disabled` в полном наборе.
- [ ] Определить, является ли причиной cold start/нагрузка или дефект lifecycle.
- [ ] Применить минимальное исправление тестовой инфраструктуры или lifecycle по доказанной причине.
- [ ] Прогнать полный набор минимум дважды и `pnpm check`.

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

- [ ] Причина timeout задокументирована.
- [ ] Два последовательных полных test run зелёные.
- [ ] `pnpm check` зелёный.
- [ ] Тесты не удалены и не переведены в skip.

## Журнал

- 2026-11-14 — Задача создана по решению пользователя после двух срывов merge queue.

## Итог

- Коммит:
- Проверки:
