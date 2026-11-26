---
id: KAN-020
title: Настройки вне рабочей навигации
status: done
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

- [x] Убрать «Плагины» и «Настройки» из основной sidebar.
- [x] Добавить компактную кнопку настроек внизу sidebar и в мобильную
  навигацию.
- [x] Добавить `/settings/plugins` с текущим plugin manager без изменения его
  поведения.
- [x] Сделать redirect `/plugins` → `/settings/plugins`.
- [x] Обновить safe mode links и связанные тесты.
- [x] Проверить клавиатуру, 360 px, enable/disable плагинов и прежние E2E.
- [x] Обновить документацию и отчёт `tasks/reports/KAN-020.md`.

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

- [x] Sidebar не содержит редкие пункты администрирования.
- [x] Настройки доступны одной компактной кнопкой на всех viewport.
- [x] `/settings/plugins` работает, `/plugins` перенаправляет.
- [x] Safe mode ведёт на `/settings/plugins`.
- [x] Все проверки зелёные.

## Проверки

- [x] Typecheck, линтер, component/integration tests.
- [x] `pnpm check:imports`, полный `pnpm check`.
- [x] Все Playwright E2E, deferred SIGTERM.

## Риски

- Пользователь может не найти plugin manager. Смягчение: иконка с доступным
  label, сохранение `/plugins` redirect и safe mode ссылки.

## Журнал

- 2026-11-09 — KAN-020 влита в `dev` merge-коммитом
  `0e7a040d0c9ae84a33f24be234b5043841219bb2`; strict install, check:imports,
  полный check, 64 E2E и deferred SIGTERM зелёные на ветке и `dev`, ревью
  разрешило интеграцию. Feature-ветка и worktree удалены, задача done.
- 2026-11-09 — Задача создана по предложению пользователя упростить sidebar.

## Итог

- Коммит: merge `0e7a040d0c9ae84a33f24be234b5043841219bb2`; feature-коммит
  `9cc1a48`.
- Ветка: `feat/kan-020-settings-navigation` влита в `dev`; ветка и worktree
  удалены.
- Проверки: strict frozen install, `check:imports`, полный `pnpm check`,
  Playwright и deferred SIGTERM на ветке и `dev`; 91 workspace files / 1181
  tests, 64 production E2E.
- Остаточные риски: `/plugins` использует временный redirect 307; Windows и
  другие браузеры не проверялись.
