# Архитектура

- Статус: принято
- Дата: 2026-11-06

## 1. Архитектурный стиль

Kanbaner строится как **модульный монолит с plugin-ядром**.

- Один репозиторий и одна кодовая база.
- Один экземпляр активного Storage Provider на каталог данных.
- Ядро и плагины работают в одном процессе Node.js.
- UI, HTTP API и MCP используют общий реестр команд и запросов.
- Новые функции поставляются плагинами.
- Встроенные плагины не имеют привилегированного доступа к внутренностям ядра.

Плагинная архитектура не означает микросервисы. Отдельный процесс существует только у необязательного MCP-адаптера, потому что MCP-клиент запускает его через stdio.

## 2. Принятые решения

Конкретные технологии, библиотеки и версии зафиксированы в [`technology-stack.md`](technology-stack.md). Ниже описаны архитектурные роли, а не выбор инструментов.

| ID | Решение | Причина |
|---|---|---|
| A-01 | Локальная однопользовательская установка без аккаунтов | Минимальная сложность MVP |
| A-02 | TypeScript, Next.js/React, SQLite WAL | Единый язык, SSR и локальное надёжное хранилище |
| A-03 | Адаптивный веб-клиент | Один клиент для компьютера и мобильного браузера |
| A-04 | Минимальное plugin-ядро | Расширение без изменения ядра |
| A-05 | Встроенные плагины используют тот же SDK | Проверка расширяемости на реальном продукте |
| A-06 | Домен задач отделён от канбана и списка | Новые представления не должны менять домен |
| A-07 | Плагины считаются доверенным кодом | Соответствует локальной модели и Obsidian-подходу |
| A-08 | Ядро не содержит ИИ | Модели и агентный runtime не являются зависимостью ядра; OpenCode — необязательная внешняя интеграция |
| A-09 | Внешние агенты работают через HTTP API и MCP | Агенты не получают доступ к базе |
| A-10 | Каждый плагин владеет своим namespace данных | Изоляция изменений и миграций |
| A-11 | Связи ресурсов являются инфраструктурной возможностью ядра | Плагины не должны знать чужие таблицы |
| A-12 | Полнотекстовый поиск FTS5 без embeddings | Достаточно для MVP и не требует AI-инфраструктуры |
| A-13 | HTTP API построен вокруг команд и запросов | Единая логика для UI, API и MCP |
| A-14 | SQLite WAL как backend MVP | Локальный файл, транзакции, FTS5 и backup без отдельной службы |
| A-15 | Storage Provider Registry и Store-контракты | Смена backend не затрагивает доменные плагины и UI |
| A-16 | `better-sqlite3` для SQLite-провайдера | WAL, FTS5, prepared statements и online backup |
| A-17 | Поддержка Linux и Windows | Локальные данные и кроссплатформенные пути без Docker |
| A-18 | Online backup через SQLite `.backup()` | Консистентная копия без копирования live-файлов |
| A-19 | Универсальный `PluginDocumentStore` для сторонних плагинов | Backend-neutral API без утечки SQL |
| A-20 | OpenCode как отдельный адаптер внешнего Service | Панель и MCP не добавляют модели, provider credentials или доменную логику в ядро |

## 3. Компоненты

```text
┌───────────────────────────────────────────────────┐
│                    UI Shell                       │
│ Навигация · слоты · маршруты · уведомления         │
└─────────────────────────┬─────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────┐
│                   Plugin Kernel                   │
│                                                   │
│ Manifest Registry · Dependency Resolver           │
│ Command Bus · Query Bus · Event Bus                │
│ Resource Registry · Link Service                   │
│ Storage Provider Registry · Migration Runner      │
│ HTTP API · API Token · Plugin Manager · Logging    │
└───────────┬───────────────────────────┬───────────┘
            │                           │
   ┌────────▼────────┐         ┌────────▼─────────┐
   │ Built-in plugins│         │ External plugins │
   └────────┬────────┘         └────────┬─────────┘
            │                           │
            └─────────────┬─────────────┘
                          │
                   ┌───────▼───────────────────┐
                   │ Storage Provider Registry │
                   └───────┬───────────────────┘
                           │
                   ┌───────▼───────────────────┐
                   │ SQLite Storage Provider   │
                   │     better-sqlite3        │
                   └───────┬───────────────────┘
                           │
                   ┌───────▼───────────────────┐
                   │ SQLite WAL + FTS5         │
                   │ local data directory      │
                   └───────────────────────────┘

┌──────────────────┐       HTTP        ┌───────────────┐
│ Внешний агент    │ ────────────────▶ │ Kanbaner API  │
│ через MCP client │                   │               │
└────────┬─────────┘                   └───────────────┘
         │ stdio
┌────────▼─────────┐
│ kanbaner-mcp     │
│ внешний адаптер  │
└──────────────────┘
```

## 4. Ответственность ядра

Ядро предоставляет только инфраструктуру:

- обнаружение и валидацию манифестов;
- разрешение зависимостей и проверку совместимости;
- активацию и деактивацию плагинов;
- реестр UI-вкладов;
- реестр команд и запросов;
- шину событий;
- реестр ресурсов и универсальные связи;
- реестр Storage Provider и механизм регистрации Store-контрактов;
- выполнение миграций плагинов;
- настройки и состояние плагинов;
- HTTP API и проверку токена;
- plugin manager, журналирование и safe mode;
- инфраструктурные таблицы хранилища ядра.

Ядро не содержит:

- моделей задач, проектов и заметок;
- статусов, приоритетов и тегов;
- логики канбана или Markdown;
- поискового индекса;
- доменных Store-контрактов задач и заметок;
- MCP-инструментов;
- понятия проекта или заметки в публичных типах.

## 5. Встроенные плагины

| Plugin ID | Ответственность | Зависимости | Основные контракты |
|---|---|---|---|
| `kanbaner.storage-sqlite` | SQLite WAL Storage Provider | Нет | Storage Provider contract |
| `kanbaner.tasks` | Проекты, задачи, подзадачи, теги | Нет | `kanbaner.tasks.commands.v1`, `kanbaner.tasks.queries.v1`, `kanbaner.tasks.events.v1` |
| `kanbaner.projects` | Рабочее пространство проектов: sidebar, доска, список, переключатель представлений | `kanbaner.tasks` | `kanbaner.projects.ui.v1` |
| `kanbaner.notes` | Заметки и Markdown-редактор | Нет | `kanbaner.notes.commands.v1`, `kanbaner.notes.queries.v1`, `kanbaner.notes.events.v1` |
| `kanbaner.search` | Полнотекстовый поиск и агрегация провайдеров | Нет | `kanbaner.search.queries.v1`, UI-вклад |
| `kanbaner.mcp` | Необязательный stdio-адаптер MCP | HTTP API | Не загружается в ядро |
| `kanbaner.opencode` | Глобальная панель чата, catalog/session gateway, полный built-in toolset внешнего агента и ограниченный MCP | Внешний OpenCode Service и HTTP API | `kanbaner.opencode.ui.v1`; не владеет доменными данными |

`kanbaner.notes` не зависит от `kanbaner.tasks`. Связь заметки с задачей выражается через `ResourceRef`.

`kanbaner.search` не импортирует `tasks` или `notes`. Доменные плагины регистрируют поисковых провайдеров.

## 6. Package layout

Конкретная структура репозитория будет зафиксирована перед реализацией, но архитектурные границы обязательны:

```text
@kanbaner/kernel
@kanbaner/plugin-sdk
@kanbaner/storage-sqlite
@kanbaner/task-ui
@kanbaner/plugin-tasks
@kanbaner/plugin-projects
@kanbaner/plugin-notes
@kanbaner/plugin-search
@kanbaner/mcp
@kanbaner/opencode
@kanbaner/cli
```

Правила импорта:

- `kernel` может зависеть от `plugin-sdk`, но не от плагинов;
- плагины зависят от `plugin-sdk`, но не от `kernel` и не от внутренностей других плагинов;
- связь между плагинами идёт через публичные контракты;
- `task-ui` — общая клиентская библиотека компонентов, а не плагин: она может зависеть от `plugin-sdk` и `@kanbaner/plugin-tasks/contract`, но не от корневого `@kanbaner/plugin-tasks`, `kernel`, storage, серверных модулей или `apps/web`;
- UI-entrypoint плагина импортируется только composition-модулем `apps/web/src/ui/builtin-ui-plugins.ts`; shell и слоты работают с metadata из реестра;
- `cli` является внешним HTTP-клиентом: он может использовать `@kanbaner/plugin-sdk` и client-safe `/contract` entrypoint-ы, но не ядро, Storage Provider или server-активацию плагинов;
- `opencode` зависит только от Plugin SDK и публичного OpenCode client, не импортирует kernel, Storage Provider или доменные плагины; доменные вызовы выполняет отдельный MCP-процесс через `/api/v1`;
- нарушение правил импорта проверяется автоматическим тестом.

## 7. Жизненный цикл плагина

```text
discovered
    ↓
manifest validated
    ↓
dependencies resolved
    ↓
migrations applied
    ↓
server activated
    ↓
client contributions registered
    ↓
active
```

При ошибке:

```text
failed → safe mode → диагностика в plugin manager
```

Правила:

- Storage Provider открывается и проверяется до применения миграций остальных плагинов;
- миграции выполняются до активации;
- плагин с несовместимой версией не активируется;
- циклические зависимости блокируются;
- отключение выполняет деактивацию в обратном порядке;
- отключение не удаляет данные;
- удаление данных возможно только отдельным явным действием;
- ошибка одного плагина не отменяет запуск ядра;
- после падения плагин может быть отключён без ручного редактирования базы.

## 8. Данные

### 8.1. Storage backend

- Основным backend MVP является SQLite в режиме WAL.
- SQLite-провайдер использует `better-sqlite3`.
- Данные хранятся в локальном каталоге данных; внешний сервер БД, Docker и TCP-порт не используются.
- При открытии базы SQLite-провайдер устанавливает:
  - `journal_mode = WAL`;
  - `foreign_keys = ON`;
  - `busy_timeout = 5000`;
  - `synchronous = NORMAL`.
- `synchronous = NORMAL` — осознанный компромисс между производительностью и durability; решение документируется и не меняется скрыто.
- Каталог данных задаётся через `KANBANER_DATA_DIR`.
- По умолчанию используются каталоги ОС:
  - Linux: `~/.local/share/kanbaner/data`;
  - Windows: `%APPDATA%\Kanbaner\data`.
- Пути формируются только средствами Node.js и работают с пробелами и не-ASCII символами.
- При hot reload Next.js используется singleton, чтобы не открыть лишние соединения.
- При завершении приложения провайдер закрывает соединение и выполняет WAL checkpoint.
- Один экземпляр приложения владеет одним каталогом данных; параллельный запуск второго экземпляра не поддерживается.
- База не размещается на сетевой файловой системе.
- Интеграционные тесты используют in-memory SQLite или отдельные временные каталоги.
- Резервное копирование выполняется online через `better-sqlite3` `.backup()`.
- Online backup запускается внутри процесса приложения через активный Storage Provider; отдельный процесс не подключается к работающей базе.
- Восстановление выполняется только при остановленном приложении в новый каталог данных.
- Offline restore допускается отдельным CLI только при остановленном приложении и только через код провайдера.
- Ручное копирование файлов базы, WAL и SHM работающего приложения запрещено.

### 8.2. Storage Provider и Store-контракты

```text
Доменный плагин
      │
      ▼
Store-контракт плагина
      │
      ▼
Storage Provider Registry
      │
      ▼
SQLite Storage Provider (MVP)
```

- Storage backend является плагином-провайдером.
- Провайдер регистрируется при bootstrap приложения, а не импортируется ядром.
- Bootstrap выполняется в application composition root `apps/web`, а не в ядре.
- Порядок bootstrap: регистрация и открытие провайдера, health check, инфраструктурные миграции, затем миграции и активация остальных плагинов.
- Только Storage Provider управляет соединением с backend; доменные и UI-плагины этого не делают.
- Публичные операции Storage Provider и Store-контрактов асинхронны и возвращают `Promise`.
- Синхронный API драйвера не выходит за пределы провайдера.
- Транзакция предоставляется через `withTransaction(async (tx) => ...)`; граница остаётся открытой до завершения callback.
- Транзакция монополизирует соединение: другие операции на нём ждут завершения и не выполняются внутри чужой транзакции.
- Rejected Promise откатывает транзакцию; вложенная транзакция использует savepoint только при наличии capability, иначе возвращает ошибку.
- ID генерируются приложением или доменным плагином до записи; autoincrement и rowid не являются публичным ID.
- Время передаётся в UTC; формат timestamp инкапсулирован Store-контрактом и не зависит от драйвера.
- Каждый провайдер имеет стабильный `backendId`, который входит в журнал миграций.
- В MVP активен ровно один провайдер; реестр допускает несколько зарегистрированных.
- Ядро знает только Store-контракты и реестр провайдеров.
- Доменный плагин объявляет собственный Store-контракт.
- Провайдер реализует контракты и отвечает за открытие хранилища, транзакции, миграции, capabilities, backup/restore и диагностику.
- Доменный код не содержит SQL, `PRAGMA`, `MATCH`, `RETURNING`, имён таблиц и импортов драйвера БД.
- Для сторонних плагинов доступен универсальный `PluginDocumentStore` с операциями `get`, `put`, `delete`, `query`, `list`.
- Документ содержит `pluginId`, `collection`, `id`, `version`, `data`, `indexedFields`, `createdAt`, `updatedAt`.
- Плагин со сложными запросами объявляет собственный Store-контракт и требует его реализации от провайдера.
- Подключение новой СУБД означает новый провайдер с теми же контрактами, а не универсальный SQL.
- Смена backend поддерживается для пустого хранилища. Перенос существующих данных выполняется отдельным backend-neutral export/import и не входит в MVP.
- SQLite data directory не является переносимым форматом данных для другого backend.
- Capabilities провайдера объявляются явно: `transactions`, `savepoints`, `json`, `fullTextSearch`, `stemming`, `onlineBackup`, `wal`, `watch`.
- `transactions` обязательна для любого провайдера MVP-контракта; остальные capabilities опциональны.
- Плагин проверяет capabilities или использует документированный fallback.

### 8.3. Владение

- Каждый плагин владеет своим namespace данных.
- В SQLite namespace выражается префиксом таблиц: `plugin_<normalized_id>_` для сторонних плагинов и короткими префиксами `tasks_`, `notes_` для встроенных. Поисковый индекс использует инфраструктурные таблицы `core_search_*` Storage Provider, а не namespace плагина поиска.
- Плагин создаёт и изменяет только свои таблицы.
- Конкретные имена таблиц и схем являются деталью провайдера и не входят в публичный контракт.
- Ядро отслеживает применённые миграции в `core_plugin_migrations`.
- Состояние и версия плагина хранятся в `core_plugins`.
- Прямые запросы к таблицам другого плагина запрещены контрактом.

### 8.4. Инфраструктурные таблицы ядра

```text
core_plugins
core_plugin_migrations
core_resource_links
```

`core_plugin_migrations` идентифицирует миграцию ключом `(backendId, pluginId, version, checksum)`.
`core_resource_links` хранит универсальные связи:

```text
id
source_ref
target_ref
relation
created_at
```

Уникальность определяется парой ссылок и типом связи. Ядро не интерпретирует предметный смысл ссылок.

### 8.5. Плагин задач

Доменные данные задач хранятся в namespaced document collections плагина:

```text
projects
task-columns
tasks
```

Теги входят в документ задачи. Конкретные имена `tasks_*` и физическая схема
остаются деталью Storage Provider и не входят в публичный контракт.

Логические поля проекта:

```text
id
title
descriptionMarkdown
color?
version
createdAt
updatedAt
```

Логические поля колонки:

```text
id
projectId
title
status
color?
position
version
createdAt
updatedAt
```

`status` колонки — совместимое зеркало legacy-статуса: тип `done` сохраняется
как `done`, открытая колонка — как `in_progress`. Допускается несколько
открытых и несколько Done-колонок с одинаковым `status`; различает их `id` и
`position`.

`color` проекта и колонки — необязательное значение из общей фиксированной
палитры `default|slate|blue|green|yellow|orange|red|purple`. Старые документы
без поля читаются как `default` на уровне представления. Поле хранится внутри
JSON-документа, поэтому его добавление не требует SQLite-миграции.
`project.create|update` и `column.create|update` принимают необязательный
`color`; color-only `column.update` не меняет заголовок, а вход без `title` и
`color` отклоняется. Изменение цвета использует обычные `expectedVersion`,
версионирование и события после коммита.

Логические поля задачи:

```text
id
projectId
parentTaskId
columnId?
title
descriptionMarkdown
status
priority
dueAt
position
tags
version
createdAt
updatedAt
completedAt
```

Правила:

- `status` задачи ограничен четырьмя совместимыми значениями; `columnId`
  необязателен для legacy-документов;
- если `columnId` задан, `status` обязан совпадать со статусом колонки;
  отсутствие `columnId` означает legacy-задачу, которая читается по первой
  колонке проекта с тем же `status`;
- `parentTaskId` допускает только один уровень вложенности;
- `position` задачи уникальна и определяет порядок в области
  `(projectId, columnId)`; `parentTaskId` на область не влияет, непрерывность
  `0…N-1` не требуется; append использует `max(position) + 1`, поэтому
  разреженные позиции не приводят к дублям;
- `task.list` фильтрует по `projectId`, `columnId`, `status`, `priority`, `tag`,
  `parentTaskId`, `text`, `dueBefore`, `dueAfter`; `columnId` вместе с чужим
  `projectId` отвергается как `COLUMN_TARGET_OTHER_PROJECT`;
- `position` колонки уникальна и определяет порядок в области `projectId`;
- теги нормализуются и ограничены по количеству и длине; входные команды
  принимают сырые теги, а сохранённая задача содержит уникальные
  нормализованные теги без внешних пробелов;
- `version` увеличивается при каждом изменении;
- изменения принимают `expectedVersion`, создание принимает `0`;
- при конфликте возвращается `VERSION_CONFLICT`;
- `done` эквивалентно `completedAt !== null`; Store вычисляет поле чистой
  функцией при создании и смене статуса;
- root-методы Store открывают собственную транзакцию, transaction-scoped
  методы используют текущую; вложенная транзакция запрещена и не требует
  savepoints;
- проект и его задачи изменяются в транзакции плагина;
- удаление проекта и задачи требует явного подтверждения; каскад возвращает
  дескрипторы последних сохранённых версий, tombstone-версия не создаётся;
- delete-событие использует `resourceVersion = lastSavedVersion + 1` для корня
  и каждой задачи каскада;
- сортировка и границы UTC сравнивают секунды и дробную часть с выравниванием
  справа нулями, не полагаясь на `Date.parse`.

Колонки:

- `project.create` в одной транзакции создаёт проект и три default-колонки
  `ToDo`, `In Progress`, `Done` с детерминированными ID
  `column-<projectId>-todo|in-progress|done`;
- проект без документов колонок считается legacy: при активации и перед
  мутацией материализуются `Backlog`, `To do`, `In progress`, `Done`;
- backfill выполняется отдельной транзакцией на проект и awaited до завершения
  активации; сам backfill не публикует доменные события, а восстановление
  подписчиков и поиска выполняется полной переиндексацией и чтением list после
  рестарта. Сбой одного проекта логируется как `tasks.column_backfill_failed`
  и не отменяет остальные;
- `column.list` и `task.list{columnId}` — read-only query-пути: они не
  материализуют колонки и не делают read-repair. Если startup backfill проекта
  упал, запрос возвращает фактическое состояние — пустой список или
  `NOT_FOUND` для отсутствующей колонки; починка выполняется повторной
  активацией, явным backfill или мутацией;
- явный legacy `status` в `task.create`/`task.move`, для которого в проекте
  нет колонки, лениво материализует недостающую колонку в той же транзакции:
  Backlog встаёт в позицию 0, остальные — по порядку legacy-статусов; после
  коммита публикуется `column.created`, сдвинутые существующие колонки
  получают `column.updated` с `changed: ["position"]`, а
  `task.columnId`/`status` синхронизируются. Новый проект при этом сохраняет
  три default-колонки;
- технический backfill проставляет `task.columnId` без изменения публичных
  `task.version` и `task.updatedAt`; ревизия документа при этом может вырасти.
  Инвариант `document.version === task.version` ослаблен до
  `document.version >= task.version` **только** для этого backfill: обычные
  команды и Store-мутации обязаны сохранять версии синхронными, а обратное
  расхождение отвергается как `VALIDATION_ERROR`;
- команды `column.create`, `column.update`, `column.move`, `column.delete`
  требуют `expectedVersion` (создание — `0`) и выполняются в транзакции
  плагина; reorder повышает версии и `updatedAt` фактически сдвинутых соседей;
- `column.delete` разрушительная: требует `confirm: true` и `targetColumnId`;
  запрещены удаление последней открытой колонки (`COLUMN_LAST_OPEN`) и
  последней Done-колонки (`COLUMN_LAST_DONE`), target, совпадающий с
  удаляемой, и target другого проекта; инвариант — в проекте всегда остаётся
  хотя бы одна открытая и хотя бы одна Done-колонка, поэтому `task.create` и
  `task.complete` не попадают в невозможное состояние; задачи переносятся в
  target атомарно с обновлением `columnId`, `status`, `position`,
  `completedAt` и версий, append идёт после `max(position) + 1`, а не после
  `count`; результат проверяется на `MAX_POSITION` и при переполнении
  отвергается доменной ошибкой `INVALID_POSITION` без частичной записи;
- `task.complete` переводит задачу в первую Done-колонку проекта; отсутствие
  Done-колонки — доменная ошибка;
- `task.moveMany` атомарно дописывает 1…200 задач одного проекта в конец
  указанной колонки в порядке входного массива: до первой записи проверяются
  уникальность ID, существование, один `projectId`, точные `expectedVersion` и
  target того же проекта. Source и target могут совпадать; повторные
  перемещения используют фактическую версию внутри транзакции, чтобы сдвиг
  соседей этой же операцией не давал ложный `VERSION_CONFLICT`. Соседи и
  перемещённые задачи получают `task.moved`/`task.updated` после коммита,
  поисковый индекс — upsert;
- `task.deleteMany` атомарно удаляет 1…200 задач одного проекта после
  `confirm: true`, включая подзадачи. Parent и child в одном наборе не
  удаляются повторно, а дескрипторы, события и поисковые ссылки
  дедуплицируются; полностью отсутствующий набор — no-op `{ deleted: false }`
  без событий. Сдвинутые соседи получают `task.updated`, удалённые задачи —
  `task.deleted` и очистку поискового индекса после коммита;
- `project.delete` каскадно удаляет задачи и колонки и возвращает дескрипторы
  `deletedColumns` вместе с `deletedTasks`; delete-событие проекта включает
  `deletedColumns` в payload и публикует отдельный `column.deleted` для каждой
  колонки, чтобы подписчики очистили универсальные ссылки;
- activation публикует `column.created|updated|moved|deleted` после коммита,
  `task.moved` для задач, сменивших колонку при `column.delete`, и
  `task.updated` для фактически сдвинутых соседей; доставка best-effort.

### 8.6. Плагин заметок

Домен использует namespaced коллекции существующего `PluginDocumentStore`:

```text
notes
note-activity
note-attachments
idempotency
```

Физические имена таблиц остаются деталью провайдера. Логические поля заметки:

```text
id
title
contentMarkdown
parentId
position
version
createdAt
updatedAt
```

- `parentId = null` задаёт корневую страницу; move/reorder запрещает циклы и
  превышение глубины, а позиции уникальны среди siblings.
- Favorite и `lastOpenedAt` принадлежат `note-activity` и не увеличивают версию
  содержимого. Посещение фиксируется отдельной командой, не query с side effect.
- Вложения до 5 MiB хранятся отдельно в `note-attachments` как base64-документы
  с MIME, размером и владельцем. В canonical Markdown разрешены только
  `attachment://<id>` собственной заметки и HTTP(S) image URL; data URL в
  сохраняемый текст не попадает. Допустимы PNG, JPEG, GIF и WebP с проверкой
  сигнатуры. Inline `image` и `imageReference` через `definition` обрабатываются
  единым AST-механизмом. Экспорт заменяет attachment URL в image/definition на
  data URL. Автоматическая очистка во время редактирования не выполняется;
  неиспользуемое вложение удаляется только явной командой после сохранения.
- CRUD, move и delete используют `expectedVersion` и транзакции плагина. Ветка
  удаляется каскадно после `confirm`; activity и attachments удаляются вместе с
  ней. Повторяемые store-мутации сохраняют результат Idempotency-Key в той же
  транзакции.
- Интерактивный блочный редактор находится в UI-плагине: блоки, side menu с
  добавлением и drag handle, slash-меню, formatting toolbar и вложенность.
  Домен по-прежнему хранит только Markdown, а BlockNote-блоки не сохраняются.
  Перед разбором Markdown image-узлы, которые BlockNote не может держать внутри
  абзаца, списка, цитаты, заголовка или ячейки таблицы, выносятся в отдельные
  image-блоки; canonical Markdown при этом не теряет изображения. Общий
  безопасный renderer выделен в `@kanbaner/markdown-ui`, который не является
  плагином и не содержит доменной логики.

Связи с проектами, задачами и другими ресурсами не хранятся как внешние ключи.
Они создаются через сервис универсальных ссылок ядра. Плагин регистрирует
`note` resource adapter, индексирует заголовок и Markdown после коммита и
выполняет полную переиндексацию при активации.

### 8.7. Поисковый индекс и плагин поиска

```text
core_search_documents
core_search_fts
```

Индекс принадлежит инфраструктуре активного Storage Provider, а не отдельному
namespace плагина. SQLite-провайдер реализует его на FTS5; имена виртуальных
таблиц и SQL не входят в публичный контракт.

- Доменные плагины пишут только scoped-документы своего `ResourceRef` через
  `ctx.search`.
- Storage Provider отвечает за нормализацию, FTS5, фильтры по `metadata` и
  транзакционную замену индекса.
- `kanbaner.search` не хранит индекс и не читает чужие namespace: он агрегирует
  только активных провайдеров через публичный SearchProvider Registry.
- Отключение плагина снимает его провайдера из реестра, но не удаляет индекс;
  повторная активация выполняет idempotent `reindex()` и восстанавливает
  пропущенные документы.

### 8.8. Удаление

- При удалении ресурса плагин публикует событие удаления.
- Ядро удаляет связи, указывающие на удалённый ресурс.
- Плагин поиска удаляет документы из индекса.
- Если подписчик недоступен, поиск восстанавливается полной переиндексацией.
- Каскадное удаление внутри домена выполняет плагин-владелец.

## 9. Связи ресурсов

Формат ссылки:

```text
<plugin-id>:<resource-type>:<opaque-id>
```

Примеры:

```text
kanbaner.tasks:task:01J...
kanbaner.tasks:project:01J...
kanbaner.tasks:task-column:01J...
kanbaner.notes:note:01J...
```

Ядро предоставляет операции:

```text
link(sourceRef, targetRef, relation)
unlink(sourceRef, targetRef, relation)
list(sourceRef, relation?)
resolve(ref)
open(ref)
```

`resolve` возвращает метаданные ресурса. `open` используется UI и выбирает представление через зарегистрированный обработчик.

Плагин-владелец регистрирует тип ресурса и адаптер. Неизвестная ссылка считается неразрешимой, но не ломает приложение.

## 10. Поиск

- Полнотекстовый поиск выполняется через `SearchIndexStore` активного Storage Provider.
- SQLite-провайдер использует FTS5 с токенизатором `unicode61`.
- Русский стемминг уровня PostgreSQL не обещается.
- Нормализация текста выполняется в `SearchNormalizer` провайдера.
- Кириллица, регистр, фразы и prefix-запросы проверяются тестами на Linux и Windows.
- Провайдер объявляет capability `fullTextSearch`; при её отсутствии используется документированный fallback.
- Доменные плагины регистрируют поисковых провайдеров.
- Провайдер возвращает нормализованный документ: ссылку, заголовок, текст, тип и необязательные доменные атрибуты в `metadata`. Ссылка на проект передаётся доменным плагином в `metadata`; ядро и Storage Provider не интерпретируют её и не имеют отдельного поля `projectRef`.
- `kanbaner.search` объединяет результаты и применяет общие фильтры.
- События домена обновляют индекс.
- При пропущенном событии или включении плагина выполняется переиндексация.
- Векторный поиск и AI-provider не используются.

### 10.1. SearchProvider Registry

Публичный `SearchProvider` объявляет:

```text
id            = plugin ID владельца
kinds[]       = { id, title } доступных типов ресурсов
filterFields[] = публичные metadata-поля, которые провайдер умеет фильтровать
listFacets()  = актуальные facet-значения для UI
search(query) = scoped-выдача своего namespace
reindex()     = идемпотентная полная переиндексация своих документов
```

Реестр хранит только доверенные провайдеры активных плагинов. Регистрация под
чужим `id`, пустой `kinds`, дубликаты типов и полей отклоняются до активации.
`unregisterProviders()` вызывается lifecycle при деактивации; отключённый
плагин исчезает из выдачи без удаления своих данных и индекса.

Агрегация `kanbaner.search.query`:

- маршрутизирует `kinds` и `filters` только по объявленным полям; провайдер без
  нужного поля не вызывается;
- отклоняет неизвестный тип, неизвестный фильтр и пустой текст как
  `VALIDATION_ERROR`;
- вызывает провайдеров с `offset: 0` и bounded `limit`, объединяет выдачу,
  дедуплицирует по `ResourceRef` и сортирует по `score` desc, затем `ref` asc;
- возвращает не больше запрошенной страницы и `hasMore`;
- отбрасывает чужой `ResourceRef` и добавляет warning `foreign_ref`;
- при ошибке одного провайдера добавляет warning `provider_failed` и сохраняет
  остальную выдачу; если упали все — возвращает `DEPENDENCY_UNAVAILABLE`;
- при отсутствии активных провайдеров возвращает пустую страницу без ошибки.

`kanbaner.search.filters` объединяет `kinds` и facet-ы активных провайдеров,
дедуплицирует значения и не раскрывает произвольные metadata. UI получает
типы и фильтры динамически и не хардкодит домены. Переход к найденному ресурсу
выполняется доменным `resource-opener` по `ResourceRef`; сам search-плагин
opener не объявляет.

Межплагинная reindex-команда с частичным успехом не вводится. Каждый домен
переиндексирует свои документы при активации и после явной локальной команды,
если она предусмотрена доменом; registry не выполняет чужие мутации.

### 10.2. Экспорт поиска

- `kanbaner.search.query` — `ui: true`, `http: true`, `mcp: true` для будущего
  универсального discovery-driven MCP.
- `kanbaner.search.filters` — `ui: true`, `http: true`, `mcp: false`.
- Ручной OpenCode allowlist не расширяется: `exposure.mcp` не строит его и не
  добавляет операций в `@kanbaner/opencode`.
- Bearer token, лимиты и валидация выполняются общим HTTP transport; отдельного
  поискового маршрута нет.


## 11. HTTP API

API является транспортом над реестром команд и запросов.

### Маршруты ядра

```text
GET  /api/v1/health
GET  /api/v1/discovery
POST /api/v1/commands/{commandId}
POST /api/v1/queries/{queryId}
GET  /api/v1/resources/{encodedResourceRef}
```

### Правила

- Все ответы используют единый конверт из Plugin Contract.
- `Authorization: Bearer <token>` обязателен для всего, кроме `/health`.
- `X-Request-Id` принимается от клиента или генерируется ядром.
- `Idempotency-Key` передаётся для поддерживающих его команд.
- Тело запроса валидируется по JSON Schema.
- Ошибки валидации возвращаются до вызова плагина.
- RESTful CRUD-маршруты не входят в ядро.
- Если понадобится удобный REST-фасад, он может быть отдельным плагином.

### Токен

- Хранится в `KANBANER_API_TOKEN`.
- Сравнивается без утечки времени.
- Не передаётся в клиентский JavaScript.
- При отсутствии токена API отвечает `503`, кроме health.
- По умолчанию сервер слушает `127.0.0.1`.

Интерфейс и API работают в одном origin. Отдельная система пользовательских сессий не вводится.

### CLI

`@kanbaner/cli` — внешний процесс для агентов и скриптов поверх этого HTTP transport. Он предоставляет универсальные command/query/resource/discovery-вызовы и доменные сокращения, которые только формируют payload существующих операций. CLI не подключается к базе и не содержит доменной логики.

Все результаты сериализуются как единый `OperationResult` JSON. URL задаётся через `KANBANER_API_URL` или `--url`, Bearer token — через `KANBANER_API_TOKEN`; токен не выводится и не принимается аргументом командной строки. Разрушительные доменные команды неинтерактивны и требуют явного `--confirm` либо `confirm: true` в универсальном input.

### OpenCode UI transport

`@kanbaner/opencode` не регистрирует маршруты плагина. Composition root предоставляет отдельный внутренний transport для browser panel:

```text
GET  /api/opencode/status
GET  /api/opencode/catalog
POST /api/opencode/session
GET  /api/opencode/session
GET  /api/opencode/session/{sessionID}[?turnID={turnID}]
PATCH /api/opencode/session/{sessionID}
GET  /api/opencode/session/{sessionID}/messages/{messageID}/attachments/{attachmentIndex}
POST /api/opencode/session/{sessionID}/model
POST /api/opencode/session/{sessionID}/prompt
```

Это не машинный command/query API и не замена `/api/v1`. Bearer token не передаётся в браузер; запросы принимаются только с `x-kanbaner-client: ui` и same-origin Fetch Metadata/Origin проверками. Все ответы имеют `Cache-Control: no-store`; prompt использует NDJSON. Публичные ошибки не содержат сырые upstream messages, response body, headers и provider settings.

`GET /api/opencode/session` не принимает query-параметры. Gateway читает не больше 4 страниц `session.list` по `limit: 50`, останавливается по `next` или повторному cursor, дедуплицирует ID, сортирует по `time.updated` desc с tie-break по ID и ограничивает ответ 30 записями. Наружу отдаётся только whitelist `{ id, title, updatedAt }`; `metadata`, `location`, `projectID`, стоимость, токены, permissions, model, agent, outcome, `archived` и `subpath` не сериализуются. В список попадают только root-сессии (`parentID: null`) с `metadata.source=kanbaner`, агентом `kanbaner`, валидным `time.updated` и тем же нормализованным project directory. `PATCH /api/opencode/session/{sessionID}` принимает строгий JSON `{title}` до 4 KiB, проверяет ownership и отправляет upstream только `{ sessionID, title }`; заголовок нормализуется до 1–100 code points, NUL/C0/C1 запрещены.

Первый prompt новой сессии получает автоматический короткий title из отображаемого текста запроса. UI передаёт в `POST /api/opencode/session/{sessionID}/prompt` optional bounded `titleText` (display text без контекстной преамбулы и вложений, до 2000 code points); `session-title.ts` детерминированно очищает Markdown/HTML, схлопывает пробелы и ограничивает результат 60 code points без вызова модели. До `prompt` gateway best-effort вызывает `ensureSessionTitle`: проверяет ownership, root-сессию, агент/`metadata.source`, текущий project directory, точный default title и пустую canonical history через `message.list({sessionID, limit: 1})`, затем отправляет `session.update({sessionID, title})` только с `title`. Общий caller-visible deadline 2 s и caller abort стартуют до постановки в per-session очередь и покрывают queue wait + get/list/update; собственный `AbortController` связывает caller signal, timeout/abort возвращает `null`, не отменяет prompt и не меняет его outcome, а отменённый queued entry позже доходит до очереди как no-op без SDK-вызовов. После каждого `await` и перед update проверяется abort, поэтому истёкший preflight не начинает поздний update. Preflight одной сессии сериализуется в gateway, второй вызов перечитывает canonical title/history после первого, а разные session ID выполняются параллельно. После запуска `session.update` per-session uncertain/in-flight guard удерживается до фактического settle upstream Promise независимо от deadline/abort: новый auto update во время uncertainty не отправляется, состояние очищается при success/error, после чего eligibility проверяется заново. Уже отправленная mutation отменяется только если это поддерживает SDK/Service; поздняя запись остаётся документированным пределом. Подтверждённый title возвращается ASCII-header `x-kanbaner-session-title`; панель применяет его к текущей generation и инвалидирует историю. Первый canonical GET после header получает grace как potentially stale относительно server-side update: применяет canonical messages, сохраняет auto title и гасит overlay, следующий GET доверяет canonical. Conditional rename в SDK отсутствует: гонка с ручным переименованием из другой вкладки остаётся last-write-wins.

Gateway вызывает `Service.ensure()` только при обращении к открытой панели. Catalog, session create и остальные операции используют один project location. Доступны только root-сессии с `metadata.source=kanbaner`, агентом `kanbaner` и тем же project directory. Event subscription должна подтвердить `server.connected` до prompt; после admission terminal execution подтверждается по canonical history точного turn, а не по типу upstream-события. Каждый prompt получает client-generated stable turn ID (`^msg_[A-Za-z0-9_-]{8,64}$`), передаваемый в `session.prompt({id})`; при подмене ID Service gateway выпускает служебное `kanbaner.turn.admitted` и хранит alias client→admitted. Перед canonical lookup gateway выпускает внутреннее событие `session.execution.finalizing`, которое NDJSON transport передаёт клиенту как `finalizing` без terminal-семантики. Abort вызывает `session.interrupt` и закрывает subscriber-local iterator.

Если canonical outcome не подтверждён за ограниченное время, NDJSON завершается ошибкой с `reason: "unconfirmed"` без upstream-текста. Rejected `fetch`, null body, EOF без `finalizing` и неизвестный сбой после возможного admission также дают unconfirmed с `retryable:false`; terminal error после `finalizing` не дублируется. Rejected `client.session.prompt()` не считается доказательством non-admission: `promptAttempted` ставится непосредственно перед вызовом, после ошибки gateway выполняет bounded canonical lookup по stable turn ID и выдаёт terminal только при exact canonical outcome, иначе unconfirmed, без retry/interrupt. Панель в этом состоянии сохраняет streamed-сообщения, не запускает автоматический canonical refresh и не повторяет prompt; ручная кнопка «Проверить статус» выполняет `GET /api/opencode/session/{sessionID}?turnID={turnID}` и получает серверный `outcome` (`done`, `error`, `cancelled`, `pending`, `missing`), вычисленный по точному turn ID. Status query принимает исходный client ID через alias-map и прямой admitted `SessionMessageID` (bounded validator без `msg_`). UI применяет canonical history только при `done`. Автоматический повтор допускается только при сбое до вызова prompt (`OpenCodeGatewayError` до первого streamed-события, 408/429/5xx); ответ помечается `nonAdmission:true` и `retryable:true`; текст и файлы берутся из снимка исходного запроса. 4xx и post-admission ошибки не повторяются.

Catalog также возвращает единый список инструментов с публичными `name`, `source` (`builtin` или `mcp`), `risk` (`read` или `write`) и `requiresExpectedVersion` для MCP. Панель показывает built-in tools OpenCode и ручной Kanbaner MCP отдельными группами и предупреждает о полном доступе к интернету, файлам и shell. Источник MCP-части — код интеграции, а не `exposure.mcp`, поэтому список не расширяется автоматически при появлении новых доменных операций.

Tool call в истории и stream публикуется как `{ name, status, text, startedAt?, endedAt?, input?, output? }`, где `startedAt`/`endedAt` — epoch milliseconds. History использует canonical `time.ran`/`time.completed` (с fallback на `time.created` и v1 `state.time`), а stream — top-level `event.created` как приблизительное время до следующего canonical reload. Identity history: v2 использует `id`/`name`, а v1 `ToolPart` — `callID` для tool call identity (приоритетнее PartID `id`) и `tool` для имени; text parts сохраняют PartID. v1 string `state.error` и `state.output` нормализуются без раскрытия upstream-текста. `input` и `output` разделены и ограничены по размеру; `state.metadata`, `part.native` и upstream `error.message`/body не передаются. UI объединяет события по `assistantMessageID + tool call ID`, сохраняя ранний `startedAt`, первый `endedAt` и непустые input/output, и не понижает terminal status поздним running. Stream event без ID получает per-turn монотонный anonymous ID вместо `Date.now()`; события до terminal коррелируются в один вызов, а идентифицированный `event.id` не смешивается с anonymous. Summary tool call свёрнут по умолчанию и раскрывается pointer/touch, Enter или Space; running duration тикает раз в секунду, terminal фиксирует значение, а отсутствующие, невалидные и обратные timestamps не дают фиктивную длительность. Таймер помечен `role="timer" aria-live="off"`, чтобы ticking не анонсировался screen reader-ом. `cancelled` — UI-only terminal для Stop, подтверждённой отмены, canonical и streaming `error.type=aborted`; обычная tool error остаётся `error`. Confirmed `done`/`cancelled`/`error` завершает только running tools текущего prompt по набору identity из `appendTool` этого generation; explicit `nonAdmission` завершение не запускает, ручная проверка статуса использует тот же scope, а unconfirmed tool предыдущего хода остаётся running.

Лента чата использует один реальный scroll container и внутренний content wrapper без виртуализации и IntersectionObserver. Follow включается только при расстоянии до нижней границы не больше 48 px, вычисленном по `scrollTop`/`scrollHeight`/`clientHeight`; при чтении выше streaming deltas, tool upsert и canonical refresh той же сессии не меняют `scrollTop`, а новые или изменённые по identity сообщения отражаются в badge (чистое удаление истории его не увеличивает). Собственный `role:"user"` — optimistic prompt и canonical `user:<turnID>` — badge не увеличивает: identity одного сообщения меняется при canonical refresh; assistant/tool/system считаются по общему правилу. Перед любой автоматической записью `scrollTop` текущий offset сверяется с сохранённой предыдущей нижней границей: молчаливый уход выше без доставленного scroll event выключает follow и показывает возврат вместо записи. Если после messages changes или resize геометрия сама привела контент к низу, follow и unread пересчитываются и восстанавливаются без scroll event. Возврат выполняет native button вне scroll content: pointer/touch, Enter/Space, `focus-visible` и перенос фокуса на контейнер с `preventScroll` при размонтировании кнопки. Prompt и retry явно включают follow; смена `session.id` сбрасывает unread и открывает конец, а canonical refresh той же сессии follow не сбрасывает. `ResizeObserver` на container/content, window resize fallback и capture `load`/`error` удерживают низ только в режиме follow; без `ResizeObserver` дополнительно работают capture `toggle` и window `pointerup`/`keyup`. Native scroll anchoring не отключается: при изменении высоты выше viewport контракт требует стабильности видимого фрагмента, а не неизменного числового `scrollTop`, поэтому браузер компенсирует reflow, а hook не делает собственный jump; для deltas без reflow выше viewport `scrollTop` остаётся прежним. Generation/abort не участвуют в scroll-логике, позиция между перезагрузками не сохраняется.

По явному решению пользователя от 2026-11-20 агенту `kanbaner` разрешены стандартные built-in tools: `question`, `websearch`, `webfetch`, `read`, `glob`, `grep`, `edit`, `shell`, `subagent`, `skill` и `external_directory`. Это не песочница: `read`/`edit`/`shell` имеют доступ к локальным файлам и секретам, а `websearch`/`webfetch`/`shell` — к сети. Сторонние MCP servers, Code Mode `execute` и wildcard allow для чужих tools остаются запрещены.

Копирование кода и черновики composer относятся к browser UI и не создают server storage. `@kanbaner/markdown-ui` принимает additive optional `codeBlockAction`; без prop разметка не меняется, с prop action получает точный plain text fenced/indented блока из HAST (без одного renderer-added trailing newline), а inline code и пустые блоки action не получают. Состояние кнопки (`Копировать код`, `Код скопирован`, `Не удалось скопировать код`) передаётся через native button `aria-label`/`title` с reset через 2 секунды и без второго live-region. Копирование сначала использует `navigator.clipboard.writeText`, затем legacy `execCommand` fallback с восстановлением `activeElement`/Selection; layout и scroll hook не затрагиваются.

Черновики composer хранятся только в `localStorage["kanbaner.opencode.drafts.v1"]` как `{ v: 1, drafts: { [sessionID]: { text, updatedAt } } }` и не попадают на сервер, в SQLite или gateway. Лимиты: 16 384 символа на запись, 20 записей, 65 536 суммарно; переполнение удаляет самые старые по `updatedAt` записи (tie-break по session ID), сверхлимитный текст остаётся только в памяти. Невалидный JSON/version/shape и storage errors игнорируются; заблокированный `localStorage` не ломает initialize/composer и не превращается в Service error. Черновики изолированы по session ID, переживают reload, новая сессия не получает чужой текст; отправка очищает только черновик своей сессии после optimistic append, retry — только если composer не изменён. Вложения, base64, история, turn/model и ошибки в storage не сохраняются.

История сессий в панели загружается лениво при раскрытии `<details>` и кэшируется на 30 секунд; создание сессии, завершённый prompt, rename и ручной terminal outcome (`done`/`error`/`cancelled`) из «Проверить статус», включая EOF-unconfirmed, инвалидируют кэш. Выбор записи идёт через guarded GET точной сессии: `404` удаляет только недоступную запись и не меняет текущую сессию/сохранённый ID, `503` показывает retry, а busy-операции блокируют записи. Reload-`404` сохранённого ID очищает только ID и показывает CTA «Новая сессия» без автоматического POST; временный `503` сохраняет ID и текущую сессию. Переименование выполняется в шапке через strict PATCH; Enter сохраняет, Escape закрывает форму и возвращает фокус, не всплывая до закрытия панели. Model switch и `newChat` используют отдельные request token и не делят generation с prompt: успешный и failed model switch сохраняют unconfirmed turn, ручную проверку и canonical refresh, failed switch оставляет прежнюю модель. Успешный switch фиксирует model overlay до маркера уже стартовавших canonical GET: pre-switch refresh применяет messages, но сохраняет новую модель и гасит overlay, а GET после switch принимает canonical model как более новую; overlay очищается при смене generation/сессии. `newChat` применяет созданную сессию и начинает новую generation только после успешного POST, а ошибка сохраняет черновик, вложения, attached context, rename и unconfirmed turn; успех очищает вложения и контекст. Stale ответы обеих операций отсекаются по token/generation, а create с отменённым token не применяется.

### Вложения OpenCode prompt

- Browser file picker принимает UTF-8 text/code, PNG/JPEG/GIF/WebP и PDF. Лимиты: до 5 файлов, 8 MiB суммарно, 1 MiB на текст и 5 MiB на каждый image/PDF.
- Клиент валидирует выбор до чтения, санитизирует имя до basename не длиннее 200 символов и читает файл через `FileReader` в base64. В `POST /api/opencode/session/{sessionID}/prompt` уходит `files: [{ name, mime, base64 }]`; отдельного upload endpoint нет.
- Сервер ограничивает тело запроса 12 MB, проверяет канонический Base64, фактический размер, UTF-8 через fatal `TextDecoder`, сигнатуры PNG/JPEG/GIF/WebP и `%PDF-`, затем передаёт файл в `session.prompt` как inline `data:<mime>;base64,...` с `source: { type: "inline" }`. `file:` URL и чтение произвольных server paths не поддерживаются.
- Вложения относятся к текущему prompt и выбранной модели. Если модель не объявляет поддержку image/PDF-входа, панель только предупреждает и не блокирует отправку prompt; OpenCode/provider может заменить несовместимое вложение служебной заметкой или отклонить его. UI не фильтрует вложение по возможностям модели.
- Публичное представление истории содержит только `name` и `mime`; base64 не возвращается в browser history, не логируется и не попадает в публичные ошибки. Валидация использует существующие `Buffer`, `TextDecoder` и browser `FileReader`, без новых runtime-зависимостей.
- Image previews отображаются в composer и user messages. Для canonical сообщения `GET /api/opencode/session/{sessionID}/messages/{messageID}/attachments/{attachmentIndex}` проверяет session ownership и exact message/index, читает только canonical inline `file.data`/`file.mime` с `source.type === "inline"`, повторно проверяет Base64, лимит и сигнатуру и возвращает binary image с `no-store`/`nosniff`. Browser запрашивает endpoint с общим UI guard и создаёт blob URL; text/PDF и `media:`/`file:`/HTTP sources не выдаются. При отсутствии валидного inline-источника UI показывает обычную карточку вложения.

## 12. MCP

`kanbaner-mcp` — необязательный внешний процесс.

```text
MCP client
    │ stdio
kanbaner-mcp
    │ HTTP + Bearer token
Kanbaner API
```

Правила:

- адаптер не подключается к базе данных;
- адаптер не содержит логики задач и заметок;
- инструменты строятся по метаданным команд с `exposure.mcp = true`;
- вход и выход валидируются по схемам;
- названия инструментов детерминированно преобразуются из command ID с проверкой коллизий;
- разрушительные команды экспортируются только при явном разрешении и помечаются как опасные;
- при недоступном API MCP возвращает структурированную ошибку;
- MCP не влияет на запуск и работу веб-интерфейса.

Текущий executable `kanbaner-mcp` входит в `@kanbaner/opencode` и предоставляет явно перечисленный ограниченный набор: `project_list/get/create/update`, `task_list/get/create/update/complete/move`, `note_list/get/create/update`. Он не является ещё универсальным discovery-driven адаптером `@kanbaner/mcp` из этапа 7. Delete MCP tools отсутствуют. Все операции идут через Bearer-защищённый `/api/v1`; update содержит `expectedVersion`, mutation — ключ идемпотентности из `operationId`, input, идентичности MCP request/session и UUID экземпляра MCP server. Ограниченность этого MCP не ограничивает отдельно разрешённые built-in tools OpenCode: `shell` и `edit` могут изменять локальные файлы, но не получают доступа к базе Kanbaner иначе как через HTTP API.

## 13. Модель доверия и безопасность

Текущая модель — **доверенные локальные плагины**.

- Плагинный JavaScript выполняется в процессе приложения.
- `permissions` в манифесте описывают намерения и используются для диагностики и UI.
- Декларативные разрешения не образуют песочницу.
- Установка разрешена только из локального каталога.
- Автоматическая загрузка кода из сети отсутствует.
- API-токен и переменные окружения должны быть доступны только доверенному коду.
- Полный доступ chat-агента OpenCode (`read`, `edit`, `shell`, `external_directory`, сеть) является осознанным решением пользователя и не образует sandbox: агент действует с правами пользователя и может читать секреты и изменять локальные файлы.

Если в будущем понадобятся недоверенные плагины, потребуется отдельный этап:

- изоляция server-кода в worker или дочернем процессе;
- RPC-транспорт для логических сообщений контракта;
- iframe или отдельный renderer для UI;
- изоляция доступа к каталогу данных;
- контроль ресурсов и таймаутов.

Логическая модель команд, запросов, событий и ссылок уже пригодна для такого перехода, но текущий UI-контракт является внутрипроцессным и не считается песочницей.

## 14. Надёжность и наблюдаемость

- Каждая мутация выполняется в транзакции плагина.
- Транзакции выполняются через активный Storage Provider; savepoints используются только при наличии capability.
- Транзакция монополизирует соединение; операция вне транзакции ждёт и не присоединяется к чужой транзакции.
- Отклонённый Promise внутри транзакции приводит к rollback.
- Write-транзакции SQLite короткие; транзакция не удерживается во время вызова другого плагина.
- `SQLITE_BUSY` не обходится бесконечным retry; повторяются только безопасные для повтора операции.
- Межплагинные транзакции не поддерживаются; согласованность достигается командами и компенсацией.
- События публикуются только после коммита.
- Ошибки плагинов журналируются с `requestId`, `traceId` и plugin ID.
- Секреты и содержимое заметок не попадают в диагностические сообщения.
- Safe mode отключает проблемные плагины, сохраняя данные.
- Миграции не выполняются повторно.
- Перед разрушительной миграцией рекомендуется резервная копия.

## 15. Нефункциональные требования

- Интерфейс адаптивен начиная с ширины 360 px.
- Основные сценарии доступны без drag-and-drop.
- Все интерактивные элементы доступны с клавиатуры.
- Приложение работает на Linux и Windows без Docker и внешней СУБД.
- Нативный модуль `better-sqlite3` устанавливается и загружается на обеих ОС.
- FTS5 доступен в стандартной сборке SQLite.
- Данные сохраняются после перезапуска.
- Даты хранятся в UTC и отображаются в локальной зоне.
- Списки поддерживают пагинацию или виртуальный скролл.
- API возвращает структурированные ошибки.
- Доменные команды валидируют вход до записи.
- Плагин не может зарегистрировать команду с занятым ID.
- Конфликт версий не приводит к перезаписи чужих изменений.

## 16. Отложенные технические решения

Эти детали не меняют архитектурные границы и выбираются при реализации:

- формат упаковки плагинов;
- конкретный способ хранения позиции карточек;
- расписание и формат пользовательского экспорта;
- локализация интерфейса;
- будущая песочница плагинов;
- backend-neutral экспорт и импорт данных при смене Storage Provider;
- дополнительные Storage Provider (PostgreSQL, MySQL, document store).
