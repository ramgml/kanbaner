---
id: KAN-034
title: Увеличение основной типографики
status: in_progress
stage: 3
priority: medium
owner: orchestrator
blocked_by: []
branch: dev
worktree: null
created: 2026-11-13
updated: 2026-11-13
specs:
  - specs/product-mvp.md
  - specs/technology-stack.md
---

# KAN-034 — Увеличение основной типографики

## Цель

Сделать интерфейс читаемее без увеличения размеров контролов и изменения layout.

## Результат

- `text-xs`: 13 px вместо 12 px, `text-sm`: 15 px вместо 14 px.
- Основной `text-base`: 17 px вместо 16 px.
- Бывшие фиксированные 11 px заменены на `text-xs`, заголовок карточки 13 px —
  на `text-sm`.
- Размеры кнопок, колонок, отступы и hit targets не изменены.

## Объём работ

- [x] Настроить типографические переменные Tailwind.
- [x] Убрать мелкие произвольные размеры 11/13 px в рабочей области.
- [x] Проверить mobile overflow, component и production E2E.
- [x] Создать отчёт без коммита до отдельной просьбы пользователя.

## Владение файлами

- `apps/web/src/app/globals.css`;
- `apps/web/src/components/shell/shell-nav.tsx`;
- `apps/web/src/components/plugins/plugin-manager.tsx`;
- `packages/task-ui/src/components/task-card.tsx`;
- `packages/task-ui/src/components/task-table.tsx`;
- `packages/plugin-projects/src/ui/**`;
- `apps/web/e2e/**` — только проверки размеров/overflow;
- `tasks/KAN-034-readable-typography.md`, `tasks/reports/KAN-034.md`.

Запрещено: изменять доменные контракты, цвета, spacing и размеры контролов.

## Критерии приёмки

- [x] Мелкие подписи и основной текст стали крупнее.
- [x] Мобильный overflow не появился, hit targets не изменились.
- [x] Проверки зелёные.

## Журнал

- 2026-11-13 — Задача создана и взята в работу оркестратором.

## Итог

- Типографика увеличена без изменения размеров контролов.
- Bulk-панель получила нижний scroll-space для доступа к чекбоксам.
- Проверки: 102 файла / 1465 тестов и 113 Playwright E2E — зелёные.
- Коммит не создан без отдельной просьбы пользователя; статус `done` по правилам
  трекера возможен только после коммита и интеграции в `dev`.
- Остаточные риски: Windows и браузеры кроме Chromium не проверялись.
