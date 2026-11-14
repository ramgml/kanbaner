---
id: KAN-039
title: Убрать внешнюю рамку редактора заметок
status: in_progress
stage: 1
priority: low
owner: opencode-worker
blocked_by: []
branch: fix/kan-039-editor-frame
worktree: .worktrees/kan-039-editor-frame
created: 2026-11-14
updated: 2026-11-14
specs:
  - specs/product-mvp.md
---

# KAN-039 — Убрать внешнюю рамку редактора заметок

## Цель

Убрать визуально лишнюю рамку и тень фокуса вокруг всего BlockNote-редактора, сохранив страницу заметки, отступы и стандартные меню.

## Объём работ

- [ ] Удалить border/background/focus shadow контейнера `.kanbaner-note-editor`.
- [ ] Сохранить внутренние отступы, мобильную раскладку и доступный фокус содержимого.
- [ ] Прогнать релевантные проверки.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/editor/editor-styles.ts`
- `packages/plugin-notes/src/ui/editor/markdown-note-editor.test.tsx`
- `apps/web/e2e/notes.spec.ts`
- `tasks/reports/KAN-039.md`

Запрещено:
- публичные контракты и доменный код;
- другие плагины и общие конфигурации.

## Критерии приёмки

- [ ] У редактора нет внешней рамки и тени фокуса.
- [ ] Содержимое и меню BlockNote визуально не обрезаются.
- [ ] Мобильный viewport 360 px остаётся без overflow.

## Проверки

- Typecheck, focused tests, lint изменённых файлов; при доступности notes E2E.

## Журнал

- 2026-11-14 — Задача создана по замечанию пользователя и передана OpenCode worker.

## Итог

- Коммит:
- Проверки:
