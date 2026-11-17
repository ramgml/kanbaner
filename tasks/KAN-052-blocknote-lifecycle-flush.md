---
id: KAN-052
title: Устранить flushSync в lifecycle BlockNote
status: done
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

- [x] Воспроизвести console error на странице с inline image.
- [x] Перенести вызовы replace/serialization из синхронного lifecycle в отменяемую задачу или устранить React external renderer по актуальному API.
- [x] Проверить initial load, external value update и быструю смену noteId.
- [x] Добавить regression-тест console/error и содержимого.

## Владение файлами

Разрешено:

- `packages/plugin-notes/src/ui/editor/**`;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-052.md`.

Запрещено:

- новые зависимости, изменение Markdown/attachment контракта.

## Критерии приёмки

- [x] Нет flushSync lifecycle warning при открытии галереи блоков.
- [x] Markdown и inline images сохраняются без изменений и потерь.
- [x] Быстрое переключение заметок не применяет старую инициализацию.
- [x] Полные проверки и notes E2E зелёные.

## Журнал

- 2026-11-17 — Задача создана по Console Error пользователя.
- 2026-11-17 — React external renderer inline image заменён DOM `toExternalHTML`; устранён flushSync при всех Markdown-сериализациях. Ревью подтвердило безопасность, regression переключений усилен. Ветка влита в `dev`.

## Итог

- Коммит: `f5f3d10`, test `34556e7`, merge `3c909ff1ffb4dafca582f4b36a30387e4b86a555`.
- Проверки: `pnpm check` 1726 тестов, notes E2E 21/21, console/pageerror чистые. Push не выполнялся. Отдельно найдено ограничение быстрого возврата к текущей pending-заметке, не влияющее на этот fix.
