---
id: KAN-047
title: Изменение ширины дерева заметок мышью
status: done
stage: 1
priority: medium
owner: opencode-worker
blocked_by: []
branch: feat/kan-047-resizable-note-sidebar
worktree: .worktrees/kan-047-resizable-note-sidebar
created: 2026-11-16
updated: 2026-11-16
specs:
  - specs/product-mvp.md
---

# KAN-047 — Изменение ширины дерева заметок мышью

## Цель

На desktop пользователь может изменить ширину sidebar дерева заметок перетаскиванием его правой границы.

## Результат

Ширина меняется плавно без overflow и потери функций дерева, сохраняется между перезагрузками. Есть клавиатурная альтернатива и сброс к стандартной ширине.

## Объём работ

- [x] Добавить visible/hover resize handle с Pointer Events и pointer capture.
- [x] Ограничить ширину разумными min/max с учётом viewport.
- [x] Сохранить выбранную ширину локально между перезагрузками.
- [x] Добавить accessible separator с клавишами Arrow/Home/End и double-click reset.
- [x] Не применять resize к мобильному полноэкранному sidebar.
- [x] Добавить unit/E2E для mouse, persistence, keyboard и mobile.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/notes-view.tsx` и тесты;
- новый resizable sidebar component/hook в `packages/plugin-notes/src/ui/**`;
- `apps/web/e2e/notes.spec.ts`;
- `packages/plugin-notes/README.md`;
- `tasks/reports/KAN-047.md`.

Запрещено:
- домен, публичные контракты, note-tree внутренности и BlockNote editor.

## Критерии приёмки

- [x] Desktop sidebar меняет ширину мышью.
- [x] Ширина ограничена и не создаёт горизонтальный overflow.
- [x] Ширина восстанавливается после reload.
- [x] Размер можно изменить с клавиатуры и сбросить double-click.
- [x] Mobile 360 не получает resize UI и не ломается.
- [x] Проверки зелёные.

## Журнал

- 2026-11-16 — Задача создана по запросу пользователя и передана OpenCode worker.
- 2026-11-16 — Реализован resize 240–560 px с viewport clamp, persistence и keyboard. Ревью выявило pointer ownership/parse/resize недочёты, исправленные follow-up; повторное ревью разрешило merge.
- 2026-11-16 — Ветка влита в `dev`; финальный `pnpm check` зелёный, worktree и feature-ветка удалены.

## Итог

- Коммит: worker `f56e01d`, follow-up `ee4c8b5`; merge `ff1027a65eb88304e1868dc3a04cffb254639a44`.
- Проверки: focused 31/31, `pnpm check` 1684 теста, notes E2E 16/16, viewport resize 1440→1280→1152→1440 и mobile 360. Push не выполнялся.
