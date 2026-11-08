# @kanbaner/plugin-tasks

Доменный плагин задач Kanbaner. Пакет фиксирует публичный контракт домена:
модель проектов и задач, TypeBox/JSON Schema, метаданные команд и запросов,
`TasksStore`, `ResourceRef`, события и поисковое представление.

Начиная с KAN-012 пакет — рабочий **headless-плагин**: `activate` регистрирует
команды, запросы и типы ресурсов, выполняет мутации в транзакциях, публикует
события после коммита, поддерживает `Idempotency-Key` и обновляет поисковый
индекс. UI, SQL и миграций в пакете нет: `TasksStore` работает поверх
namespaced `PluginDocumentStore`. Представления списка и канбана — KAN-013 и
KAN-014.

## Точки входа

- `@kanbaner/plugin-tasks` — серверная точка входа. Экспортирует `activate`,
  client-safe контракт, метаданные операций и контракт `TasksStore`. Её
  используют composition root и runtime плагинов.
- `@kanbaner/plugin-tasks/contract` — client-safe entrypoint. Только типы,
  TypeBox-схемы, ID, `ResourceRef`, чистые валидаторы, backend-neutral
  компараторы списков, payload событий и преобразование в
  `SearchDocumentInput`. Без `activate`, Store, `node:*`, SQL и серверных
  модулей. Другой плагин или UI импортирует только этот subpath.
- `@kanbaner/plugin-tasks/testing` — тестовый entrypoint с
  `createTasksStoreConformanceSuite`. Не входит в production entrypoint и не
  импортирует kernel, Storage Provider, SQLite или Vitest.

## Состав

- `src/contract.ts` — client-safe entrypoint.
- `src/model.ts` — `Project`, `Task`, статусы, приоритеты и сортировка.
- `src/schemas/*.ts` — TypeBox-схемы и производные TS-типы.
- `src/operations.ts` — серверные метаданные команд и запросов для `OperationBus`.
- `src/activation.ts` — `activate(context)`: регистрация операций, ресурсов,
  idempotency, событий и поиска.
- `src/activation/**` — idempotency, конверт ошибок, события, поисковый индекс,
  снимки задач для diff соседей и per-activation очередь.
- `src/store.ts` — асинхронный backend-neutral контракт `TasksStore` и
  транзакционный `TasksStoreTransaction`.
- `src/store/**` — реализация `createTasksStore` поверх bound
  `PluginStorage`/`PluginDocumentStore`, ошибки Store и тесты subpath.
- `src/testing.ts` — публичный `createTasksStoreConformanceSuite` для
  провайдеров.
- `src/validation.ts` — чистые доменные валидаторы и нормализация тегов.
- `src/listing.ts` — backend-neutral семантика сортировки и фильтров списков.
- `src/resources.ts` — `ResourceRef` проектов и задач.
- `src/events.ts` — типы и payload событий после коммита.
- `src/search.ts` — `toTaskSearchDocument`.

## Запуск и активация

Плагин активируется штатным runtime через `KANBANER_PLUGIN_DIRS`. Каталог должен
содержать пакеты плагинов (для репозитория — `packages/`):

```bash
KANBANER_PLUGIN_DIRS=packages pnpm dev
```

`activate` использует только публичный `PluginActivationContext`:
`commands`, `queries`, `resourceTypes`, `events`, `storage`, `search` и
`logger`. Ядро и Storage Provider напрямую не импортируются.

Активация:

- проверяет `pluginId === "kanbaner.tasks"`;
- регистрирует все команды и запросы KAN-010 с `exposure.ui: true`,
  `http: false`, `mcp: false`;
- регистрирует типы ресурсов `project` и `task` с `resolve`;
- запускает best-effort полную переиндексацию задач;
- создаёт собственную последовательную очередь, которая сериализует доменные
  транзакции, поисковые эффекты и переиндексацию, чтобы reindex не пересёкся с
  create/update/delete.

Мутации, idempotency и снимки для diff выполняются в транзакции
`TasksStore.withTransaction`. Поисковые upsert/delete применяются сразу после
коммита внутри очереди активации. События публикуются после выхода из очереди,
но публикация всё ещё ожидается вызывающей командой. Поэтому подписчик может
через общий `OperationBus` вызвать следующую команду без deadlock: очередь уже
свободна, а порядок tx → search → events сохранён. Ошибка события или индекса
логируется и не отменяет зафиксированную команду.

## Ошибки операций

Доменные и storage-ошибки сводятся к стабильным кодам Plugin Contract и
выбрасываются из обработчика как публичный SDK `PluginOperationError`.
Kernel `OperationFailure` является его subclass-ом, поэтому шина мапит оба типа
в `VERSION_CONFLICT`, `NOT_FOUND`, `VALIDATION_ERROR`,
`IDEMPOTENCY_CONFLICT` и другие коды. Произвольный `Error` остаётся
`INTERNAL_ERROR` и не раскрывает сообщение, стек или внутренние пути.

Плагин не импортирует ядро и не извлекает конструкторы ошибок из bound-сервисов.

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

Все операции регистрируются с `exposure.ui: true` и выключенными HTTP/MCP.
Схемы входа и выхода берутся из KAN-010 и не дублируются в activation.
Разрушительные команды помечены `risk = destructive`, `task.complete` —
`write`, запросы — `read`.

## Запросы

| ID                               | Назначение                                     |
| -------------------------------- | ---------------------------------------------- |
| `kanbaner.tasks.project.list`    | Стабильная страница проектов                   |
| `kanbaner.tasks.project.get`     | Проект по ID                                   |
| `kanbaner.tasks.project.summary` | Точные счётчики и просроченные задачи проектов |
| `kanbaner.tasks.task.get`        | Задача по ID                                   |
| `kanbaner.tasks.task.list`       | Задачи с фильтрами, сортировкой и пагинацией   |

`project.summary` принимает необязательный `projectId` и пагинацию
`limit`/`offset` для списка проектов. Выход содержит `items` со сводкой
каждого проекта (`project`, `total`, `counts` по статусам `backlog`, `todo`,
`in_progress`, `done`, `overdueCount`), `total`/`nextOffset` страницы и
`totals` — агрегат по **всем** подходящим проектам, а не по странице.
Явный несуществующий `projectId` возвращает `NOT_FOUND`. Счётчики считаются
по полному набору задач проекта: Store читает документы пачками и агрегирует
их без SQL и без запроса на каждый проект. `overdueCount` включает только
незавершённые задачи (`status !== "done"`) с `dueAt` раньше текущего UTC;
`dueAt == now` не считается просроченным, сравнение идёт через
`compareUtcTimestamps`.

`task.list` поддерживает фильтры `projectId`, `status`, `priority`, `tag`,
`parentTaskId`, `text`, `dueBefore`, `dueAfter`. `parentTaskId: null` выбирает
корневые задачи. Сортировка задаётся `{ field, direction }`; поля: `position`,
`createdAt`, `updatedAt`, `dueAt`, `title`. `limit` — от 1 до 200, значение по
умолчанию 50; `offset` — неотрицательное целое.

### Backend-neutral семантика списков

- `project.list` всегда сортирует `createdAt asc`, затем `id asc`.
- `project.summary` использует тот же порядок проектов и пагинацию, но
  `totals` и счётчики не зависят от страницы.
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

// Чистое преобразование задачи в SearchDocumentInput. Функция ничего не
// пишет в индекс и не добавляет pluginId; запись выполняет activation.
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

При insert/move/complete/delete activation сравнивает снимки задач проекта до и
после мутации в той же транзакции. Каждый фактически сдвинутый сосед получает
`task.updated` со своей новой `position` и `resourceVersion`; основная задача
операции в этот список не попадает. Для `task.delete` события удалённых задач
публикуются отдельно от `task.updated` оставшихся соседей.

Все события имеют `source = "kanbaner.tasks"` и `contractVersion = 1`.
Ошибка публикации или отклонённый конверт логируются и не превращают успешную
команду в ошибку.

## Idempotency-Key

Команды поддерживают `Idempotency-Key` из `ExecutionContext`:

- результат успешной команды хранится в коллекции `idempotency` namespace
  `kanbaner.tasks`;
- проверка ключа, доменная мутация и запись результата выполняются в одной
  транзакции `TasksStore`; при откате не остаётся ни мутации, ни записи;
- ID записи — SHA-256 от `operationId` и ключа, а не сам ключ;
- сравнение ввода выполняется по канонизированному JSON (рекурсивная
  сортировка ключей) и SHA-256; для create/update ввод заранее нормализуется,
  включая `normalizeTags`, и нормализованные теги передаются в Store;
- повтор с тем же operation ID и тем же вводом возвращает сохранённый
  результат без мутации, события и повторной индексации;
- другой operation ID или другой ввод с тем же ключом возвращает
  `IDEMPOTENCY_CONFLICT`;
- записи с истёкшим TTL (24 часа) не блокируют повторное использование;
- операции без ключа не дедуплицируются.

Запись результата использует document CAS, поэтому конкурентное использование
одного ключа не создаёт две успешные мутации.

## Поиск

`toTaskSearchDocument` превращает задачу в документ с `title` и
`descriptionMarkdown` в тексте, `metadata.projectId` и `metadata.status`.
Activation:

- делает `upsert` после коммита для созданной, изменённой задачи и сдвинутых
  соседей;
- удаляет документы задач при `task.delete` и все документы задач проекта при
  `project.delete` по `deletedResourceRefs` из Store;
- при активации выполняет полную переиндексацию задач через
  `search.reindex`. Она best-effort, идемпотентна и сериализована с мутациями
  той же активацией, поэтому параллельно созданная задача не теряется;
- не индексирует проекты: контракт поиска описывает только задачи.

Ошибка индекса логируется; полная переиндексация при следующей активации
восстанавливает состояние.

## TasksStore и данные

`TasksStore` — асинхронный интерфейс без SQL, имён таблиц, драйвера и
backend-специфичных типов. Домен передаёт готовые ID и UTC-время; версии
проверяются по `expectedVersion`. Тип `TasksIdFactory` описывает генератор ID,
который используется до записи.

### Реализация

```ts
import { bindPluginStorage } from "@kanbaner/kernel";
import { createTasksStore } from "@kanbaner/plugin-tasks";

const storage = bindPluginStorage(provider, "kanbaner.tasks");
const store = createTasksStore({
  storage,
  idFactory,
  now: () => new Date().toISOString(),
});
```

`createTasksStore({ storage, idFactory, now })`:

- использует только публичный `PluginDocumentStore` и коллекции `projects` и
  `tasks` в namespace `kanbaner.tasks`;
- не содержит SQL, `PRAGMA`, имён таблиц, драйвера БД и синхронных вызовов;
- не импортирует kernel, `storage-sqlite` и другие плагины;
- принимает готовые ID и UTC-время из контракта KAN-010; `idFactory` и `now`
  применяются как fallback только при отсутствии значения во входе;
- на каждом чтении и записи вызывает `assertStoredTask`, а проект проверяет по
  `ProjectSchema`; расхождение `data.version` и версии документа — доменная
  ошибка `VALIDATION_ERROR`, а не молчаливое допущение;
- при точных фильтрах использует `indexedFields`
  (`projectId`, `status`, `priority`, `parentTaskId`), остальные фильтры и
  сортировку выполняет в Store;
- возвращает `VERSION_CONFLICT` через `TasksVersionConflictError` с
  `expectedVersion` и `actualVersion`, не перезаписывая документ.

Контракт требует только уникальность и порядок; непрерывность не обязательна.
Текущая реализация Store на практике поддерживает непрерывную `0…N-1` в
области `(projectId, status)`: append получает `max + 1`, явная позиция и move
переставляют соседей в той же транзакции, delete закрывает разрыв. Любой
фактический сдвиг соседа увеличивает его `Task.version` и `updatedAt` и
сохраняется через document CAS с текущей `expectedVersion`; публичная версия и
версия документа всегда синхронны. Соседи меняются атомарно вместе с
операцией; `activate` публикует для них `task.updated`.

Все scoped-методы одной `TasksStoreTransaction`, включая чтения, выполняются
через локальную FIFO-очередь этой транзакции. Составные read-modify-write
операции не перемешиваются, а очередь не является глобальной: разные
транзакции по-прежнему сериализуются провайдером.

### Conformance Suite

`createTasksStoreConformanceSuite({ createStore })` экспортируется из
`@kanbaner/plugin-tasks/testing` и не импортирует backend. Драйвер
`tests/integration/tasks-store-conformance.test.ts` запускает его на четырёх
вариантах: in-memory, delayed in-memory, SQLite и delayed SQLite. Suite
проверяет CAS, rollback rejected Promise, вложенную транзакцию, scoped
`documents`, конкурентные create/complete/move, уникальность позиций,
подзадачи, каскады, `completedAt`, теги, фильтры, пагинацию и UTC/application
IDs.

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
pnpm exec vitest run packages/plugin-sdk/src/errors.test.ts packages/kernel/src/operations/bus.test.ts
pnpm exec vitest run packages/plugin-tasks
pnpm exec vitest run tests/integration/tasks-store-conformance.test.ts
pnpm exec vitest run tests/integration/tasks-activation.test.ts
pnpm check:imports
node scripts/check-import-boundaries.mjs --self-test
```
