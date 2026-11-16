---
id: KAN-047
title: Изменение ширины дерева заметок мышью
status: in_progress
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

- [ ] Добавить visible/hover resize handle с Pointer Events и pointer capture.
- [ ] Ограничить ширину разумными min/max с учётом viewport.
- [ ] Сохранить выбранную ширину локально между перезагрузками.
- [ ] Добавить accessible separator с клавишами Arrow/Home/End и double-click reset.
- [ ] Не применять resize к мобильному полноэкранному sidebar.
- [ ] Добавить unit/E2E для mouse, persistence, keyboard и mobile.

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

- [ ] Desktop sidebar меняет ширину мышью.
- [ ] Ширина ограничена и не создаёт горизонтальный overflow.
- [ ] Ширина восстанавливается после reload.
- [ ] Размер можно изменить с клавиатуры и сбросить double-click.
- [ ] Mobile 360 не получает resize UI и не ломается.
- [ ] Проверки зелёные.

## Журнал

- 2026-11-16 — Задача создана по запросу пользователя и передана OpenCode worker.

## Итог

- Коммит:
- Проверки:
