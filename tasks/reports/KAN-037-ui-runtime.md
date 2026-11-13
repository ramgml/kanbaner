# KAN-037 — ResourceRef UI runtime и вложенные slots

## Что сделано

- В `@kanbaner/plugin-sdk` расширен `UiContributionSchema` опциональным полем
  `resourcePluginId`: `resource-opener` может открывать ресурс чужого домена, не
  импортируя плагин-владелец.
- Клиентский реестр UI-вкладов получил `resolveResourceOpener(ref)`: поиск идёт
  по `pluginId` и `resourceType` из `ResourceRef`, владелец ресурса по умолчанию
  совпадает с владельцем вклада.
- Новая точка `apps/web/src/ui/resource-open.ts`:
  - `resolveResourceOpen(registry, availability, ref)` возвращает безопасный
    результат (`ok` + href или код ошибки), не бросает исключений;
  - `buildResourceHref(route, ref)` сохраняет query/hash вклада и добавляет
    `resource=<encoded ResourceRef>`;
  - недоступный или отключённый opener не роняет shell.
- `UiResourceOpenerRuntime` и `useUiResourceOpener` в
  `apps/web/src/ui/provider.tsx` связывают opener с навигацией shell-а
  (`router.push`) и безопасным `history` fallback вне shell-а.
- `AppShell` оборачивает дерево в runtime, показывает notice «Ресурс
  недоступен» вместо падения и сбрасывает его при успешном переходе.
- `UiSlot`/`ContributionRenderer` получили:
  - `context: JsonObject` — сериализуемый контекст вложенного слота;
  - `openResource(ref)` — открытие `ResourceRef` через реестр;
  - `renderSlot(slot, context)` — outlet опубликованного слота.
    Вложенный слот вызывает hooks внутри `UiSlot`, а каждый вклад остаётся в
    собственной границе ошибок.
- `UiRendererProps` в `@kanbaner/task-ui` публикует `context`, `openResource` и
  `renderSlot`, не добавляя React-зависимостей в SDK.
- `kanbaner.projects`:
  - объявлены resource-opener-ы проекта и задачи (`resourcePluginId:
"kanbaner.tasks"`, route `/view/kanban`);
  - объявлен слот `kanbaner.projects.task.related`;
  - `TaskModal` и `TaskDetailsPanel` рендерят связанные материалы через
    `renderSlot`, передавая `{ resourceRef: "kanbaner.tasks:task:<id>" }`;
  - `parseWorkspaceResource` переводит `resource=<ResourceRef>` в прежние ключи
    `task`/`project`; явные ключи имеют приоритет, чтобы старые закладки не
    ломались;
  - `query-state.ts` доски и списка использует этот разбор.

Публичный контракт расширен аддитивно: старые вклады без новых полей
продолжают работать.

## Изменённые файлы

- `packages/plugin-sdk/src/ui.ts` — `resourcePluginId` в схеме вклада.
- `packages/task-ui/src/runtime.ts`, `packages/task-ui/src/index.ts` — типы
  `UiResourceOpener`, `UiResourceOpenResult`, `UiSlotRenderer` и новые props.
- `apps/web/src/ui/registry.ts`, `plugin-api.ts`, `provider.tsx` — реестр,
  opener runtime и публичные экспорты.
- `apps/web/src/ui/resource-open.ts` — новый модуль разрешения ресурса.
- `apps/web/src/components/shell/ui-slot.tsx`, `app-shell.tsx` — контекст,
  вложенные слоты и notice.
- `apps/web/src/ui/registry.test.tsx`, `builtin-ui-plugins.test.tsx`,
  `apps/web/src/components/shell/resource-opener.test.tsx` — тесты.
- `packages/plugin-projects/src/metadata.ts`, `ui.tsx`, `index.ts` — вклады
  opener-ов и слот связанных материалов.
- `packages/plugin-projects/src/ui/resource-query.ts` — новый разбор `resource`.
- `packages/plugin-projects/src/ui/query-state.ts`,
  `src/task-list/query-state.ts` — поддержка `resource` в query.
- `packages/plugin-projects/src/ui/task-modal.tsx`,
  `src/task-list/task-details-panel.tsx`, `src/ui/task-overlay.tsx` — outlet
  связанных материалов.
- `packages/plugin-projects/src/ui/resource-query.test.ts` — новые тесты разбора
  ссылки и интеграции с query доски/списка.
- `tasks/reports/KAN-037-ui-runtime.md` — отчёт.

## Проверки

- Целевые тесты: registry, shell/resource-opener, resource-query,
  registration, builtin-ui-plugins — зелёные.
- `pnpm typecheck` — успешно.
- Полный `pnpm check` (format, lint, typecheck, tests, build) — зелёный:
  105 файлов / 1491 тест.
- Первые прогоны `pnpm check` падали по таймауту 5 s в
  `tests/contract/fixture-activation.test.ts` и
  `tests/integration/tasks-activation.test.ts` при load average ~25 из-за
  параллельных сборок в других worktree. Изолированный прогон этих файлов и
  повторный полный `pnpm check` — зелёные; к изменениям задачи падения
  отношения не имеют.
- `pnpm check:imports` — границы импортов соблюдены; `plugin-notes` не
  импортируется.
- Prettier применён ко всем затронутым файлам.

## Интеграция

- Ветка `feat/kan-037-resource-ui` в worktree
  `.herdr/worktrees/kanbaner/feat-kan-037-resource-ui`.
- Коммит без push; merge в `dev` выполняет оркестратор.

## Ограничения и риски

- `resource` в URL — транзитный параметр: при локальном обновлении query он
  заменяется явными ключами `task`/`project`. Это осознанно: адреса остаются
  человекочитаемыми и совместимыми со старыми ссылками.
- Вложенные слоты передают только JSON-контекст; React-объекты и DOM родителя
  недоступны по контракту.
- Полный Playwright E2E в этой задаче не запускался.
