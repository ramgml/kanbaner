---
id: KAN-022
title: Переименование проекта
status: done
stage: 3
priority: high
owner: worker-kan-022
blocked_by: []
branch: feat/kan-022-project-rename
worktree: .worktrees/kan-022-project-rename
created: 2026-11-09
updated: 2026-11-09
specs:
  - specs/product-mvp.md
  - specs/plugin-contract.md
---

# KAN-022 — Переименование проекта

## Цель

Дать пользователю возможность изменить название активного проекта через
существующую доменную команду `kanbaner.tasks.project.update`.

## Результат

- В заголовке активного проекта доступно действие «Переименовать».
- Диалог содержит текущее название, валидацию, сохранение и отмену.
- После успеха название обновляется в заголовке, sidebar, mobile sheet и обзоре.
- ID проекта, выбранный вид, задачи и query-параметры сохраняются.
- Ошибки и конфликт версии не приводят к потере введённого названия.

## Объём работ

- [x] Добавить доступную кнопку и диалог переименования в project workspace.
- [x] Использовать `project.update` с актуальным `expectedVersion`; не создавать
  отдельной доменной операции.
- [x] Обновить snapshots проектов через существующий revision/refresh механизм.
- [x] Сохранить keyboard/focus/Escape, double-submit guard и ошибки формы.
- [x] Добавить component и E2E для канбана, списка и мобильного viewport.
- [x] Обновить README плагина и отчёт `tasks/reports/KAN-022.md`.

## Владение файлами

Разрешено:

- `packages/plugin-projects/**`;
- `apps/web/e2e/**` только сценарии переименования;
- `tasks/reports/KAN-022.md`.

Запрещено:

- `plugin-tasks`, kernel, SDK, storage и спецификации;
- динамические колонки и файлы KAN-023/KAN-024;
- изменение существующего создания проектов.

## Контракты и зависимости

- Используется существующий `ProjectUpdateInputSchema` и `expectedVersion`.
- Публичные контракты и миграции не меняются.

## Критерии приёмки

- [x] Проект можно переименовать из канбана и списка.
- [x] Название обновляется во всех project selectors после reload.
- [x] Невалидный ввод и ошибка сохранения не теряют ввод.
- [x] Все проверки зелёные.

## Проверки

- [x] Strict install, check:imports, полный `pnpm check`.
- [x] Все Playwright и deferred SIGTERM.

## Риски

- Локальные snapshots могут сохранить старое название. Смягчение: единый
  revision/refresh и тесты всех представлений.

## Журнал

- 2026-11-09 — Влита в `dev` merge-коммитом
  `980df343a579ce18d0df4c1ca0139a427804ddf8`; повторное ревью разрешило
  интеграцию, все проверки зелёные на `dev`.
- 2026-11-09 — Задача создана по требованию пользователя.

## Итог

- Коммит: merge `980df343a579ce18d0df4c1ca0139a427804ddf8`.
- Ветка: `feat/kan-022-project-rename` влита, ветка и worktree удалены.
- Проверки: 93 файла / 1206 тестов, 78 E2E, strict install, check:imports и
  deferred SIGTERM зелёные.
- Остаточные риски: Windows и браузеры кроме Chromium не проверялись.
