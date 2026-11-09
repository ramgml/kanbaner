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

| ID                                 | Слот           | Вид          | Назначение                                       |
| ---------------------------------- | -------------- | ------------ | ------------------------------------------------ |
| `kanbaner.projects.view.kanban`    | `app.main`     | `view`       | Одна доска одного проекта (`/view/kanban`)       |
| `kanbaner.projects.view.tasks`     | `app.main`     | `view`       | Адаптивный список задач (`/view/tasks`)          |
| `kanbaner.projects.view.overview`  | `app.main`     | `view`       | Необязательный обзор проектов (`/view/projects`) |
| `kanbaner.projects.sidebar`        | `app.sidebar`  | `panel`      | Переключение, поиск и создание проектов          |
| `kanbaner.projects.details`        | `app.details`  | `panel`      | Детали выбранной задачи списка (desktop)         |
| `kanbaner.projects.details-mobile` | `app.overlays` | `panel`      | Детали выбранной задачи списка (mobile)          |
| `kanbaner.projects.kanban-overlay` | `app.overlays` | `panel`      | Детали и редактор карточки доски                 |
| `kanbaner.projects.mobile-sheet`   | `app.overlays` | `panel`      | Мобильный bottom sheet проектов и trigger        |
| `kanbaner.projects.navigation`     | `app.sidebar`  | `navigation` | Единственный вход в workspace (`?entry=1`)       |

## Поведение

- В shell есть один пункт «Проекты». Он ведёт на `/view/projects?entry=1`;
  обзор восстанавливает последнее представление проекта из `localStorage`
  (`readLastProjectView`) либо остаётся в обзоре без служебного параметра.
  Guard `entryHandledRef` сбрасывается после снятия `entry`, поэтому повторный
  клик по пункту без remount снова обрабатывает вход. Ошибка чтения storage
  (`SecurityError`, испорченное значение) трактуется как отсутствие вида.
- Секция «Проекты» видна только на `/view/kanban`, `/view/tasks` и
  `/view/projects`; в настройках и plugin manager её нет.
- Выбор проекта меняет `?project=<id>` без промежуточного экрана и запоминает
  последний выбор в `localStorage`.
- `/view/kanban` без проекта открывает последний или единственный проект; при
  неоднозначном выборе показывает подсказку выбрать проект в sidebar.
- `packages/plugin-projects/src/ui/view-toggle.tsx` рендерит переключатель
  `Список / Канбан` настоящими `<a>` с `aria-pressed` в обоих состояниях.
  Тот же компонент доступен внутри нативного modal-а карточки и мобильных
  деталей: inert-фон не мешает обычному click и клавиатуре, а `task`
  сохраняется в query string. При открытой полной форме или любом
  несохранённом быстром черновике (статус, срок, теги, подзадача) переключатель
  скрыт: уход из модала не может молча потерять ввод.
- Task-list пишет query через router-aware `replaceSearch`, поэтому заголовок
  строит ссылки из актуального `workspaceSearch`, а не из устаревшего
  router-состояния. Внутри одного проекта toggle сохраняет `project`, `tag` и
  `task`; смена проекта осознанно снимает `task` прежнего проекта.
- Создание карточки требует только название. Проект берётся из доски, статус —
  из колонки, позицию вычисляет доменный append. Полная форма используется
  только для редактирования открытой карточки.
- Кнопка «Новый проект» в заголовке списка публикует общий
  `requestProjectCreate()`: на desktop открывается форма sidebar, на mobile —
  bottom sheet. Клика по скрытой desktop-кнопке больше нет.
- `project.list` догружается по `nextOffset` страницами по 200: созданный
  201-й проект открывается и попадает в sidebar, а не считается удалённым.
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
