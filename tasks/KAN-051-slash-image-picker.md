---
id: KAN-051
title: Открыть выбор файла из slash-меню изображения
status: in_progress
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

- [ ] Воспроизвести сценарий в реальном BlockNote UI.
- [ ] Подключить picker к существующему hidden input/upload flow без дублирования загрузки.
- [ ] Добавить unit/E2E regression на успешный выбор и отсутствие пустого image после cancel.
- [ ] Проверить paste/drop и старую кнопку загрузки.

## Владение файлами

Разрешено:

- `packages/plugin-notes/src/ui/editor/**`;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-051.md`.

Запрещено:

- новые зависимости, изменение API/вложений и других представлений.

## Критерии приёмки

- [ ] `+ → Картинка` открывает picker и создаёт сохранённое изображение.
- [ ] Нет пустого блока или pending-записи при cancel.
- [ ] Readonly/disabled не открывают picker.
- [ ] Полные проверки и notes E2E зелёные.

## Журнал

- 2026-11-17 — Задача создана по сообщению пользователя о неработающем пункте «Картинка».

## Итог

- Коммит:
- Проверки:
