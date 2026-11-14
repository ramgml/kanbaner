---
id: KAN-042
title: Понятный выбор проекта для связи заметки
status: in_progress
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

- [ ] Заменить input/datalist на combobox или эквивалентный shadcn-совместимый picker с поиском.
- [ ] Показывать названия и типы «Проект»/«Задача», loading/empty/error states.
- [ ] Сохранить существующие `note.link`, `ResourceRef`, pagination данных и удаление связей.
- [ ] Обновить unit/integration/E2E-тесты и README при необходимости.

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

- [ ] ResourceRef не нужно вводить вручную.
- [ ] Поиск фильтрует проекты и задачи по названию.
- [ ] Выбор доступен с клавиатуры и на мобильном viewport.
- [ ] Добавление и удаление связи работают, ошибки видимы.
- [ ] Тесты и проверки зелёные.

## Журнал

- 2026-11-14 — Задача создана после замечания о непонятной привязке и передана OpenCode worker.

## Итог

- Коммит:
- Проверки:
