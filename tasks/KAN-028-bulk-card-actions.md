---
id: KAN-028
title: Массовый перенос и удаление карточек
status: done
stage: 3
priority: high
owner: worker-kan-028-domain, worker-kan-028-ui
blocked_by: []
branch: feat/kan-028-bulk-domain, feat/kan-028-bulk-ui
worktree: .worktrees/kan-028-bulk-domain, .worktrees/kan-028-bulk-ui
created: 2026-11-12
updated: 2026-11-12
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/technology-stack.md
---

# KAN-028 — Массовый перенос и удаление карточек

## Цель

Позволить выбрать несколько карточек чекбоксами и атомарно перенести или
удалить их одним действием.

## Результат

- В верхней строке карточки есть чекбокс выбора; кнопка меню остаётся справа,
  заголовок — отдельной строкой во всю ширину без drag-ручки.
- При выборе появляется панель: счётчик, колонка target, «Переместить»,
  «Удалить», «Снять выбор».
- Перенос дописывает выбранные задачи в target в порядке выбора.
- Удаление требует явного подтверждения с числом выбранных задач.
- Обе операции атомарны: ошибка или конфликт одной задачи откатывает всю
  операцию, частичного успеха нет.

## Домен

- [x] Добавить `kanbaner.tasks.task.moveMany` и `task.deleteMany` после явного
  согласования пользователя.
- [x] Вход: уникальные `{id, expectedVersion}` (1…200), move — `columnId`,
  delete — `confirm: true`; выход содержит фактически изменённые/удалённые
  задачи и дескрипторы.
- [x] Одна Store-транзакция на команду, предварительная проверка существования,
  одного projectId, версий и target до первой записи.
- [x] Move: append с сохранением порядка входа; версии соседей, изменившиеся в
  этой же транзакции, не дают ложный конфликт после первичной валидации.
- [x] Delete: каскад подзадач; parent+child в одном входе не удаляются дважды.
  Повтор по Idempotency-Key и полностью отсутствующий набор не создают события.
- [x] События после коммита для каждой задачи/соседа; поисковые upsert/delete
  и универсальные ссылки соответствуют существующим single-операциям.
- [x] Метаданные write/destructive, JSON Schema, contract/operation tests,
  activation и SQLite conformance.

## UI

- [x] Checkbox с accessible name и hit target не менее 40 px; input исключён
  из drag, клик не открывает карточку. Выбор не мешает title/menu/DnD.
- [x] Selection привязан к projectId; смена проекта очищает его. Скрытые фильтром
  задачи не попадают в действие случайно: смена tag снимает скрытый выбор.
- [x] Панель доступна с клавиатуры и на mobile 360, pending блокирует повторную
  отправку, ошибка сохраняет выбор.
- [x] Move/delete только через новые команды с версиями из актуальных task
  snapshots; после успеха selection очищается, доска/сводка обновляются.
- [x] VERSION_CONFLICT перечитывает доску и сохраняет выбор только тех задач,
  которые ещё существуют; повторная отправка использует свежие версии.
- [x] Удаление — отдельный destructive dialog; pending нельзя закрыть/повторить.
- [x] Сохранить текущую верстку: без drag-ручки, меню сверху, title full width.

## Владение файлами

Domain worker:

- `packages/plugin-tasks/**`;
- `packages/plugin-sdk/src/plugin-id.ts` и `plugin-id.test.ts` — только поддержка
  camelCase в action-сегменте согласованных operation ID;
- `specs/plugin-contract.md`, `specs/architecture.md` — только описание новых
  публичных операций;
- `tasks/reports/KAN-028-domain.md`.

UI worker:

- `packages/plugin-projects/**`;
- `apps/web/e2e/kanban.spec.ts`;
- `tasks/reports/KAN-028-ui.md`;
- незакоммиченная верстка карточки из основного checkout переносится в этот
  worktree и входит в его коммит.

Запрещено менять чужие области, kernel, storage, зависимости и task-list.

## Контракты и зависимости

- Пользователь явно одобрил публичные `task.moveMany` и `task.deleteMany`.
- UI зависит от согласованных здесь input/output, но реализуется параллельно.
- Зависит от KAN-027 и текущего `0745989`.

## Критерии приёмки

- [x] Несколько карточек выбираются и перемещаются одной атомарной командой.
- [x] Несколько удаляются после подтверждения, включая parent+child без дублей.
- [x] Конфликт/validation не оставляет частичных изменений.
- [x] Keyboard, touch, mobile 360 и прежний DnD работают.
- [x] Все проверки зелёные.

## Проверки

- [x] Strict install, focused domain/UI, check:imports и self-test.
- [x] SQLite и in-memory conformance, чистая база.
- [x] Полный `pnpm check`, все Playwright, deferred SIGTERM.

## Риски

- Move нескольких задач меняет версии соседей внутри той же транзакции.
  Смягчение: полная предварительная валидация, затем фактические версии из
  transaction, тесты source/target пересечения.
- Parent+child delete может повторно обработать каскад. Смягчение: дедупликация
  дескрипторов и no-op уже удалённого потомка.

## Журнал

- 2026-11-12 — Домен влит merge-коммитом
  `9840a73e16a67710eec41ac8473aac9852c9ffcb`, UI — merge-коммитом
  `6a8c33bc3de5dabe7b4eca7bb66d6f2737206deb`. Независимые ревью разрешили
  интеграцию; повторные проверки на ветках и `dev` зелёные.
- 2026-11-12 — Пользователь согласовал атомарные публичные команды.

## Итог

- Коммиты: domain `9840a73e16a67710eec41ac8473aac9852c9ffcb`, UI
  `6a8c33bc3de5dabe7b4eca7bb66d6f2737206deb`.
- Ветки и worktree обеих частей удалены после успешного merge.
- Проверки: 98 файлов / 1404 теста, 103 production E2E, strict install,
  check:imports, SQLite/in-memory conformance и deferred SIGTERM зелёные.
- Остаточные риски: Windows и браузеры кроме Chromium не проверялись.
