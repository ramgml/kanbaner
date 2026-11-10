---
id: KAN-023
title: Домен пользовательских колонок
status: done
stage: 3
priority: high
owner: worker-kan-023
blocked_by: []
branch: feat/kan-023-project-columns-domain
worktree: .worktrees/kan-023-project-columns-domain
created: 2026-11-09
updated: 2026-11-09
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/roadmap.md
---

# KAN-023 — Домен пользовательских колонок

## Цель

Заменить фиксированную доску четырёх статусов моделью упорядоченных колонок
проекта, сохранив существующие данные и совместимость операций задач.

## Решение пользователя

- Новые проекты получают `ToDo`, `In Progress`, `Done`.
- Существующие проекты сохраняют `Backlog`, `To do`, `In progress`, `Done` и
  все задачи.
- Колонки можно создавать, переименовывать, переупорядочивать и удалять с
  переносом задач в выбранную колонку.
- Колонка имеет тип `open` или `done`; Done-колонок может быть несколько.
- Порядок колонок хранится в домене, не в localStorage.

## Совместимая модель

Добавить `TaskColumn`: `id`, `projectId`, `title`, `status`, `position`,
`version`, `createdAt`, `updatedAt`.

- `status = done` соответствует типу Done; остальные статусы — open.
- Новая пользовательская open-колонка использует legacy status `in_progress`.
- У задачи добавляется optional `columnId`; сохранённый `status` остаётся
  совместимым зеркалом статуса колонки.
- `columnId` становится областью позиции задачи. Legacy status остаётся
  фильтром/семантикой completedAt, но не идентифицирует пользовательскую колонку.
- Старые команды без `columnId` выбирают исходную/первую колонку соответствующего
  legacy status и сохраняют прежнее поведение.
- Публичные расширения additive: новые команды/query/events и optional поля;
  существующие ID не переиспользуются, major v1 не ломается.

## Объём работ

### Модель и миграция документов

- [x] Добавить коллекцию колонок, схемы, валидацию, ID factory и Store-методы.
- [x] При `project.create` атомарно создавать три default-колонки.
- [x] Для legacy-проектов без колонок детерминированно материализовать четыре
  исходные колонки и заполнить `task.columnId` по status без дублей при повторе.
- [x] Сохранить версии/время существующих задач при техническом backfill, если
  текущий Store позволяет; не создавать пользовательские события миграции.
- [x] Каскадное удаление проекта удаляет и его колонки.

### Команды и запросы

- [x] `column.list` возвращает колонки проекта по position/id.
- [x] `column.create`: title, open/done, optional position; append по умолчанию.
- [x] `column.update`: переименование с `expectedVersion`.
- [x] `column.move`: транзакционный reorder с уникальными позициями и версиями
  соседей по аналогии с задачами.
- [x] `column.delete`: destructive, confirm, expectedVersion, targetColumnId;
  запрет последней колонки и чужого/того же target; атомарный перенос задач.
- [x] При переносе синхронизировать `columnId`, legacy status, position,
  `completedAt`, версии и события задач.
- [x] Расширить create/move/list задач optional `columnId`; complete выбирает
  первую Done-колонку. Оба заданных status/columnId должны быть согласованы.
- [x] Сохранить идемпотентность, expectedVersion, post-commit events и отсутствие
  частичного успеха.

### Спецификации и тесты

- [x] Обновить `product-mvp.md`, `architecture.md`, `roadmap.md`: динамические
  колонки, defaults, legacy status compatibility и область позиции.
- [x] Store conformance: CRUD/reorder/delete transfer/backfill/rollback/
  concurrency/app-generated IDs/UTC.
- [x] Operations/contract tests: defaults, legacy callers, конфликты, ошибки,
  события после коммита, удаление проекта.
- [x] Отчёт `tasks/reports/KAN-023.md`.

## Владение файлами

Разрешено:

- `packages/plugin-tasks/**`;
- `tests/contract/**` только связанные тесты;
- `specs/product-mvp.md`, `specs/architecture.md`, `specs/roadmap.md`;
- `tasks/reports/KAN-023.md`.

Запрещено:

- `plugin-projects`, `task-ui`, apps/web, kernel, SDK и storage-sqlite;
- изменение существующих applied SQLite migration файлов;
- новые зависимости и изменение других спецификаций/задач.

## Контракты и зависимости

- Независима от KAN-022; блокирует KAN-024.
- SQL и драйвер БД в домене запрещены: документные Store-операции.
- Данные существующих проектов и Backlog сохраняются.

## Критерии приёмки

- [x] Новый проект имеет три заданные колонки.
- [x] Legacy-проект сохраняет Backlog и все задачи после backfill/restart.
- [x] CRUD/reorder/delete transfer атомарны и переживают reload.
- [x] Done-семантика и completedAt работают для нескольких Done-колонок.
- [x] Старые task/project операции остаются совместимыми.
- [x] Все проверки зелёные.

## Проверки

- [x] Strict install, check:imports и self-test.
- [x] Полный `pnpm check`, Store conformance, integration/contract tests.
- [x] Все Playwright и deferred SIGTERM.

## Риски

- Двойная модель columnId/status может разойтись. Смягчение: изменение только
  через Store, который зеркалит status колонки, и invariant-тесты.
- Backfill при параллельных вызовах может создать дубли. Смягчение:
  детерминированные legacy IDs, транзакция и повторный conformance.

## Журнал

- 2026-11-10 — Влита в `dev` merge-коммитом
  `ad73a5c7790b4264bd4bf260d00007527f919078`. Независимое ревью разрешило
  интеграцию; проверки на ветке после rebase и `dev` зелёные.
- 2026-11-09 — Модель и миграция согласованы с пользователем.

## Итог

- Коммит: merge `ad73a5c7790b4264bd4bf260d00007527f919078`.
- Ветка: `feat/kan-023-project-columns-domain` влита, ветка и worktree удалены.
- Проверки: 1253 теста до rebase и полный check после rebase на KAN-022;
  conformance 38×4, 78 E2E на интегрированном составе, strict install,
  check:imports и deferred SIGTERM.
- Остаточные риски: fixed UI заменяется в KAN-024; события best-effort; Windows
  и браузеры кроме Chromium не проверялись.
