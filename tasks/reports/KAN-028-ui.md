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
  - `cc69d5e` — `fix(projects): завершить синхронизацию массовых операций`;
  - финальный fix-коммит — tip ветки:
    `fix(projects): завершить обработку ошибок обновления доски`.

## Итог

Все findings ревью исправлены. Fallback-контракта нет: используются ровно
`TASKS_COMMAND_IDS.taskMoveMany` и `TASKS_COMMAND_IDS.taskDeleteMany`
(`kanbaner.tasks.task.moveMany` / `kanbaner.tasks.task.deleteMany`).

## Финальные Medium

### applied только при полном refresh

`reloadBoard()` возвращает `"applied"` только при `refreshComplete === true`:

- ошибка `task.list` любой колонки → `failed`;
- временная ошибка `task.get` при reconciliation → `failed`;
- `bulkNeedsRefresh` остаётся, stale payload заблокирован до полного refresh.

Добавлены отдельные тесты:

- `task.list` failure → блокировка, затем успешный refresh и retry с новыми
  версиями;
- temporary `task.get` failure → блокировка, затем успешный refresh и retry с
  новыми версиями.

### Пустой selection во время refresh

Общий `settleBulkRefresh(outcome)` используется в move/delete/retry. После
каждого `await reloadBoard()` сначала проверяется
`bulkSelectionRef.current.size === 0`:

- при пустом выборе блокировка, ошибки и диалог сбрасываются;
- `blocked` ставится только при непустом selection и неуспешном refresh;
- `cleared` не возвращает hidden block и не оставляет stale payload.

Deferred-тест: tag очищает selection во время R1, R2 падает по `column.list`,
continuation не блокирует checkbox; после R3 checkbox доступны.

### applied / superseded / latestOutcome

Сохранены прежние guards: устаревшая R1 ждёт результат более новой R2 через
`latestOutcome` и не перезаписывает успех/блокировку. `refreshComplete`
учитывает все колонки и временные ошибки `task.get`.

## Ранее исправленное

- Pending close: busy не обходит dirty-guard целиком; независимые
  inline/quick/subtask-черновики требуют confirm, pending без них закрывается
  без ложного confirm.
- `task.get` в reconcile принимает задачу только при совпадении `projectId`
  и активного tag; conflict + потерянный tag снимает задачу с выбора.
- `TaskMoveManyOutput` даёт фактические positions; visibility регистрируется
  только для moved-задач текущего project/tag, append за страницей и
  same-column append сразу видны.
- Неудачная перечитка после конфликта не заявляет обновление версий и
  блокирует повтор до успешного refresh с кнопкой «Обновить доску».
- Диалог удаления: `Выбрано задач: N`, подзадачи в число не входят.
- Стабильное закрытие карточки во время pending quick-команды.
- Лимит 200 для move/delete; массовые действия не используют single-команды.

## Проверки

Выполнено на HEAD с доменом `0ae279a`:

- `pnpm install --frozen-lockfile --strict-peer-dependencies` — успешно.
- `pnpm build:packages` — успешно.
- `pnpm --filter @kanbaner/plugin-projects typecheck` — успешно.
- Focused bulk:
  `vitest run packages/plugin-projects/src/kanban.test.tsx -t "массовые действия"`
  — **22 passed**.
- `vitest run packages/plugin-projects` — **281 passed / 18 files**.
- `pnpm check:imports` — успешно.
- `node scripts/check-import-boundaries.mjs --self-test` — успешно
  (22 ожидаемых нарушения).
- `pnpm check` — успешно:
  - `format:check`;
  - `lint`;
  - typecheck всех пакетов и `apps/web`;
  - **1404 passed / 98 files**;
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
  следующего успешного refresh; повтор при этом заблокирован.
- Лимит 200 окончательно валидирует домен; UI проверяет его заранее.
