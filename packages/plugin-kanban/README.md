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
  «Показать ещё» использует серверный `nextOffset` как курсор. Полностью
  дублированная или пустая страница перечитывает колонку с начала независимо
  от `nextOffset`; пагинация закрывается только когда число уникально
  загруженных ID не меньше `total`, то есть `nextOffset === null` сам по себе
  не доказательство конца при сдвинувшихся позициях.
- Запоздавшие ответы `loadMore` отменяются по поколению/фильтру/ревизии и не
  применяются после смены фильтра, move или reload.
- После move доска перечитывается с сохранением уже догруженного количества.
  Требования видимости хранятся в `Map<taskId, { status, position, filterKey }>`
  для всех одновременных moves; target-колонка догружается до максимума
  required-позиций и продолжает читаться, пока в результатах не появятся все
  required ID (`mustIncludeIds`). Требование снимается только когда текущий
  reload действительно содержит ID; reload с другим фильтром его не стирает.
  Поэтому две одновременные карточки за page boundary не теряются.
- Фильтры проекта и тега хранятся в query string (`project`, `tag`) и
  переживают reload. Выбранная карточка хранится в `task`.
- Query string обновляется через `replaceSearch` из router-aware shell
  (`router.replace` теми же параметрами, что и `search`). Это держит
  `useSearchParams` синхронным; fallback — `history.replaceState`.
- Горизонтальная прокрутка включена только у контейнера колонок; страница на
  360 px не получает горизонтальный overflow.

## Перемещение и порядок

- Команда: `kanbaner.tasks.task.move` с `expectedVersion`, `status`,
  `position`. `completedAt` при переходе в `done` выставляет домен.
- Позиция считается по полному нефильтрованному ordered-списку
  `(projectId, status)` (все страницы `task.list`, `limit ≤ 200`): `append` —
  реальная длина scope, `beforeId` — индекс в этом же списке.
- Действия «Выше»/«Ниже» относятся к видимому порядку. Сначала строится
  optimistic placement, затем берётся следующая видимая после перемещаемой
  карточка: её ID становится `before`-anchor-ом, а отсутствие следующей даёт
  `append`. Полный scope переводит anchor в позицию, поэтому скрытые соседи
  сдвигают индекс, но не направление (пример `A(release), B(other),
C(release)`: «Ниже» для A даёт `C, A`, а не `A, C`).
- `reloadBoard` читает актуальные фильтры и поколение из ref: запоздавший
  reload после move не перезаписывает колонку старым фильтром.
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
  string и открытом состоянии; при client-side переходе на другой маршрут или
  Link-переходе с изменением query исчезает.
- Переключение A → B не показывает данные A: рендер и все команды используют
  только `currentTask`, у которого `task.id === taskId`; до загрузки B действия
  заблокированы, project/parent относятся к B.
- На мобильном используется нативный modal `<dialog>` из
  `@kanbaner/task-ui` (`ModalDialog`): focus trap, Escape, возврат фокуса,
  закрытие при переходе breakpoint mobile → desktop. Первый focusable после
  загрузки получает фокус один раз; после реального действия пользователя
  (click/pointerdown/keydown) фокус не перехватывается.
- Число подзадач видимых корневых карточек перезапрашивается по ревизии;
  ошибка запроса показывается как `—` и не кэшируется как `0`.

## Границы импорта

- UI-код импортирует только `@kanbaner/plugin-sdk`,
  `@kanbaner/plugin-tasks/contract`, `@kanbaner/task-ui` и React.
- CSS-классы плагина попадают в Tailwind через
  `@source "../../../../packages/plugin-kanban/src"` в `apps/web/src/app/globals.css`.
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
pnpm exec vitest run packages/plugin-kanban packages/task-ui apps/web/src/ui apps/web/src/components/shell
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
