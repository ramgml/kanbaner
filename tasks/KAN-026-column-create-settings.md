---
id: KAN-026
title: Создание колонок в настройках доски
status: done
stage: 3
priority: medium
owner: worker-kan-026
blocked_by: []
branch: feat/kan-026-column-create-settings
worktree: .worktrees/kan-026-column-create-settings
created: 2026-11-10
updated: 2026-11-10
specs:
  - specs/product-mvp.md
  - specs/plugin-contract.md
---

# KAN-026 — Создание колонок в настройках доски

## Цель

Собрать управление колонками в модалке «Настройки доски» и убрать отдельную
кнопку создания с основной доски.

## Результат

- В модалке можно создать колонку с названием и типом `open` или `done`.
- Новая колонка добавляется в конец через существующую `column.create`.
- Кнопки `+ Добавить колонку` на основной доски больше нет.
- Создание работает из канбана и списка; после успеха видны новая колонка и
  пустое состояние без reload.

## Объём работ

- [x] Перенести/повторно использовать форму создания в ProjectSettings.
- [x] Сохранить title/type validation, double-submit guard, ошибки без потери
  ввода, focus/Escape, expected project/generation guards и awaited refresh.
- [x] Удалить board add-column UI и неиспользуемый код; меню удаления и тип
  существующих колонок не менять.
- [x] Обновить component/E2E: создание open/Done из обоих представлений,
  persistence, конфликт/refresh error, mobile 360, прежние reorder/rename.
- [x] Обновить README и отчёт `tasks/reports/KAN-026.md`.

## Владение файлами

Разрешено:

- `packages/plugin-projects/**`;
- `apps/web/e2e/**` связанные сценарии;
- `tasks/reports/KAN-026.md`.

Запрещено:

- домен, kernel, SDK, storage, task-ui, спецификации и другие задачи;
- новые зависимости и публичные контракты.

## Критерии приёмки

- [x] Колонки создаются только из настроек доски.
- [x] Тип и порядок сохраняются после reload.
- [x] Ошибки и race не создают дубликаты.
- [x] Все проверки зелёные.

## Проверки

- [x] Strict install, check:imports, полный `pnpm check`.
- [x] Все Playwright и deferred SIGTERM.

## Риски

- Форма в настройках может рассинхронизировать список после создания.
  Смягчение: единый awaited refresh и E2E empty state новой колонки.

## Журнал

- 2026-11-10 — Влита в `dev` merge-коммитом
  `d51bfd3b44b7228152e6323f4f9bbf2cf7ef8fb0`. Ревью разрешило интеграцию;
  повторные проверки на ветке и `dev` зелёные.
- 2026-11-10 — Задача создана по требованию пользователя.

## Итог

- Коммит: merge `d51bfd3b44b7228152e6323f4f9bbf2cf7ef8fb0`.
- Ветка: `feat/kan-026-column-create-settings` влита, ветка и worktree удалены.
- Проверки: 96 файлов / 1330 тестов, 96 production E2E, strict install,
  check:imports и deferred SIGTERM зелёные.
- Остаточные риски: Windows и браузеры кроме Chromium не проверялись.
