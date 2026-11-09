# @kanbaner/plugin-projects

Единый UI-плагин рабочего пространства проектов Kanbaner. Он объединяет
прежние `plugin-kanban` и `plugin-task-list`: переключение проектов в sidebar,
доску одного проекта, список задач, мобильный bottom sheet и переключатель
`Список / Канбан`.

## Манифест

- Plugin ID: `kanbaner.projects`
- Версия: `1.0.0`
- Зависит от: `kanbaner.tasks` `^1.0.0`
- Потребляет: `kanbaner.tasks.commands.v1`, `kanbaner.tasks.queries.v1`
- Предоставляет: `kanbaner.projects.ui.v1`
- Разрешения: `commands`, `events`, `ui`
- Entrypoints: серверный `dist/index.js`, клиентский `dist/ui.js`

Плагин не владеет данными. Проекты, задачи и сводки читаются и изменяются
только через публичные операции `kanbaner.tasks`. Отключение UI-плагина не
удаляет данные и не влияет на API.

## UI-вклады

| ID                                 | Слот           | Вид     | Назначение                                       |
| ---------------------------------- | -------------- | ------- | ------------------------------------------------ |
| `kanbaner.projects.view.kanban`    | `app.main`     | `view`  | Одна доска одного проекта (`/view/kanban`)       |
| `kanbaner.projects.view.tasks`     | `app.main`     | `view`  | Адаптивный список задач (`/view/tasks`)          |
| `kanbaner.projects.view.overview`  | `app.main`     | `view`  | Необязательный обзор проектов (`/view/projects`) |
| `kanbaner.projects.sidebar`        | `app.sidebar`  | `panel` | Переключение, поиск и создание проектов          |
| `kanbaner.projects.details`        | `app.details`  | `panel` | Детали выбранной задачи списка (desktop)         |
| `kanbaner.projects.details-mobile` | `app.overlays` | `panel` | Детали выбранной задачи списка (mobile)          |
| `kanbaner.projects.kanban-overlay` | `app.overlays` | `panel` | Детали и редактор карточки доски                 |
| `kanbaner.projects.mobile-sheet`   | `app.overlays` | `panel` | Мобильный bottom sheet проектов и trigger        |

## Поведение

- Секция «Проекты» видна только на `/view/kanban`, `/view/tasks` и
  `/view/projects`; в настройках и plugin manager её нет.
- Выбор проекта меняет `?project=<id>` без промежуточного экрана и запоминает
  последний выбор в `localStorage`.
- `/view/kanban` без проекта открывает последний или единственный проект; при
  неоднозначном выборе показывает подсказку выбрать проект в sidebar.
- Переключатель `Список / Канбан` — настоящая навигация: проект, тег, фильтры
  и выбранная задача сохраняются в query string.
- Создание карточки требует только название. Проект берётся из доски, статус —
  из колонки, позицию вычисляет доменный append. Полная форма используется
  только для редактирования открытой карточки.
- На мобильном плагин публикует trigger «Проекты» в overlay-слое: shell
  навигация не содержит доменных пунктов. Выбор проекта закрывает sheet.

## Структура

```text
src/
  index.ts        серверная регистрация metadata
  metadata.ts     Plugin ID, маршруты, UI-вклады
  ui.tsx          клиентский entrypoint: привязка рендереров
  ui/             доска, sidebar, обзор, composer, общий query state
  task-list/      список задач, детали, собственный query state
```

`packages/task-ui` остаётся общей библиотекой примитивов и не становится
плагином. Код плагина не импортирует `kernel`, storage и внутренности других
плагинов.

## Проверки

```bash
pnpm --filter @kanbaner/plugin-projects typecheck
pnpm exec vitest run packages/plugin-projects
pnpm check:imports
```

E2E рабочего пространства находятся в `apps/web/e2e/kanban.spec.ts` и
`apps/web/e2e/task-list.spec.ts`.
