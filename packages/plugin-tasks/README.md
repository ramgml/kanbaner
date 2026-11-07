# @kanbaner/plugin-tasks

Доменный плагин задач Kanbaner. Пакет фиксирует публичный контракт домена:
модель проектов и задач, TypeBox/JSON Schema, метаданные команд и запросов,
`TasksStore`, `ResourceRef`, события и поисковое представление.

В этой итерации (KAN-010) пакет **не содержит** UI, SQL, миграций, активации и
реализации хранения. Реализация `TasksStore` — KAN-011. Активация, регистрация
команд и запросов, публикация событий, поиск, exposure и `Idempotency-Key` —
KAN-012. Представления списка и канбана — KAN-013 и KAN-014.

## Точки входа

- `@kanbaner/plugin-tasks` — серверная точка входа. Экспортирует client-safe
  контракт, метаданные операций и контракт `TasksStore`. Её используют
  composition root и реализация плагина.
- `@kanbaner/plugin-tasks/contract` — client-safe entrypoint. Только типы,
  TypeBox-схемы, ID, `ResourceRef`, чистые валидаторы, backend-neutral
  компараторы списков, payload событий и преобразование в
  `SearchDocumentInput`. Без `activate`, Store, `node:*`, SQL и серверных
  модулей. Другой плагин или UI импортирует только этот subpath.

## Состав

- `src/contract.ts` — client-safe entrypoint.
- `src/model.ts` — `Project`, `Task`, статусы, приоритеты и сортировка.
- `src/schemas/*.ts` — TypeBox-схемы и производные TS-типы.
- `src/operations.ts` — серверные метаданные команд и запросов для `OperationBus`.
- `src/store.ts` — асинхронный backend-neutral контракт `TasksStore` и
  транзакционный `TasksStoreTransaction`.
- `src/validation.ts` — чистые доменные валидаторы и нормализация тегов.
- `src/listing.ts` — backend-neutral семантика сортировки и фильтров списков.
- `src/resources.ts` — `ResourceRef` проектов и задач.
- `src/events.ts` — типы и payload событий после коммита.
- `src/search.ts` — `toTaskSearchDocument` без записи в индекс.

## Команды

| ID                              | Risk          | Назначение                                   |
| ------------------------------- | ------------- | -------------------------------------------- |
| `kanbaner.tasks.project.create` | `write`       | Создать проект                               |
| `kanbaner.tasks.project.update` | `write`       | Изменить проект по `expectedVersion`         |
| `kanbaner.tasks.project.delete` | `destructive` | Удалить проект и его задачи                  |
| `kanbaner.tasks.task.create`    | `write`       | Создать задачу или подзадачу                 |
| `kanbaner.tasks.task.update`    | `write`       | Изменить поля задачи                         |
| `kanbaner.tasks.task.move`      | `write`       | Сменить статус и позицию                     |
| `kanbaner.tasks.task.complete`  | `write`       | Перевести в `done` и заполнить `completedAt` |
| `kanbaner.tasks.task.delete`    | `destructive` | Удалить задачу и её подзадачи                |

`project.delete` и `task.delete` требуют `confirm: true` в схеме. Все изменения
версионируемой сущности требуют `expectedVersion`; создание принимает только
`expectedVersion: 0`.

## Запросы

| ID                            | Назначение                                   |
| ----------------------------- | -------------------------------------------- |
| `kanbaner.tasks.project.list` | Стабильная страница проектов                 |
| `kanbaner.tasks.project.get`  | Проект по ID                                 |
| `kanbaner.tasks.task.get`     | Задача по ID                                 |
| `kanbaner.tasks.task.list`    | Задачи с фильтрами, сортировкой и пагинацией |

`task.list` поддерживает фильтры `projectId`, `status`, `priority`, `tag`,
`parentTaskId`, `text`, `dueBefore`, `dueAfter`. `parentTaskId: null` выбирает
корневые задачи. Сортировка задаётся `{ field, direction }`; поля: `position`,
`createdAt`, `updatedAt`, `dueAt`, `title`. `limit` — от 1 до 200, значение по
умолчанию 50; `offset` — неотрицательное целое.

### Backend-neutral семантика списков

- `project.list` всегда сортирует `createdAt asc`, затем `id asc`.
- `task.list` сортирует выбранное поле, затем `id asc` при равенстве.
- `dueAt = null` всегда последние независимо от `asc`/`desc`.
- `dueBefore` и `dueAfter` включают границу; `dueAt = null` не попадает в
  ограниченный диапазон.
- `text` сравнивается без учёта регистра как подстрока по NFKC-нормализованным
  `title` и `descriptionMarkdown` (`normalizeSearchText`).
- `tag` нормализуется так же, как теги задачи: trim, нижний регистр,
  дедупликация и лимиты (`normalizeTag`).
- `title` сравнивается по code points Unicode, без `localeCompare`.
- UTC timestamps сравниваются детерминированно: секунды, затем дробная часть с
  выравниванием справа нулями. `.1Z` равно `.100Z`, `Z` меньше `.100Z`,
  точность больше трёх знаков не теряется; `Date.parse` не используется.
- Готовые компараторы: `compareProjects`, `compareTaskList`,
  `compareNullableDueAt`, `compareUtcTimestamps`, `matchesTaskText`,
  `matchesDueRange`.

## Позиция задачи

`position` уникальна и задаёт порядок в области `(projectId, status)`.
`parentTaskId` на область уникальности не влияет: корневые задачи и подзадачи
одного проекта и статуса упорядочиваются вместе. Непрерывность `0…N-1` не
требуется — допустимы разреженные целые позиции, если уникальность и порядок
сохранены. Чистый ключ области даёт `taskPositionScopeKey(projectId, status)`.

## Append и completedAt

`position` в `CreateTaskStoreInput` и `CompleteTaskStoreInput` необязательна:

- `undefined` — атомарный append в конец области `(projectId, status)`;
- явное число — транзакционный сдвиг соседей в той же области.

`completedAt` не передаётся в Store. Store вычисляет его чистой функцией
`resolveCompletedAt`:

- создание в `done` — `completedAt = createdAt`;
- перемещение в `done` — `completedAt = updatedAt`;
- выход из `done` — `completedAt = null`;
- повторный `completeTask` для уже `done` возвращает текущую задачу без
  изменения версии и сохраняет прежний `completedAt`.

Схема `TaskSchema` и `validateCompletionInvariant` выражают инвариант
`done ⇔ completedAt !== null`.

## Сырые и нормализованные теги

Входные команды принимают сырые теги: пробелы по краям, дубликаты и до
`MAX_RAW_TAGS = 100` элементов длиной до `MAX_RAW_TAG_LENGTH = 256`. Схема не
применяет trim и не отклоняет дубликаты сверх `MAX_TAGS`.

После доменной нормализации (`normalizeTags`) сохраняется не более
`MAX_TAGS = 10` уникальных тегов длиной до `MAX_TAG_LENGTH = 32`. Схема
`TaskSchema` требует `uniqueItems` и запрещает внешние пробелы. Чистая
`validateNormalizedTags` сравнивает массив с результатом `validateTags` и
отклоняет верхний регистр, внешние пробелы и дубликаты, включая Unicode-регистр
(`Ä`/`ä`). `validateStoredTask`/`assertStoredTask` — граница сохранённой
модели; Store обязан вызывать их перед записью и после чтения. Фильтр
`task.list.tag` нормализуется функцией `normalizeTag` тем же способом.

## Как использовать из другого плагина

Другой плагин и UI импортируют только `@kanbaner/plugin-tasks/contract`:

```ts
import {
  TASKS_COMMAND_IDS,
  formatTaskRef,
  toTaskSearchDocument,
  type Task,
} from "@kanbaner/plugin-tasks/contract";

// Вызов команды по публичному ID через общий OperationBus.
await context.commands.execute(TASKS_COMMAND_IDS.taskComplete, {
  id: "task-1",
  expectedVersion: 3,
});

// Ссылка на ресурс для связей, поиска и навигации.
const ref = formatTaskRef("task-1"); // "kanbaner.tasks:task:task-1"

// Чистое преобразование задачи в SearchDocumentInput выполняет сам плагин
// задач в KAN-012; функция ничего не пишет в индекс и не добавляет pluginId.
const document = toTaskSearchDocument(task);
```

Серверная точка входа нужна composition root и реализации плагина. Другой
плагин не импортирует из неё `TASKS_COMMAND_LIST`, `TASKS_QUERY_LIST`,
`TASKS_STORE_CONTRACT_DEFINITION` и внутренние модули.

Формат ссылок:

```text
kanbaner.tasks:project:<id>
kanbaner.tasks:task:<id>
```

`parseProjectRef`, `parseTaskRef`, `isProjectRef` и `isTaskRef` проверяют
владельца (`pluginId`) и тип ресурса. Ссылки другого плагина отклоняются.

## События

После успешного коммита публикуются:

```text
kanbaner.tasks.project.created|updated|deleted
kanbaner.tasks.task.created|updated|moved|completed|deleted
```

Payload содержит минимальные идентификаторы и версию; полное состояние
получается запросом. События `project.deleted` и `task.deleted` несут
`version` последней сохранённой корневой сущности, `eventVersion` и
`deletedTasks` с дескрипторами `{ id, projectId, resourceRef, version,
eventVersion }`. Envelope использует `resourceVersion = eventVersion =
version + 1`: update(v3) → delete event(v4). У каждой задачи каскада своя
`eventVersion`. Tombstone-версия не создаётся. Доставка best-effort,
обработчик должен быть идемпотентным.

## TasksStore и данные

`TasksStore` — асинхронный интерфейс без SQL, имён таблиц, драйвера и
backend-специфичных типов. Домен передаёт готовые ID и UTC-время; версии
проверяются по `expectedVersion`. Тип `TasksIdFactory` описывает генератор ID,
который используется до записи.

### Транзакции и idempotency

`TasksStore.withTransaction(callback)` открывает транзакцию провайдера и
передаёт `TasksStoreTransaction`:

```ts
await store.withTransaction(async (transaction) => {
  const task = await transaction.createTask(input);
  await transaction.documents.put(idempotencyDocument);
  return task;
});
```

- Root-методы Store открывают собственную транзакцию.
- Методы на `TasksStoreTransaction` используют текущую транзакцию и не
  открывают вложенную.
- `transaction.documents` — bound `PluginDocumentStore` той же транзакции.
  KAN-012 пишет idempotency-результат в одной транзакции с доменной мутацией.
- Вложенный `withTransaction` бросает `TasksNestedTransactionError` с кодом
  `NESTED_TRANSACTION`. Savepoints не поддерживаются и не подразумеваются.

### Каскадное удаление

`DeleteStoreResult` дискриминирован:

- `deleted: true` содержит `version` корня (равен `expectedVersion`),
  `eventVersion = version + 1`, `deletedResourceRefs` и `deletedTasks` с
  последними сохранёнными версиями и их `eventVersion`;
- `deleted: false` — идемпотентный no-op без события и без `eventId`.

Ответы `project.delete` и `task.delete` используют ту же дискриминацию:
`deleted: true` содержит `eventId`, `deleted: false` — нет. Tombstone-версия
не создаётся. Delete-событие каждого ресурса использует
`resourceVersion = version + 1`; у каждой задачи каскада версия считается от её
собственной последней сохранённой версии. Готовая чистая функция —
`deleteEventVersion(version)`.

Физическое хранение проектируется как namespaced document collections плагина:

```text
projects
tasks
```

Теги хранятся внутри документа задачи. Конкретные имена `tasks_*` и физическая
схема остаются деталью Storage Provider и не входят в публичный контракт.

Поэтому в `plugin.json` нет `migrations`, а в пакете нет SQL-миграции: плагин
владеет только документами в своём namespace. Manifest явно объявляет
`provides` для `kanbaner.tasks.commands.v1`, `kanbaner.tasks.queries.v1` и
`kanbaner.tasks.events.v1`. Контракт `kanbaner.tasks.store.v1` остаётся
внутренним контрактом пакета и не публикуется как `provides`. Если позже
понадобится специализированная SQL-схема, она будет добавлена провайдером или
отдельной задачей без изменения команд и `TasksStore`.

## Проверки

```bash
pnpm --filter @kanbaner/plugin-tasks build
pnpm --filter @kanbaner/plugin-tasks typecheck
pnpm exec vitest run packages/plugin-tasks
```
