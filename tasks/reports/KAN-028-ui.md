# KAN-028 — UI массовых действий с карточками

- Задача: `tasks/KAN-028-bulk-card-actions.md`
- Ветка: `feat/kan-028-bulk-ui`
- Worktree: `.worktrees/kan-028-bulk-ui`
- Домен в HEAD: `2e5df62`, `0ae279a` (контракт `task.moveMany`/`task.deleteMany`)
- UI-коммиты:
  - `21507e4` — `feat(projects): добавить массовые действия с карточками`;
  - `1152e51`, `d379096` — отчёт;
  - финальный fix-коммит — tip ветки:
    `fix(projects): синхронизировать массовый выбор после обновления`.

## Итог

Все findings ревью KAN-028 UI исправлены. Fallback-контракта нет: используются
ровно `TASKS_COMMAND_IDS.taskMoveMany` и `TASKS_COMMAND_IDS.taskDeleteMany`
(`kanbaner.tasks.task.moveMany` / `kanbaner.tasks.task.deleteMany`).

## Исправления по findings

### HIGH: скрытый filter после конфликта

`reconcile` при `task.get` принимает задачу только если совпадают:

- `projectId` активного проекта;
- активный `normalizeFilterTag(filters.tag)` (пустой tag не ограничивает).

Если во второй вкладке у задачи удалён тег, filtered list её больше не
содержит, `task.get` возвращает задачу без нужного тега, и она снимается с
выбора. Повторный payload её не содержит. Задачи, подходящие под фильтр, но
находящиеся за границей страницы, по-прежнему сохраняются через `task.get`.

Покрыто component- и E2E-регрессиями «conflict + tag removed».

### MEDIUM: видимость перемещённых карточек

`task.moveMany` теперь типизирован как `TaskMoveManyOutput`. До reload UI для
каждой перемещённой задачи:

- обновляет `loadedCountsRef[target]` до `position + 1`;
- регистрирует `visibilityRef` с фактической позицией и текущим `filterKey`.

Поэтому target догружается до последней перемещённой позиции, и карточки сразу
видны:

- при append в колонку длиннее `KANBAN_PAGE_SIZE`;
- при same-column append;
- после stale-ответа операция не применяется из-за project/generation guard.

Покрыто component-тестами target > page size и same-column append.

### MEDIUM: failed refresh после конфликта

`reloadBoard()` теперь возвращает `boolean`: `true` только если применил все
колонки и полностью согласовал selection (включая `task.get`). Существующие
callers не изменены по контракту вызова и игнорируют результат там, где он не
нужен.

Поведение mass actions:

- сообщение «доска перечитана / версии обновлены» показывается только при
  успешном refresh;
- при неудаче UI явно пишет, что версии НЕ обновлены;
- move/delete/clear/checkbox блокируются до успешной перечитки;
- в панели и destructive-диалоге доступна кнопка «Обновить доску»;
- повторная команда уходит только после успешного refresh со свежими
  `expectedVersion`.

Component-тест `VERSION_CONFLICT + failed reload` доказывает отсутствие второго
stale payload и успешный retry после перечитки.

### LOW: текст подтверждения удаления

Диалог показывает `Выбрано задач: N` и отдельно поясняет, что каскадные
подзадачи в это число не входят. Component- и E2E-проверки обновлены.

### Дополнительно: стабильность закрытия карточки

Устранён источник intermittent E2E-падений при закрытии карточки во время
pending quick-команды: `requestClose` использует актуальный dirty-guard из
layout-ref и при busy закрывает карточку без промежуточного dirty-confirm.
Поздний success по-прежнему обновляет доску. Добавлен component-тест.

## Проверки

Выполнено на HEAD с доменом `0ae279a`:

- `pnpm install --frozen-lockfile --strict-peer-dependencies` — успешно.
- `pnpm build:packages` — успешно.
- `pnpm --filter @kanbaner/plugin-projects typecheck` — успешно.
- Focused bulk:
  `vitest run packages/plugin-projects/src/kanban.test.tsx -t "массовые действия"`
  — **16 passed**.
- `vitest run packages/plugin-projects` — **273 passed / 18 files**.
- `pnpm check:imports` — успешно.
- `node scripts/check-import-boundaries.mjs --self-test` — успешно
  (22 ожидаемых нарушения).
- `pnpm check` — успешно:
  - `format:check`;
  - `lint`;
  - typecheck всех пакетов и `apps/web`;
  - **1396 passed / 98 files**;
  - production `build`.
- `pnpm --filter @kanbaner/web test:e2e` — **103 passed (3.0m)**.
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
- Смена tag во время pending снимает скрытые задачи, но не отменяет уже
  отправленную команду; успешный ответ очищает выбор.
- Лимит 200 окончательно валидирует домен; UI проверяет его заранее.
