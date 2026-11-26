---
id: KAN-044
title: Перенос длинного заголовка заметки
status: done
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

- [x] Заменить однострочный input на доступное auto-growing многострочное поле или эквивалент.
- [x] Сохранить существующие testid, label, value/change, disabled, partial update и keyboard поведение.
- [x] Проверить длинный текст, узкий mobile 360 и отсутствие overflow.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/notes-view.tsx` и `notes-view.test.tsx`;
- отдельный title-компонент в `packages/plugin-notes/src/ui/**` при необходимости;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-044.md`.

Запрещено:
- домен, публичные контракты, другие плагины и BlockNote editor.

## Критерии приёмки

- [x] Длинный заголовок виден целиком с переносами.
- [x] Поле не создаёт горизонтальный overflow на desktop/mobile.
- [x] Автосохранение, загрузка и конфликт версий не изменены.
- [x] Проверки зелёные.

## Журнал

- 2026-11-16 — Задача создана по скриншоту пользователя и передана OpenCode worker.
- 2026-11-16 — Input заменён на auto-growing textarea с переносами, IME и Enter handling. Ветка влита в `dev` после форматирования отчёта; финальный `pnpm check` зелёный.

## Итог

- Коммит: worker `04074e0`, format follow-up `fd7fcfe`, merge `e3d84b782f3d6857810113098d461908904d0cd7`.
- Проверки: focused 21/21, `pnpm check` 1659 тестов, E2E 125/125, typecheck и import boundaries. Push не выполнялся.
