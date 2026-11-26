---
id: KAN-042
title: Понятный выбор проекта для связи заметки
status: done
stage: 1
priority: high
owner: opencode-worker
blocked_by: []
branch: feat/kan-042-note-link-picker
worktree: .worktrees/kan-042-note-link-picker
created: 2026-11-14
updated: 2026-11-14
specs:
  - specs/product-mvp.md
  - specs/technology-stack.md
  - specs/plugin-contract.md
---

# KAN-042 — Понятный выбор проекта для связи заметки

## Цель

Заменить ручной ввод `plugin:type:id` на доступный выбор проекта или задачи по названию в блоке связей заметки.

## Результат

Пользователь открывает список, ищет по названию, видит тип ресурса и добавляет связь без знания ResourceRef. Существующие связи продолжают открываться и удаляться.

## Объём работ

- [x] Заменить input/datalist на combobox или эквивалентный shadcn-совместимый picker с поиском.
- [x] Показывать названия и типы «Проект»/«Задача», loading/empty/error states.
- [x] Сохранить существующие `note.link`, `ResourceRef`, pagination данных и удаление связей.
- [x] Обновить unit/integration/E2E-тесты и README при необходимости.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/note-links.tsx` и его тесты;
- `packages/plugin-notes/src/ui/**` только для picker-а;
- `packages/plugin-notes/README.md`;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-042.md`.

Запрещено:
- доменные команды, схемы данных, публичные контракты;
- другие плагины, kernel и редактор заметок;
- новые зависимости без необходимости.

## Контракты и зависимости

- Использовать существующие `kanbaner.tasks.project.list` и `task.list` через UI invoker.
- Хранить выбранный ResourceRef только как внутреннее значение picker-а.
- Не импортировать внутренние модули `tasks` или `projects`.

## Критерии приёмки

- [x] ResourceRef не нужно вводить вручную.
- [x] Поиск фильтрует проекты и задачи по названию.
- [x] Выбор доступен с клавиатуры и на мобильном viewport.
- [x] Добавление и удаление связи работают, ошибки видимы.
- [x] Тесты и проверки зелёные.

## Журнал

- 2026-11-14 — Задача создана после замечания о непонятной привязке и передана OpenCode worker.
- 2026-11-14 — Реализован picker с поиском и пагинацией. Независимое ревью выявило ошибки источников, поиска, race и фокуса; исправления подтверждены повторным ревью.
- 2026-11-14 — Ветка влита в `dev`; финальный `pnpm check` зелёный, worktree и feature-ветка удалены merge queue.

## Итог

- Коммит: worker `1979ce3`, follow-up `01f925d`, `5c6afc7`; merge `f80f35dda54dce636104c581cec3de7f3c1fe02a`.
- Проверки: focused 15/15, `pnpm check` 1652 теста, notes E2E 9/9, typecheck и import boundaries.
- Остаточные риски: поиск последовательно догружает страницы до первого совпадения; при ошибке требуется явный retry; отмена HTTP при размонтировании не поддерживается invoker-ом. Push не выполнялся.
