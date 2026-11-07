# @kanbaner/plugin-kanban

UI-плагин канбана Kanbaner. Не владеет данными: все задачи читаются и
изменяются через публичные команды и запросы плагина `kanbaner.tasks`.

## Идентификация

- Plugin ID: `kanbaner.kanban`
- Версия манифеста: `1.0.0`, Host API `^1.0.0`
- Требует: `kanbaner.tasks` `^1.0.0`
- Потребляет: `kanbaner.tasks.commands.v1`, `kanbaner.tasks.queries.v1`
- Предоставляет: `kanbaner.kanban.ui.v1`
- Разрешения: `commands`, `events`, `ui`
- Маршрут: `/view/kanban`

## Вклады

| ID                           | Слот           | Вид          | Назначение                         |
| ---------------------------- | -------------- | ------------ | ---------------------------------- |
| `kanbaner.kanban.view`       | `app.main`     | `view`       | Доска с четырьмя колонками         |
| `kanbaner.kanban.navigation` | `app.sidebar`  | `navigation` | Ссылка «Канбан»                    |
| `kanbaner.kanban.details`    | `app.overlays` | `panel`      | Детали/редактор выбранной карточки |

Серверный entrypoint (`dist/index.js`) регистрирует только metadata. Реальные
React-рендереры находятся в клиентском entrypoint (`dist/ui.js`) и
привязываются к metadata в `apps/web/src/ui/builtin-ui-plugins.ts`.

## Доска

- Фиксированный порядок колонок: `backlog`, `todo`, `in_progress`, `done`.
- Заголовок, количество задач (`total` из `task.list`) и пустое состояние.
- Карточка: заголовок, приоритет, срок, теги, число непосредственных подзадач,
  индикаторы сохранения и конфликта версий.
- Загрузка через `kanbaner.tasks.task.list` с фильтрами `projectId`/`tag` и
  сортировкой `position asc`.
- Пагинация внутри каждой колонки: страницы по 10 карточек, кнопка
  «Показать ещё» использует `limit`/`offset`/`nextOffset`. После команды доска
  перечитывается с сохранением уже догруженного количества.
- Фильтры проекта и тега хранятся в query string (`project`, `tag`) и
  переживают reload. Выбранная карточка хранится в `task`.
- Горизонтальная прокрутка включена только у контейнера колонок; страница на
  360 px не получает горизонтальный overflow.

## Перемещение и порядок

- Команда: `kanbaner.tasks.task.move` с `expectedVersion`, `status`,
  `position`. `completedAt` при переходе в `done` выставляет домен.
- Позиция считается в области `(projectId, status)`: карточки других проектов
  на общей доске не искажают индекс.
- Drag-and-drop реализован нативными pointer events на drag handle. Новых
  DnD-библиотек нет.
- DnD не единственный путь: у каждой карточки есть меню «Переместить в…»,
  «Выше», «Ниже», «В начало», «В конец». Все действия доступны с клавиатуры и
  на мобильных.
- Оптимистичное обновление: карточка сразу меняет колонку/место, pending
  показывается только на ней. При ошибке выполняется откат к серверному
  snapshot и выводится сообщение.
- `VERSION_CONFLICT` откатывает оптимистичное состояние и перечитывает доску,
  не отправляя устаревшую команду повторно. Store повышает версии сдвинутых
  соседей, поэтому после успешного move данные берутся из повторного запроса.

## Детали и редактор

- Overlay использует `TaskDetails`/`TaskForm` из `@kanbaner/task-ui` и
  `invoke` UI-рантайма; собственной копии деталей и доменных запросов вне
  компонентов нет.
- Рендерится только при `pathname === "/view/kanban"`, непустом `task` в query
  string и открытом состоянии; при client-side переходе на другой маршрут
  исчезает.
- На мобильном используется нативный modal `<dialog>` из
  `@kanbaner/task-ui` (`ModalDialog`): focus trap, Escape, возврат фокуса,
  закрытие при переходе breakpoint mobile → desktop.

## Границы импорта

- UI-код импортирует только `@kanbaner/plugin-sdk`,
  `@kanbaner/plugin-tasks/contract`, `@kanbaner/task-ui` и React.
- Запрещены корневой `@kanbaner/plugin-tasks`, `@kanbaner/kernel`,
  `@kanbaner/storage-sqlite`, внутренности `apps/web` и
  `@kanbaner/plugin-task-list`.
- UI-entrypoint разрешён только composition-модулю
  `apps/web/src/ui/builtin-ui-plugins.ts`.
- Серверный граф не импортирует React и клиентские компоненты. Проверки
  выполняет `scripts/check-import-boundaries.mjs` вместе с self-test.

## Проверки

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm exec vitest run packages/task-ui packages/plugin-kanban apps/web/src/ui
node scripts/check-import-boundaries.mjs --self-test
pnpm check
cd apps/web && pnpm exec playwright test
```

## Ограничения

- Доска показывает задачи всех проектов, если фильтр проекта не выбран.
  Позиции уникальны внутри проекта, поэтому визуальный порядок между
  проектами определяется сортировкой `position, id` домена.
- Число непосредственных подзадач запрашивается отдельным `task.list` с
  `parentTaskId` и `limit: 1` для каждой видимой корневой карточки; отдельного
  агрегата в контракте `kanbaner.tasks` нет.
- Отключение плагина убирает маршрут и вклады, но не удаляет задачи.
