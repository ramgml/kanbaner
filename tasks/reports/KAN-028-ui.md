# KAN-028 — UI массовых действий с карточками

- Задача: `tasks/KAN-028-bulk-card-actions.md`
- Ветка: `feat/kan-028-bulk-ui`
- Worktree: `.worktrees/kan-028-bulk-ui`
- Домен: `feat/kan-028-bulk-domain`, коммит `2e5df62`
- Коммит UI: заполняется после `git commit`

## Что сделано

### Карточка

- Сохранена и дополнена незакоммиченная верстка пользователя: drag-ручки нет,
  меню `⋯` находится в верхней строке справа, заголовок занимает отдельную
  строку во всю ширину.
- В верхней строке слева добавлен чекбокс массового выбора:
  - accessible name `Выбрать задачу …`;
  - hit target 40×40 px (`label` с `min-h-10 min-w-10`);
  - `input` и `label` исключены из drag;
  - клик не открывает карточку и не запускает drag/ghost;
  - pending массовой операции блокирует изменение выбора.
- Whole-card drag, drag за заголовок, ghost, меню, keyboard-навигация и
  подавление click после drag не изменены.

### Selection и панель

- Выбор хранится как `Map<id, Task>` в порядке кликов; snapshot используется
  для `expectedVersion`.
- Смена `projectId` очищает выбор и target.
- Смена tag сразу снимает из выбора задачи, которых нет в новом фильтре.
- `reloadBoard` обновляет версии выбранных задач из актуальных items. Если
  задача не попала на загруженную страницу, выполняется `task.get`:
  - `NOT_FOUND` удаляет задачу из выбора;
  - временная ошибка сохраняет прежний snapshot;
  - обычный refresh/resize не теряет существующие задачи.
- Панель при `count > 0`:
  - `Выбрано N`;
  - select фактических колонок текущего проекта;
  - «Переместить», «Удалить», «Снять выбор»;
  - `aria-label`, текстовые подписи и 40 px высота контролов;
  - desktop и mobile 360 без горизонтального overflow.
- Pending блокирует повторную отправку; ошибка не очищает выбор.

### Move

- Одна команда `task.moveMany` с `items` в порядке выбора и `columnId`.
- Успех: очистка выбора, awaited `reloadBoard()`, затем
  `bumpKanbanRevision()`; счётчики колонок и сводка обновляются.
- Ошибка: awaited reload, выбор сохраняется, повтор использует свежие версии.
- `VERSION_CONFLICT` показывает сообщение про выбранные задачи.

### Delete

- Отдельный destructive `ModalDialog` (`kanban-bulk-delete-dialog`):
  - число задач;
  - предупреждение о безвозвратном удалении и каскаде подзадач;
  - pending блокирует закрытие, Escape, «Отмена» и повтор.
- Одна команда `task.deleteMany` с `confirm: true`.
- Успех: закрытие диалога, очистка выбора, awaited reload и bump revision.
- Ошибка/конфликт: reload, сохранение существующего выбора с актуальными
  версиями; исчезнувшие задачи удаляются из выбора; повтор использует свежие
  `expectedVersion`.
- Последовательных single-команд `task.delete`/`task.move` для массовых
  действий нет.

### Контракт

Используются строковые ID из `TASKS_COMMAND_IDS`:

- `kanbaner.tasks.task.moveMany`;
- `kanbaner.tasks.task.deleteMany`.

В isolated-сборке до merge домена `operations.ts` содержит те же строки как
fallback. После merge фактическим источником остаётся `TASKS_COMMAND_IDS`.

## Тесты

### Component

- `kanban-card.test.tsx`:
  - layout: checkbox слева, меню справа, title full width, drag-ручки нет;
  - accessible checkbox, hit target, click не открывает, drag не стартует.
- `kanban.test.tsx`, 14 новых сценариев:
  - move одной командой, порядок payload и append;
  - ошибка сохраняет выбор;
  - conflict обновляет версии, убирает исчезнувшие и повторяет по свежим;
  - delete после подтверждения, parent+child без дублей;
  - pending delete блокирует закрытие/повтор;
  - ошибка delete сохраняет выбор;
  - смена tag убирает скрытые;
  - смена проекта очищает;
  - обычный refresh сохраняет выбор и обновляет версии;
  - pending move блокирует повтор;
  - «Снять выбор» не отправляет команду.

### E2E

Добавлены сценарии в `apps/web/e2e/kanban.spec.ts`:

- desktop move 2 карточек в порядке выбора, summary и persistence после reload;
- delete parent+child одним подтверждением, persistence, независимая задача
  остаётся;
- conflict второй вкладки: ошибка, сохранение выбора, повтор со свежей версией,
  persistence;
- mobile 360: hit target, панель, move без overflow;
- обновлён layout/hit-target тест карточки.

## Проверки

- `pnpm install --frozen-lockfile --strict-peer-dependencies` — успешно.
- `pnpm check` — успешно:
  - `format:check`;
  - `lint`;
  - `typecheck` всех пакетов и `apps/web`;
  - `vitest`: **1371 passed / 96 files**;
  - `build` (включая production Next.js).
- `pnpm check:imports` — успешно.
- `node scripts/check-import-boundaries.mjs --self-test` — успешно
  (22 ожидаемых нарушения).
- E2E в UI-only worktree (без домена): **97 passed**, 5 failed. Четыре
  bulk-сценария падают с `Операция недоступна для UI`, потому что команд ещё
  нет в контракте этой ветки; один нестабильный сценарий
  «создаёт через общую кнопку…» прошёл при отдельном повторе и в
  интеграционном прогоне.
- Интеграционный E2E в временном combined checkout
  (`UI + domain 2e5df62`, без merge/rebase рабочих веток):
  **102 passed (3.1m)**, включая все 4 массовых сценария и mobile 360.
  Проверены move persistence + summary, delete parent+child, conflict второй
  вкладки и отсутствие overflow.

## Ограничения и риски

- Полный E2E массовых действий имеет смысл только после merge домена; в
  UI-only worktree команды не экспортированы.
- Домен и UI должны быть смержены вместе: UI ссылается на
  `task.moveMany`/`task.deleteMany`.
- После неуспешного `task.get` выбор сохраняется консервативно; следующая
  успешная перезагрузка уберёт действительно удалённые задачи.
- При 1…200 выбранных задач UI проверяет лимит; сам лимит окончательно
  валидирует домен.
