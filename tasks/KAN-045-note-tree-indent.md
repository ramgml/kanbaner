---
id: KAN-045
title: Уменьшить левый отступ в дереве заметок
status: in_progress
stage: 1
priority: medium
owner: opencode-worker
blocked_by: []
branch: fix/kan-045-note-tree-indent
worktree: .worktrees/kan-045-note-tree-indent
created: 2026-11-16
updated: 2026-11-16
specs:
  - specs/product-mvp.md
---

# KAN-045 — Уменьшить левый отступ в дереве заметок

## Цель

У корневых заметок слишком большой левый отступ: drag handle и невидимая expand-кнопка занимают место даже без детей.

## Результат

Корневые названия расположены компактнее. Иерархия и раскрытие веток остаются понятными, overlay-действия и названия не ломаются.

## Объём работ

- [ ] Убрать или уменьшить избыточные резервы слева для leaf/root без потери alignment веток.
- [ ] Сохранить drag/drop, expand/collapse и keyboard/touch доступность.
- [ ] Обновить unit-тесты дерева.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/note-tree.tsx`;
- `packages/plugin-notes/src/ui/note-tree.test.tsx`;
- `tasks/reports/KAN-045.md`.

Запрещено:
- `apps/web/e2e/notes.spec.ts` — принадлежит параллельной KAN-044;
- `notes-view.tsx`, домен и другие компоненты.

## Критерии приёмки

- [ ] Корневые строки стали компактнее.
- [ ] Ветки с детьми и вложенные уровни остаются выровненными и удобными.
- [ ] Проверки зелёные.

## Журнал

- 2026-11-16 — Задача создана по скриншоту пользователя и передана OpenCode worker параллельно KAN-044.

## Итог

- Коммит:
- Проверки:
