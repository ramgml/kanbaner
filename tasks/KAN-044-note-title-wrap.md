---
id: KAN-044
title: Перенос длинного заголовка заметки
status: in_progress
stage: 1
priority: medium
owner: opencode-worker
blocked_by: []
branch: fix/kan-044-note-title-wrap
worktree: .worktrees/kan-044-note-title-wrap
created: 2026-11-16
updated: 2026-11-16
specs:
  - specs/product-mvp.md
---

# KAN-044 — Перенос длинного заголовка заметки

## Цель

Длинный заголовок заметки обрезается справа в однострочном input. Сделать видимым весь заголовок без горизонтального overflow.

## Результат

Заголовок переносится по строкам и автоматически увеличивает высоту поля, сохраняя редактирование и автосохранение.

## Объём работ

- [ ] Заменить однострочный input на доступное auto-growing многострочное поле или эквивалент.
- [ ] Сохранить существующие testid, label, value/change, disabled, partial update и keyboard поведение.
- [ ] Проверить длинный текст, узкий mobile 360 и отсутствие overflow.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/notes-view.tsx` и `notes-view.test.tsx`;
- отдельный title-компонент в `packages/plugin-notes/src/ui/**` при необходимости;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-044.md`.

Запрещено:
- домен, публичные контракты, другие плагины и BlockNote editor.

## Критерии приёмки

- [ ] Длинный заголовок виден целиком с переносами.
- [ ] Поле не создаёт горизонтальный overflow на desktop/mobile.
- [ ] Автосохранение, загрузка и конфликт версий не изменены.
- [ ] Проверки зелёные.

## Журнал

- 2026-11-16 — Задача создана по скриншоту пользователя и передана OpenCode worker.

## Итог

- Коммит:
- Проверки:
