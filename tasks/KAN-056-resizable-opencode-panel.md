---
id: KAN-056
title: Resizable OpenCode-панель
status: in_progress
stage: 7
priority: medium
owner: worker
blocked_by: []
branch: dev
worktree: .
created: 2026-11-20
updated: 2026-11-20
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/technology-stack.md
---

# KAN-056 — Resizable OpenCode-панель

## Цель

Дать пользователю менять ширину правой OpenCode-панели на desktop, сохраняя
полноэкранный режим на mobile и не ломая open/close, Escape и focus.

## Результат

- Левая граница desktop-панели перетаскивается Pointer Events с capture.
- Ширина по умолчанию 384 px, min 320 px, max 640 px; максимум ужимается по
  viewport с резервом места левому sidebar и основному содержимому.
- Ширина сохраняется в `localStorage` под `kanbaner.opencode.panelWidth`,
  сохранённое значение валидируется и clamp-ится; недоступный storage не
  ломает resize текущей сессии.
- Separator доступен с клавиатуры: ArrowLeft/ArrowRight, Home/End, double-click
  сбрасывает 384 px. Есть role/aria, видимая линия, focus-стиль и
  `cursor: col-resize`.
- На mobile панель остаётся fullscreen `w-full`, без resizer и inline width.
- Левый sidebar и остальные shell behaviors не менялись.

## Объём работ

- [x] Добавить `use-desktop-assistant-resizer` с pointer/keyboard/persistence.
- [x] Подключить resizer к `AssistantSlot`, не меняя open/close/Escape/focus.
- [x] Добавить unit-тесты hook и E2E в `shell.spec.ts`.
- [x] Прогнать форматирование, lint, typecheck, focused unit, build и E2E.
- [ ] Коммит и merge в `dev` — выполняет оркестратор.

## Владение файлами

Разрешено:

- `apps/web/src/components/shell/app-shell.tsx`;
- `apps/web/src/components/shell/use-desktop-assistant-resizer.ts`;
- `apps/web/src/components/shell/use-desktop-assistant-resizer.test.tsx`;
- `apps/web/e2e/shell.spec.ts`;
- `tasks/KAN-056-resizable-opencode-panel.md`, `tasks/reports/KAN-056.md`.

Запрещено:

- `packages/opencode/**`, `apps/web/e2e/opencode.spec.ts`;
- `use-desktop-sidebar-resizer.ts` и левый sidebar;
- чужие незакоммиченные изменения;
- commit/push/merge/rebase без просьбы пользователя.

## Критерии приёмки

- [x] Drag левой границы меняет ширину и сохраняет её между reload.
- [x] Pointer capture и fallback на window не оставляют зависший drag.
- [x] Клавиатура, min/max, double-click reset и viewport clamp работают.
- [x] Повреждённое или недоступное хранилище даёт default 384 без падения.
- [x] Mobile fullscreen без resizer, inline width и горизонтального overflow.
- [x] Focus на close, Escape и закрытие панели сохранены.

## Журнал

- 2026-11-20 — Задача создана и выполнена в текущем checkout без worktree,
  коммита и push. Результаты проверок: `tasks/reports/KAN-056.md`.

## Итог

Ожидает review и интеграции оркестратором; статус `done` не устанавливался.
