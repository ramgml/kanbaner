---
id: KAN-013
title: Список задач
status: done
stage: 2
priority: high
owner: worker-kan-013
blocked_by: []
branch: feat/kan-013-task-list
worktree: .worktrees/kan-013-task-list
created: 2026-11-07
updated: 2026-11-07
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/technology-stack.md
---

# KAN-013 — Список задач

## Цель

Создать первый UI-плагин представления `kanbaner.task-list`: адаптивный список
задач с фильтрами, сортировкой, пагинацией, формами создания и редактирования,
боковой панелью деталей и клавиатурной доступностью.

Плагин работает только через публичные команды и запросы `kanbaner.tasks` и не
содержит доменной логики. Отключение списка не влияет на данные задач.

## Результат

- На `/view/tasks` открывается список задач: таблица на десктопе, карточки на
  мобильных от 360 px.
- Фильтры по проекту, статусу, приоритету, тегу и сроку, сортировка и
  пагинация сохраняются в URL.
- Детали задачи открываются в `app.details`; на узких экранах — на весь экран.
- Создание, изменение, перемещение, завершение и удаление идут через общие
  операции; конфликт версий показывается без перезаписи.
- Основные действия доступны с клавиатуры и не требуют drag-and-drop.

## Объём работ

### Общий UI-рантайм

- [x] Расширить публичные props UI-вклада: передавать `invoke(operationId,
      input)` из shell. Плагин не импортирует server actions и не обращается к
      базе.
- [x] Описать React-free тип `UiOperationInvoker` и props представления в
      `packages/task-ui`; `apps/web` передаёт структурно совместимую
      реализацию. UI-плагины не импортируют `apps/web/src/ui/**`, server
      actions и типы shell.
- [x] Добавить в клиентский реестр способ привязать реальный React-рендерер к
      уже полученным с сервера метаданным без дублирования вклада. Привязка
      идемпотентна, заменяет прежний рендерер и очищается при регистрации
      нового набора.
- [x] Серверные метаданные остаются источником доступности: если плагин
      отключён, его вклад не рендерится, даже если код есть в бандле.
      Исчезновение метаданных удаляет и рендерер.
- [x] Добавить `apps/web/src/ui/builtin-ui-plugins.ts` — composition-модуль,
      который импортирует UI-entrypoint встроенных плагинов. Shell и слоты не
      импортируют доменные плагины напрямую.
- [x] Обновить `scripts/check-import-boundaries.mjs`: разрешить импорт
      UI-entrypoint только из `builtin-ui-plugins.ts`, запретить импорт
      внутренних модулей плагина и серверного кода.

### Общие компоненты задач

- [x] Создать `packages/task-ui` — библиотеку представления без собственного
      plugin ID: `TaskCard`, `TaskTable`, `TaskDetails`, `TaskForm`,
      `TaskFilters`, состояния загрузки/пустоты/ошибки, React-free тип
      `UiOperationInvoker`.
- [x] Зафиксировать `packages/task-ui` в `specs/architecture.md` как общую
      библиотеку представления задач, не являющуюся плагином.
- [x] Использовать только React, Tailwind-классы и семантические элементы.
      Не подключать вторую component library и не импортировать
      `apps/web/src/components/ui/**`.
- [x] Типы операций, ID и схемы брать только из
      `@kanbaner/plugin-tasks/contract`; корневой серверный entrypoint и
      внутренние модули пакета не импортировать.
- [x] Обеспечить клавиатурную навигацию, видимый фокус, `aria-*` для фильтров,
      таблицы, диалогов и сообщений об ошибках.

### Плагин списка

- [x] Создать `packages/plugin-task-list`: manifest, `server` entrypoint без
      доменной логики, `ui` entrypoint.
- [x] Manifest: `requires: { "kanbaner.tasks": "^1.0.0" }`, permissions
      `commands`, `events`, `ui`, `provides: ["kanbaner.task-list.ui.v1"]`,
      `consumes: ["kanbaner.tasks.commands.v1", "kanbaner.tasks.queries.v1"]`.
- [x] Зарегистрировать вклад `kind: "view"`, `slot: "app.main"`,
      `route: "/view/tasks"`.
- [x] Зарегистрировать навигационный вклад в `app.sidebar`.
- [x] Зарегистрировать панель деталей в `app.details`; на мобильных открывать
      полноэкранную панель.
- [x] Реализовать список:
  - десктоп: колонки «Название», «Проект», «Статус», «Приоритет», «Срок»,
    «Теги»;
  - мобильный: карточки с заголовком, статусом, приоритетом, сроком и тегами;
  - сортировка по позиции, сроку, дате изменения и заголовку;
  - пагинация по `limit`/`offset` с сохранением в query string.
- [x] Реализовать фильтры: проект, статус, приоритет, тег, срок; кнопка сброса.
- [x] Реализовать формы:
  - создание проекта и задачи;
  - редактирование заголовка, описания Markdown, приоритета, срока и тегов;
  - выбор родительской задачи только среди корневых задач проекта;
  - удаление с явным подтверждением.
- [x] Обрабатывать `VERSION_CONFLICT`: показать сообщение, перезагрузить
      задачу, не отправлять повторно устаревшую версию.
- [x] Не кэшировать данные в обход запросов: после команды обновлять список и
      детали повторным запросом.

### Проверки

- [x] Component-тесты `packages/task-ui` и `packages/plugin-task-list` на
      Vitest и Testing Library.
- [x] Integration-тест регистрации UI-вкладов и маршрута `/view/tasks`.
- [x] E2E на production custom server с изолированной БД:
  - создать проект и задачу;
  - увидеть задачу в списке;
  - отфильтровать и отсортировать;
  - открыть детали, изменить и сохранить;
  - получить конфликт версий и убедиться, что данные не потеряны;
  - удалить задачу с подтверждением;
  - проверить мобильную раскладку 360 px и клавиатурную навигацию.
- [x] Проверить, что при отключённом `kanbaner.task-list` данные задач
      остаются доступны через API, а shell не падает.

## Владение файлами

Разрешено:

- `packages/plugin-task-list/**`;
- `packages/task-ui/**`;
- `apps/web/src/ui/**`;
- `apps/web/src/components/shell/ui-slot.tsx`;
- `apps/web/src/components/shell/plugin-view.tsx`;
- `apps/web/src/components/shell/contribution-boundary.tsx`;
- `apps/web/src/app/layout.tsx`;
- `apps/web/src/app/globals.css` — только `@source` для классов встроенных
  UI-пакетов;
- `packages/kernel/src/operations/errors.ts` и
  `packages/kernel/src/operations/bus.test.ts` — только структурное
  распознавание `PluginOperationError` между экземплярами SDK;
- `apps/web/e2e/task-list.spec.ts`, `apps/web/e2e/test-environment.ts`;
- `apps/web/package.json`, корневой `package.json` (`build:packages`),
  `pnpm-lock.yaml`;
- `specs/architecture.md` — только фиксация `packages/task-ui` в package
  layout;
- `scripts/check-import-boundaries.mjs` — только правило для UI-entrypoint;
- `packages/plugin-task-list/README.md`.

Запрещено:

- `packages/kernel/**`, `packages/plugin-sdk/**`, `packages/storage-sqlite/**`,
  кроме явно разрешённого структурного error mapping выше;
- `packages/plugin-tasks/src/**` — только публичный импорт контракта;
- `packages/plugin-kanban/**`;
- `specs/**`, кроме точечной фиксации `packages/task-ui` в
  `specs/architecture.md`;
- `tests/contract/**`, файлы других задач.

Общие файлы:

- `apps/web/src/ui/builtin-ui-plugins.ts` создаёт эта задача; KAN-014
  добавляет в него регистрацию канбана по согласованию.
- `packages/task-ui` принадлежит этой задаче; KAN-014 использует его без
  изменения API. Если API не хватает, KAN-014 согласует правку.

## Контракты и зависимости

- Зависит от `kanbaner.tasks` (KAN-012): команды, запросы, `ResourceRef`.
- Новые контракты: UI-вклад `kanbaner.task-list.ui.v1`, маршрут `/view/tasks`.
- Расширяет runtime UI-вклада полем `invoke`; изменение совместимое, старые
  рендереры продолжают работать.
- Блокирует KAN-014.

## Критерии приёмки

- [x] `/view/tasks` работает на десктопе и на ширине 360 px.
- [x] Список, фильтры, сортировка и пагинация используют только публичные
      запросы `kanbaner.tasks`.
- [x] Создание и редактирование используют только публичные команды.
- [x] Конфликт версий не перезаписывает чужие изменения.
- [x] Детали открываются в `app.details`, на мобильных — на весь экран.
- [x] Основные действия доступны с клавиатуры.
- [x] Drag-and-drop не используется как единственный способ действия.
- [x] Shell не импортирует доменные плагины; импорт есть только в
      composition-модуле UI.
- [x] UI-плагины используют только `@kanbaner/plugin-tasks/contract`, не
      корневой серверный entrypoint.
- [x] Привязка рендерера идемпотентна: повторная регистрация не создаёт
      дубликат, а исчезновение серверных метаданных убирает вклад.
- [x] Отключение списка не влияет на данные и API задач.
- [x] Нет второй component library и импортов внутренностей `apps/web` из
      плагинов.

## Проверки

- [x] Typecheck.
- [x] Линтер.
- [x] Component- и integration-тесты.
- [x] `pnpm check:imports`.
- [x] Полный `pnpm check`.
- [x] Playwright E2E на production build.
- [x] Проверка мобильной раскладки и клавиатуры.

## Риски

- Статический импорт UI-плагина в бандл выглядит как обход plugin-механизма.
  Смягчение: доступность определяется серверными метаданными; отключённый
  плагин не рендерится, а импорт разрешён только composition-модулю.
- `app.details` на узких экранах может быть недоступен. Смягчение: отдельный
  полноэкранный режим.
- Большой список задач может тормозить. Смягчение: серверная пагинация и
  фильтры через `kanbaner.tasks.task.list`.

## Журнал

- 2026-11-07 — KAN-013 влита в `dev` merge-коммитом
  `0af96620b704b9951f12d9d13007de5584d51556`; strict install, check:imports,
  полный check, 19 E2E и deferred SIGTERM зелёные на ветке и `dev`, финальное
  ревью разрешило интеграцию. Feature-ветка и worktree удалены, задача done.
- 2026-11-07 — E2E выявил потерю `VERSION_CONFLICT`: dynamic import плагина
  создаёт второй экземпляр SDK, поэтому `instanceof PluginOperationError` в
  kernel возвращает false. Оркестратор согласовал структурное распознавание
  публичной ошибки с валидацией конверта и тестами кросс-экземплярного
  случая/подделки, а также `@source` в globals.css для адаптивных классов
  UI-пакетов.
- 2026-11-07 — По итогам проверки задач зафиксированы React-free тип
  `invoke` в `task-ui`, импорт только из `@kanbaner/plugin-tasks/contract`,
  `consumes` контрактов tasks, идемпотентная привязка рендерера и запись
  `task-ui` в architecture package layout.
- 2026-11-07 — Задача создана. Для UI принят минимальный статический
  composition: встроенные UI-плагины импортируются только в
  `builtin-ui-plugins.ts`, а shell работает с ними через реестр.

## Итог

- Коммит: merge `0af96620b704b9951f12d9d13007de5584d51556`; feature-коммиты
  `751ba3f`, `3211b93`, `f36adb2`.
- Ветка: `feat/kan-013-task-list` влита в `dev`; ветка и worktree удалены.
- Проверки: strict frozen install, `check:imports`, полный `pnpm check`,
  Playwright и deferred SIGTERM на ветке и `dev`; 6 focused files / 104 tests,
  75 workspace files / 1029 tests, 19 production E2E.
- Остаточные риски: родитель меняется только пересозданием задачи; конфликт
  версий не делает auto-merge; списки проектов/родителей ограничены 200;
  Chromium-only E2E и Windows не проверен. Dialog/focus logic остаётся внутри
  task-list; KAN-014 должен использовать общий task-ui при необходимости.
