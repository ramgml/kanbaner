---
id: KAN-033
title: Подсказка с описанием карточки
status: done
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
  - specs/architecture.md
---

# KAN-033 — Подсказка с описанием карточки

## Цель

Позволить быстро прочитать описание карточки, не открывая модальное окно.

## Результат

- Наведение мыши на карточку показывает tooltip с описанием после короткой задержки.
- Клавиатурный `focus-visible` на заголовке показывает ту же подсказку.
- Touch, drag, scroll и открытие меню/карточки не оставляют tooltip на экране.
- Длинный текст можно прокрутить внутри tooltip, который не обрезается overflow колонки.

## Объём работ

- [x] Реализовать portal tooltip без новых зависимостей и доменных изменений.
- [x] Добавить hover/focus-visible/Escape и скрытие при drag/scroll/open.
- [x] Добавить полное описание с прокруткой внутри tooltip, viewport positioning и accessible relation.
- [x] Покрыть component и production E2E, обновить README и отчёт.

## Владение файлами

Разрешено:

- `packages/plugin-projects/src/ui/kanban-card.tsx`;
- `packages/plugin-projects/src/ui/card-description-tooltip.tsx`;
- `packages/plugin-projects/src/kanban-card.test.tsx`;
- `packages/plugin-projects/src/card-description-tooltip.test.tsx`;
- `apps/web/e2e/kanban.spec.ts`;
- `packages/plugin-projects/README.md`;
- `tasks/KAN-033-card-description-tooltip.md`;
- `tasks/reports/KAN-033.md`.

Запрещено:

- доменные схемы и команды;
- другие плагины и панель `/view/tasks`;
- новые зависимости и чужие отчёты.

## Контракты и зависимости

- Используется существующее `Task.descriptionMarkdown` и `createPortal`.
- Пустое описание не показывает tooltip; в KAN-036 исходный plain text заменён
  общим безопасным Markdown-рендером.

## Критерии приёмки

- [x] Hover с задержкой и keyboard focus-visible показывают описание.
- [x] Пустое описание, touch и drag не создают зависший tooltip.
- [x] Tooltip не выходит за viewport и не меняет layout/DnD.
- [x] Проверки зелёные.

## Проверки

- [x] Focused component tests и typecheck.
- [x] Полный `pnpm check` и все Playwright после свежей сборки.

## Риски

- Абсолютный tooltip внутри колонки обрезался бы её overflow, поэтому
  позиционирование выполняется через fixed portal с clamp/flip.

## Журнал

- 2026-11-13 — Задача создана и взята в работу оркестратором.
- 2026-11-13 — Результат закоммичен непосредственно в `dev`, задача завершена.

## Итог

- Коммит: `db150d3`; отдельный merge не требовался, работа велась в `dev`.
- Portal tooltip работает по hover/focus-visible, прокручивается и не мешает DnD.
- Проверки задачи: 102 файла / 1465 тестов и 112 Playwright E2E — зелёные.
- Финальные проверки серии: 103 файла / 1467 тестов и 114 Playwright E2E — зелёные.
- В KAN-036 содержимое tooltip дополнено безопасным Markdown-рендером.
- Остаточные риски: Windows и браузеры кроме Chromium не проверялись. Push не
  выполнялся.
