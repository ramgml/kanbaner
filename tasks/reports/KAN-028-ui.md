# KAN-028 — UI массовых действий с карточками

- Задача: `tasks/KAN-028-bulk-card-actions.md`
- Ветка: `feat/kan-028-bulk-ui`
- Worktree: `.worktrees/kan-028-bulk-ui`
- Домен в HEAD: `2e5df62`, `0ae279a` (контракт `task.moveMany`/`task.deleteMany`)
- UI-коммиты:
  - `21507e4` — `feat(projects): добавить массовые действия с карточками`;
  - `1152e51`, `d379096` — отчёт;
  - `2d9ced7` — `fix(projects): укрепить массовый выбор карточек`;
  - `f04367d` — `fix(projects): синхронизировать массовый выбор после обновления`;
  - финальный fix-коммит — tip ветки:
    `fix(projects): завершить синхронизацию массовых операций`.

## Итог

Все findings повторного ревью исправлены. Fallback-контракта нет: используются
ровно `TASKS_COMMAND_IDS.taskMoveMany` и `TASKS_COMMAND_IDS.taskDeleteMany`
(`kanbaner.tasks.task.moveMany` / `kanbaner.tasks.task.deleteMany`).

## Повторное ревью

### HIGH: pending close и независимые черновики

`busy` больше не является общим bypass dirty-guard. Для каждой операции
запоминается отправляемое поле (`inline`, `quick-column`, `quick-due`,
`quick-tags`, `subtask`). При закрытии:

- собственный pending-черновик не считается независимым;
- inline/quick/subtask-черновики других полей требуют подтверждения;
- pending без дополнительных черновиков закрывает карточку без ложного
  confirm, а поздний success обновляет доску.

Покрыто deferred-тестами:

- pending inline save + quick-draft → confirm, оба черновика сохранены;
- dirty inline + pending quick save → confirm, черновик сохранён;
- pending quick save без других черновиков → закрытие без confirm.

### MEDIUM: пустой выбор снимает refresh-блокировку

Если после неудачной перечитки selection становится пустым (все задачи
удалены или перестали соответствовать активному tag), `bulkNeedsRefresh`
сбрасывается вместе с ошибками и диалогом. Скрытой блокировки без payload нет.
Смена tag, оставившая выбор пустым, делает то же. `toggleBulkSelection`
проверяет и `bulkNeedsRefreshRef`, и `bulkGuardRef`.

Покрыто тестом conflict → failed reload → tag mismatch/empty selection:
checkbox снова enabled, можно выбрать задачу и открыть панель.

### MEDIUM: superseded reload

`reloadBoard()` возвращает `"applied" | "failed" | "superseded"` и хранит
promise последней перечитки. Устаревшая R1 при sequence/filter mismatch ждёт
результат более новой R2, а не выставляет блокировку по своему late-ответу.
Успешная R2 не перезаписывается. Deferred-тест R1/R2 подтверждает отсутствие
ложной блокировки и повтор с версией, полученной R2.

### MEDIUM: visibility и текущий tag

При `task.moveMany` `loadedCountsRef`/`visibilityRef` регистрируются только
для moved-задач, соответствующих текущим `projectId` и
`normalizeFilterTag(activeTag)`. Если tag сменился во время pending, лишние ID
не остаются required, нет полной догрузки/повторного сканирования; подходящие
задачи сохраняются. Deferred-тест проверяет последнюю страницу target: 6, а не
7 при ошибочной регистрации скрытой задачи.

## Ранее исправленное

- `task.get` в reconcile принимает задачу только при совпадении `projectId`
  и активного tag; conflict + удалённый tag снимает задачу с выбора.
- `TaskMoveManyOutput` используется для фактических positions, append за
  границей страницы и same-column append сразу показывают карточки.
- Неудачная перечитка после конфликта не заявляет обновление версий и
  блокирует повтор до успешного refresh с кнопкой «Обновить доску».
- Диалог удаления: `Выбрано задач: N`, каскадные подзадачи в число не входят.
- Стабильное закрытие карточки во время pending quick-команды.
- Лимит 200 проверяется и для move, и для delete.
- Последовательных single-команд для массовых действий нет.

## Проверки

Выполнено на HEAD с доменом `0ae279a`:

- `pnpm install --frozen-lockfile --strict-peer-dependencies` — успешно.
- `pnpm build:packages` — успешно.
- `pnpm --filter @kanbaner/plugin-projects typecheck` — успешно.
- Focused bulk:
  `vitest run packages/plugin-projects/src/kanban.test.tsx -t "массовые действия"`
  — **19 passed**.
- `vitest run packages/plugin-projects` — **278 passed / 18 files**.
- `pnpm check:imports` — успешно.
- `node scripts/check-import-boundaries.mjs --self-test` — успешно
  (22 ожидаемых нарушения).
- `pnpm check` — успешно:
  - `format:check`;
  - `lint`;
  - typecheck всех пакетов и `apps/web`;
  - **1401 passed / 98 files**;
  - production `build`.
- `pnpm --filter @kanbaner/web test:e2e` — **103 passed (2.8m)**.
  Playwright использовал реальные `task.moveMany`/`task.deleteMany`.
  Покрыто:
  - move 2 карточек в порядке выбора, summary и persistence после reload;
  - delete parent+child одним подтверждением и persistence;
  - conflict второй вкладки, сохранение выбора и повтор со свежей версией;
  - conflict + потерянный активный tag;
  - mobile 360: checkbox, bulk bar, move без overflow;
  - прежние DnD, card layout, inline-редакторы и hit targets.
- Deferred SIGTERM: `stop accepting requests, active=0`, `shutdown complete`.
- Prettier и `git diff --check` — чисто.
- Красного хвоста проверок нет.

## Остаточные риски

- При временной ошибке `task.get` задача консервативно остаётся в выборе до
  следующего успешного refresh.
- Лимит 200 окончательно валидирует домен; UI проверяет его заранее.
