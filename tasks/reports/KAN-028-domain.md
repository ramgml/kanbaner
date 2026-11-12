# KAN-028 — массовый перенос и удаление карточек (домен)

- Задача: `tasks/KAN-028-bulk-card-actions.md`
- Ветка: `feat/kan-028-bulk-domain`
- Worktree: `.worktrees/kan-028-bulk-domain`
- Коммит: `feat(tasks): добавить атомарные массовые операции`

## Публичный контракт

Добавлены ровно согласованные команды:

```text
kanbaner.tasks.task.moveMany     risk = write
kanbaner.tasks.task.deleteMany   risk = destructive
```

- `task.moveMany`
  - вход: `{ items: [{ id, expectedVersion }], columnId }`, 1…200 задач;
  - выход: `{ tasks: Task[] }` в порядке входного массива;
  - только append в target; source и target могут совпадать.
- `task.deleteMany`
  - вход: `{ items: [{ id, expectedVersion }], confirm: true }`, 1…200 задач;
  - успешный выход: `{ deleted: true, deletedResourceRefs, deletedTasks, eventId }`;
  - полностью отсутствующий набор: `{ deleted: false }` без событий и записи.

Обе команды атомарны, поддерживают `Idempotency-Key`, имеют UI exposure и
выключенные HTTP/MCP, как остальные операции домена.

## Реализация

- `packages/plugin-tasks/src/constants.ts` — ID команд, `MAX_BULK_TASKS = 200`.
- `packages/plugin-tasks/src/schemas/task.ts` — JSON Schema и типы входа/выхода,
  доменные коды `DUPLICATE_TASK_ID`, `TASKS_OTHER_PROJECT`, `INVALID_BULK_SIZE`.
- `packages/plugin-tasks/src/operations.ts` — метаданные `write`/`destructive`.
- `packages/plugin-tasks/src/activation/bulk.ts` — транзакционные сценарии:
  - предварительная проверка размера, уникальности ID, существования, одного
    `projectId`, точных `expectedVersion` и target того же проекта до первой
    записи;
  - move: стабильный base по target без выбранных задач, последовательный
    append в порядке входа, фактическая версия из транзакции для каждой задачи
    (сдвиг соседей этой же операцией не даёт ложный `VERSION_CONFLICT`);
  - delete: каскад parent+child без повторного удаления, дедупликация
    дескрипторов, all-missing no-op.
- `packages/plugin-tasks/src/activation.ts` — обработчики, события
  `task.moved`/`task.updated`/`task.deleted`, search upsert/delete и публикация
  только после commit через `executeMutation`.
- `packages/plugin-tasks/src/validation.ts` — новые доменные коды ошибок.
- `specs/plugin-contract.md` — описание массовых команд и их семантики.
- `specs/architecture.md` — инварианты moveMany/deleteMany.

Новых Store-методов нет: используются одна `TasksStore.withTransaction` и
существующие `getTask`/`getColumn`/`moveTask`/`deleteTask`.

## Необходимое изменение SDK

SDK отклонял camelCase в сегменте действия (`OPERATION_ID_PATTERN` разрешал
только нижний регистр), поэтому зарегистрировать согласованные ID было
невозможно. Точечно расширен только сегмент операции:

- `packages/plugin-sdk/src/plugin-id.ts` — `OPERATION_SEGMENT_SOURCE` допускает
  `moveMany`/`deleteMany`; Plugin ID, контракты, типы ресурсов и связи остаются
  строгими;
- `packages/plugin-sdk/src/plugin-id.test.ts` — проверка camelCase и сохранения
  запрета на верхний регистр в начале/plugin ID.

Второго alias нет: в constants, handlers, operations, тестах и спецификациях
используются только `kanbaner.tasks.task.moveMany` и
`kanbaner.tasks.task.deleteMany`.

## Тесты

- `packages/plugin-tasks/src/activation/bulk.test.ts` — параметризованный
  in-memory + SQLite harness:
  - порядок append и source=target overlap;
  - соседние `task.updated` и search upsert;
  - rollback при stale version без изменений, событий и индексации;
  - duplicate / not found / чужой проект / чужой target rollback;
  - parent+child без дублей дескрипторов, событий и search refs;
  - all-missing no-op;
  - повтор moveMany/deleteMany по `Idempotency-Key`.
- `packages/plugin-tasks/src/schemas/task.test.ts` — границы 1…200, `confirm`,
  success/no-op выходы.
- `packages/plugin-tasks/src/operations.test.ts`, `contract.test.ts` — новые ID,
  risk и публичные схемы.
- `tests/integration/tasks-store-conformance.test.ts` — существующий набор на
  SQLite и in-memory остаётся зелёным.

## Проверки

- `pnpm install --frozen-lockfile --strict-peer-dependencies` — успешно.
- `pnpm --filter @kanbaner/plugin-tasks typecheck` — успешно.
- focused bulk/schema/operations/contract — 42 теста, зелёные.
- `pnpm check:imports` — успешно.
- `node scripts/check-import-boundaries.mjs --self-test` — успешно.
- `pnpm test` — 98 файлов, 1375 тестов, зелёные.
- `pnpm check` (format, lint, typecheck, test, build) — успешно; в production
  build остаются только прежние Turbopack warnings о dynamic filesystem access
  в kernel/storage-sqlite.

## Остаточные риски

- Расширение `OPERATION_ID_PATTERN` меняет грамматику публичных operation ID:
  camelCase теперь допустим после первого символа действия. Это необходимо для
  согласованных `moveMany`/`deleteMany`; plugin ID и прочие namespace-сегменты
  не ослаблены.
- UI должен использовать ровно `kanbaner.tasks.task.moveMany` и
  `kanbaner.tasks.task.deleteMany`; hyphenated alias намеренно отсутствует.
- HTTP/MCP для новых команд не включены, как и для остальных операций домена.
