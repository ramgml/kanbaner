---
id: KAN-020
title: Настройки вне рабочей навигации
status: in_progress
stage: 3
priority: medium
owner: worker-kan-020
blocked_by: []
branch: feat/kan-020-settings-navigation
worktree: .worktrees/kan-020-settings-navigation
created: 2026-11-09
updated: 2026-11-09
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-020 — Настройки вне рабочей навигации

## Цель

Оставить в рабочей навигации только проекты и представления задач. Перенести
plugin manager в настройки, убрать редко используемые пункты из sidebar.

## Результат

- Sidebar содержит проекты, переключатель представления и компактную иконку
  настроек.
- `/settings/plugins` содержит текущий plugin manager.
- `/plugins` перенаправляет на `/settings/plugins`.
- Safe mode ведёт в настройки плагинов.
- Мобильная навигация сохраняет доступ к настройкам через компактную иконку.

## Объём работ

- [ ] Убрать «Плагины» и «Настройки» из основной sidebar.
- [ ] Добавить компактную кнопку настроек внизу sidebar и в мобильную
  навигацию.
- [ ] Добавить `/settings/plugins` с текущим plugin manager без изменения его
  поведения.
- [ ] Сделать redirect `/plugins` → `/settings/plugins`.
- [ ] Обновить safe mode links и связанные тесты.
- [ ] Проверить клавиатуру, 360 px, enable/disable плагинов и прежние E2E.
- [ ] Обновить документацию и отчёт `tasks/reports/KAN-020.md`.

## Владение файлами

Разрешено:

- `apps/web/src/components/shell/**`;
- `apps/web/src/app/settings/**`, `apps/web/src/app/plugins/**`;
- `apps/web/e2e/**` по необходимости;
- `tasks/reports/KAN-020.md`.

Запрещено:

- kernel, SDK, storage, plugin-tasks, plugin-projects internals, specs/tasks.

## Контракты и зависимости

- Зависит от KAN-019.
- Plugin manager и plugin lifecycle не меняются, меняется только навигация.

## Критерии приёмки

- [ ] Sidebar не содержит редкие пункты администрирования.
- [ ] Настройки доступны одной компактной кнопкой на всех viewport.
- [ ] `/settings/plugins` работает, `/plugins` перенаправляет.
- [ ] Safe mode ведёт на `/settings/plugins`.
- [ ] Все проверки зелёные.

## Проверки

- [ ] Typecheck, линтер, component/integration tests.
- [ ] `pnpm check:imports`, полный `pnpm check`.
- [ ] Все Playwright E2E, deferred SIGTERM.

## Риски

- Пользователь может не найти plugin manager. Смягчение: иконка с доступным
  label, сохранение `/plugins` redirect и safe mode ссылки.

## Журнал

- 2026-11-09 — Задача создана по предложению пользователя упростить sidebar.

## Итог

Заполняется оркестратором после интеграции:

- Коммит:
- Ветка:
- Проверки:
- Остаточные риски:
