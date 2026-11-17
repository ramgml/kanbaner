---
id: KAN-052
title: Устранить flushSync в lifecycle BlockNote
status: in_progress
stage: 1
priority: high
owner: opencode-worker
blocked_by: []
branch: fix/kan-052-blocknote-lifecycle-flush
worktree: .worktrees/kan-052-blocknote-lifecycle-flush
created: 2026-11-17
updated: 2026-11-17
specs:
  - specs/technology-stack.md
---

# KAN-052 — Устранить flushSync в lifecycle BlockNote

## Цель

Убрать React Console Error при инициализации редактора заметки с inline image.

## Результат

Сериализация BlockNote не вызывает `flushSync` внутри React lifecycle. Редактор инициализируется и обновляется безопасно, без гонок при быстрой смене заметки.

## Объём работ

- [ ] Воспроизвести console error на странице с inline image.
- [ ] Перенести вызовы replace/serialization из синхронного lifecycle в отменяемую задачу или устранить React external renderer по актуальному API.
- [ ] Проверить initial load, external value update и быструю смену noteId.
- [ ] Добавить regression-тест console/error и содержимого.

## Владение файлами

Разрешено:

- `packages/plugin-notes/src/ui/editor/**`;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-052.md`.

Запрещено:

- новые зависимости, изменение Markdown/attachment контракта.

## Критерии приёмки

- [ ] Нет flushSync lifecycle warning при открытии галереи блоков.
- [ ] Markdown и inline images сохраняются без изменений и потерь.
- [ ] Быстрое переключение заметок не применяет старую инициализацию.
- [ ] Полные проверки и notes E2E зелёные.

## Журнал

- 2026-11-17 — Задача создана по Console Error пользователя.

## Итог

- Коммит:
- Проверки:
