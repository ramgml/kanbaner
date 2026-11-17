---
id: KAN-051
title: Открыть выбор файла из slash-меню изображения
status: done
stage: 1
priority: high
owner: opencode-worker
blocked_by: []
branch: fix/kan-051-slash-image-picker
worktree: .worktrees/kan-051-slash-image-picker
created: 2026-11-17
updated: 2026-11-17
specs:
  - specs/technology-stack.md
---

# KAN-051 — Открыть выбор файла из slash-меню изображения

## Цель

Исправить сценарий `+ → Картинка`: сейчас выбор пункта не приводит к загрузке изображения.

## Результат

Пункт image в slash/side меню открывает файловый picker. После выбора изображение загружается через существующий attachment flow и появляется в заметке; cancel ничего не меняет.

## Объём работ

- [x] Воспроизвести сценарий в реальном BlockNote UI.
- [x] Подключить picker к существующему hidden input/upload flow без дублирования загрузки.
- [x] Добавить unit/E2E regression на успешный выбор и отсутствие пустого image после cancel.
- [x] Проверить paste/drop и старую кнопку загрузки.

## Владение файлами

Разрешено:

- `packages/plugin-notes/src/ui/editor/**`;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-051.md`.

Запрещено:

- новые зависимости, изменение API/вложений и других представлений.

## Критерии приёмки

- [x] `+ → Картинка` открывает picker и создаёт сохранённое изображение.
- [x] Нет пустого блока или pending-записи при cancel.
- [x] Readonly/disabled не открывают picker.
- [x] Полные проверки и notes E2E зелёные.

## Журнал

- 2026-11-17 — Задача создана по сообщению пользователя о неработающем пункте «Картинка».
- 2026-11-17 — Image item открывает существующий file picker через SuggestionMenuController. Ревью устранило изменение блока при cancel. Ветка влита в `dev`.

## Итог

- Коммит: `9bf10bb`, cancel fix `0acea20`, merge `56db679b3c2fe3bee12983cd944b81a070d5410f`.
- Проверки: `pnpm check` 1721 тест, notes E2E 20/20, filechooser/cancel/reload сценарии. Push не выполнялся.
