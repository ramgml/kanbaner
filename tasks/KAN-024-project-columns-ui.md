---
id: KAN-024
title: Управление колонками в интерфейсе
status: in_progress
stage: 3
priority: high
owner: worker-kan-024
blocked_by: []
branch: feat/kan-024-project-columns-ui
worktree: .worktrees/kan-024-project-columns-ui
created: 2026-11-09
updated: 2026-11-09
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-024 — Управление колонками в интерфейсе

## Цель

Перевести канбан, список и карточку на пользовательские колонки KAN-023 и дать
удобные действия управления ими.

## Результат

- Доска строится из `column.list`, а не из `TASK_STATUSES`.
- Кнопка `+ Добавить колонку` создаёт open/Done-колонку.
- Заголовок содержит меню переименования, reorder и удаления с переносом.
- Перетаскивание колонок меняет порядок через доменную команду; кнопки
  `Переместить влево / вправо` доступны с клавиатуры и на мобильных.
- Создание карточек остаётся под заголовком и использует `columnId`.
- Список, фильтры, модал, summary и ResourceRef переходы используют колонки.

## Объём работ

- [ ] Динамические колонки, загрузка и пагинация задач по `columnId`.
- [ ] Add/rename/reorder/delete UI с confirm target и ошибками без потери ввода.
- [ ] DnD колонок + доступная альтернатива, optimistic update/rollback/conflict.
- [ ] DnD карточек и `task.move` по `columnId`; сохранить top/between/append.
- [ ] Обновить task list, details/modal, quick status и фильтры колонок.
- [ ] Сохранить defaults для новых проектов и Backlog у существующих.
- [ ] Component/integration/E2E desktop/mobile, reload, conflict, keyboard.
- [ ] Обновить README и отчёт `tasks/reports/KAN-024.md`.

## Владение файлами

Разрешено:

- `packages/plugin-projects/**`;
- `packages/task-ui/**` только совместимые labels/types при необходимости;
- `apps/web/e2e/**` связанные сценарии;
- `tasks/reports/KAN-024.md`.

Запрещено:

- домен `plugin-tasks`, kernel, SDK, storage, спецификации и другие задачи;
- изменение публичных операций в обход KAN-023.

## Контракты и зависимости

- Зависит от KAN-023; не пересекается с KAN-022 после её интеграции.
- Использует только публичный `@kanbaner/plugin-tasks/contract`.

## Критерии приёмки

- [ ] Все действия колонок доступны на desktop и 360 px.
- [ ] Порядок колонок и задач сохраняется после reload/restart.
- [ ] Удаление переносит задачи и корректно обновляет completedAt.
- [ ] Старые Backlog и данные видны.
- [ ] Все проверки зелёные.

## Проверки

- [ ] Strict install, check:imports, полный `pnpm check`.
- [ ] Все Playwright и deferred SIGTERM.

## Риски

- Большой UI-регрессионный объём. Смягчение: сохранить стабильные test IDs там,
  где смысл не изменился, адаптировать все существующие DnD/CRUD сценарии.

## Журнал

- 2026-11-09 — Задача создана после согласования пользовательских колонок.

## Итог

Заполняется оркестратором после интеграции.
