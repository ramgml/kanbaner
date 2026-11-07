---
id: KAN-010
title: Доменные контракты задач
status: in_progress
stage: 2
priority: high
owner: worker-kan-010
blocked_by: []
branch: feat/kan-010-tasks-domain-contracts
worktree: .worktrees/kan-010-tasks-domain-contracts
created: 2026-11-07
updated: 2026-11-07
specs:
  - specs/product-mvp.md
  - specs/plugin-contract.md
  - specs/architecture.md
  - specs/technology-stack.md
---

# KAN-010 — Доменные контракты задач

## Цель

Создать `packages/plugin-tasks` как самостоятельный доменный плагин этапа 2 и
зафиксировать его публичный контракт: модель проектов, задач и подзадач, схемы
команд и запросов, контракт `TasksStore`, формат `ResourceRef`, события и
поисковое представление.

Пакет не содержит UI, SQL, импортов ядра и готовой реализации хранения. Он
задаёт границы, на которые опираются KAN-011, KAN-012, KAN-013 и KAN-014.

## Результат

- Пакет `@kanbaner/plugin-tasks` собирается и экспортирует типы, схемы, ID и
  чистые функции валидации.
- Команды и запросы описаны JSON Schema через TypeBox и пригодны для
  регистрации в OperationBus без дополнительного слоя.
- `TasksStore` описывает асинхронный backend-neutral контракт хранения.
- Другие плагины используют только публичные command/query ID и `ResourceRef`,
  не импортируя внутренние модули `plugin-tasks`.

## Объём работ

- [ ] Создать scaffold пакета: `package.json`, `tsconfig.json`, `tsup.config.ts`,
      `plugin.json`, `README.md`, точка входа `src/index.ts`.
- [ ] Зафиксировать константы: `PLUGIN_ID = "kanbaner.tasks"`, коллекции,
      типы ресурсов `project` и `task`, ID команд, запросов и событий.
- [ ] Описать модель:
  - `Project`: `id`, `title`, `descriptionMarkdown`, `version`, `createdAt`,
    `updatedAt`;
  - `Task`: `id`, `projectId`, `parentTaskId`, `title`,
    `descriptionMarkdown`, `status`, `priority`, `dueAt`, `position`, `tags`,
    `version`, `createdAt`, `updatedAt`, `completedAt`.
- [ ] Зафиксировать перечисления: статусы `backlog | todo | in_progress | done`,
      приоритеты `low | medium | high`.
- [ ] Описать TypeBox-схемы и производные TS-типы для операций:
  - `project.create`, `project.update`, `project.delete`;
  - `task.create`, `task.update`, `task.move`, `task.complete`, `task.delete`;
  - `project.list`, `project.get`;
  - `task.get`, `task.list`.
- [ ] Для `task.list` описать фильтры (`projectId`, `status`, `priority`,
      `tag`, `parentTaskId`, `text`, `dueBefore`, `dueAfter`), сортировку
      (`position | createdAt | updatedAt | dueAt | title`), `limit`/`offset` и
      стабильный порядок при равных значениях.
- [ ] Описать `TasksStore` как асинхронный интерфейс без SQL, имён таблиц,
      драйвера и backend-специфичных типов. Все изменяющие методы принимают
      `expectedVersion`, ID и время передаются извне.
- [ ] Реализовать чистые функции валидации домена:
  - один уровень подзадач (`parentTaskId` не может ссылаться на подзадачу);
  - родитель и задача принадлежат одному проекту;
  - `done` выставляет `completedAt`, выход из `done` очищает его;
  - нормализация тегов: trim, нижний регистр, дедупликация, лимит количества
    и длины;
  - допустимые позиции и границы `limit`.
- [ ] Зафиксировать `ResourceRef`:
      `kanbaner.tasks:project:<id>` и `kanbaner.tasks:task:<id>`.
- [ ] Описать события после коммита:
  - `kanbaner.tasks.project.created|updated|deleted`;
  - `kanbaner.tasks.task.created|updated|moved|completed|deleted`.
- [ ] Описать чистое преобразование задачи в `SearchDocumentInput` с
      `metadata.projectId` и `metadata.status`; без записи в индекс.
- [ ] Уточнить `specs/architecture.md` §8.5: доменные данные задач хранятся в
      namespaced document collections плагина; конкретные `tasks_*` имена и
      физическая схема остаются деталью Storage Provider.
- [ ] Добавить тесты схем, валидаторов, тегов, подзадач, `ResourceRef`,
      поискового преобразования и отсутствия импортов ядра.

## Владение файлами

Разрешено:

- `packages/plugin-tasks/**`;
- корневой `package.json` — только добавление `plugin-tasks` в
  `build:packages`;
- `specs/architecture.md` — только уточнение §8.5;
- `pnpm-lock.yaml` — если изменились зависимости.

Запрещено:

- `packages/kernel/**`, `packages/plugin-sdk/**`, `packages/storage-sqlite/**`;
- `apps/web/**`;
- другие плагины и `tests/**`;
- файлы других задач.

Общие файлы:

- Корневой `package.json` и lock-файл меняет только эта задача. Следующие
  задачи добавляют зависимости через собственную координацию.

## Контракты и зависимости

- Использует публичный `@kanbaner/plugin-sdk`: TypeBox, `ResourceRef`,
  `SearchDocumentInput`, `UtcTimestamp`, коды ошибок.
- Новые контракты: `kanbaner.tasks.commands.v1`, `kanbaner.tasks.queries.v1`,
  `kanbaner.tasks.events.v1`, `kanbaner.tasks.store.v1`.
- Зависимостей от других задач нет. KAN-011, KAN-012, KAN-013 и KAN-014
  блокируются этой задачей.

## Критерии приёмки

- [ ] `pnpm build:packages` собирает пакет и `.d.ts`.
- [ ] Схемы принимают валидный ввод и отклоняют неверные статусы, приоритеты,
      пустые заголовки, отрицательные позиции и слишком большие `limit`.
- [ ] Доменные валидаторы запрещают подзадачу второго уровня и задачу с
      родителем из другого проекта.
- [ ] `task.delete` и `project.delete` помечены как `destructive` и требуют
      явного подтверждения в схеме.
- [ ] `TasksStore` не содержит SQL, имён таблиц, драйвера и синхронных методов.
- [ ] Пакет импортирует только `@kanbaner/plugin-sdk` и стандартную библиотеку.
- [ ] README объясняет, как другим плагинам использовать команды, запросы и
      `ResourceRef`.
- [ ] `specs/architecture.md` §8.5 соответствует фактическому решению.

## Проверки

- [ ] Typecheck.
- [ ] Линтер.
- [ ] Focused-тесты `packages/plugin-tasks`.
- [ ] Полный `pnpm check`.
- [ ] Проверка границ импортов.

## Риски

- Контракт зафиксируется до реализации и потребует правок. Смягчение: схемы и
  типы покрыты тестами, а изменение смысла полей требует новой версии
  контракта.
- Хранение поверх document collections хуже подходит для сложных запросов.
  Смягчение: `TasksStore` скрывает реализацию; SQL-специализированный store
  можно добавить позже без изменения команд.
- Теги внутри документа задачи ограничивают серверную фильтрацию. Смягчение:
  фильтр по тегу выполняется в Store и покрыт тестами; отдельная коллекция
  тегов остаётся возможным расширением.

## Журнал

- 2026-11-07 — Задача создана при старте этапа 2. Зафиксировано решение:
  домен хранится через namespaced document collections, потому что публичный
  storage facade плагина не раскрывает SQL и не даёт создавать собственные
  таблицы. `tasks_*` остаются деталью провайдера и могут быть реализованы
  позже без изменения публичных команд.

## Итог

Заполняется оркестратором после интеграции:

- Коммит:
- Ветка:
- Проверки:
- Остаточные риски:
