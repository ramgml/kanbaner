# KAN-028 — UI массовых действий с карточками

- Задача: `tasks/KAN-028-bulk-card-actions.md`
- Ветка: `feat/kan-028-bulk-ui`
- Worktree: `.worktrees/kan-028-bulk-ui`
- Домен в HEAD: `2e5df62`, `0ae279a` (контракт `task.moveMany`/`task.deleteMany`)
- UI-коммиты:
  - `21507e4` — `feat(projects): добавить массовые действия с карточками`;
  - `1152e51`, `d379096` — отчёт;
  - финальный fix-коммит — tip ветки:
    `fix(projects): укрепить массовый выбор карточек`.

## Итог

UI массовых действий завершён. Fallback-контракта нет: используются ровно
`TASKS_COMMAND_IDS.taskMoveMany` и `TASKS_COMMAND_IDS.taskDeleteMany`
(`kanbaner.tasks.task.moveMany` / `kanbaner.tasks.task.deleteMany`).

## Что реализовано

### Карточка

- Верхняя строка: checkbox слева, меню `⋯` справа; заголовок — отдельной
  full-width строкой; drag-ручки нет.
- Checkbox:
  - accessible name `Выбрать задачу …`;
  - hit target 40×40 px;
  - исключён из drag;
  - клик не открывает карточку.
- Whole-card drag, drag за заголовок, ghost, меню, keyboard и подавление click
  после drag сохранены.

### Selection

- `Map<id, Task>` в порядке выбора, snapshot для `expectedVersion`.
- Смена `projectId` очищает выбор и target.
- Смена tag сразу снимает скрытые фильтром задачи.
- `reloadBoard` обновляет версии выбранных задач.
- Для задач вне загруженной страницы выполняется `task.get`:
  - `NOT_FOUND` удаляет из выбора;
  - временная ошибка сохраняет snapshot;
  - задача другого проекта не попадает в selection.
- Обычный refresh/resize не теряет существующие задачи.

### Панель и операции

- Панель `Выбрано N`, select фактических колонок, «Переместить», «Удалить»,
  «Снять выбор»; desktop/mobile 360 без overflow, keyboard labels.
- Pending разделён на `"move" | "delete"`; подписи и `aria-busy` не смешиваются.
- `bulkRequestRef` не даёт устаревшему `finally` снять pending новой операции
  после смены проекта/unmount.
- Move: одна `task.moveMany`, порядок выбора, awaited reload + bump revision.
- Delete: отдельный destructive `ModalDialog` с числом задач и каскадом,
  pending guard, одна `task.deleteMany`, clear + reload + bump.
- Ошибки и конфликты: reload, сохранение существующего выбора с актуальными
  версиями, повтор по свежим `expectedVersion`.
- Лимит 200 проверяется и для move, и для delete.
- Последовательных single-команд для массовых действий нет.

## Проверки

Выполнено на HEAD с доменом `0ae279a`:

- `pnpm install --frozen-lockfile --strict-peer-dependencies` — успешно.
- `pnpm build:packages` — успешно.
- `pnpm --filter @kanbaner/plugin-projects typecheck` — успешно.
- Focused bulk:
  `vitest run packages/plugin-projects/src/kanban.test.tsx -t "массовые действия"`
  — **12 passed**.
- `vitest run packages/plugin-projects` — **268 passed / 18 files**.
- `pnpm check:imports` — успешно.
- `node scripts/check-import-boundaries.mjs --self-test` — успешно
  (22 ожидаемых нарушения).
- `pnpm check` — успешно:
  - `format:check`;
  - `lint`;
  - typecheck всех пакетов и `apps/web`;
  - **1391 passed / 98 files**;
  - production `build`.
- `pnpm --filter @kanbaner/web test:e2e` — **102 passed (2.8m)**.
  Playwright использовал реальные `task.moveMany`/`task.deleteMany`.
  Покрыто:
  - move 2 карточек в порядке выбора, summary и persistence после reload;
  - delete parent+child одним подтверждением и persistence;
  - conflict второй вкладки, сохранение выбора и повтор со свежей версией;
  - mobile 360: checkbox, bulk bar, move без overflow;
  - прежние DnD, card layout и hit targets.
- Deferred SIGTERM: `stop accepting requests, active=0`, `shutdown complete`.
- Prettier и `git diff --check` — чисто.
- Красного хвоста проверок нет.

## Остаточные риски

- При временной ошибке `task.get` задача консервативно остаётся в выборе до
  следующего успешного refresh.
- Смена tag во время pending снимает скрытые задачи, но не отменяет уже
  отправленную команду; успешный ответ очищает выбор.
- Лимит 200 окончательно валидирует домен; UI проверяет его заранее.
