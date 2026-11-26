---
id: KAN-064
title: История и управление OpenCode-сессиями
status: done
stage: 8
priority: high
owner: worker-kan-064
blocked_by: []
branch: dev
worktree: .
created: 2026-11-23
updated: 2026-11-24
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/technology-stack.md
  - specs/roadmap.md
---

# KAN-064 — История и управление OpenCode-сессиями

## Цель

Реализовать пункт 5 roadmap: список последних сессий и возврат к ним без потери
контекста, сохраняя создание, переименование и удаление отдельными операциями.

## Результат

- Пользователь видит последние сессии текущего проекта и может открыть любую из списка.
- Восстанавливаются canonical messages, выбранная модель и черновик KAN-063.
- Создание и переименование являются явными действиями; удаление не добавляется.
- Чужие, archived и subagent-сессии не попадают в список.

## Объём работ

- [x] Проверить live/типы `session.list` и правила заголовков на pinned client.
- [x] Добавить whitelist gateway summary, pagination и ownership/project filtering.
- [x] Добавить внутренний same-origin GET list transport; rename — только отдельной
  явной операцией, если входит в выбранную стратегию заголовков.
- [x] Реализовать lazy history UI, переключение и ошибки 404/503 без автосоздания сессии.
- [x] Сохранить generation/abort/canonical semantics и per-session drafts.
- [x] Добавить unit/integration/E2E/live smoke и документацию.

## Владение файлами

Разрешено:

- `packages/opencode/src/types.ts`, `gateway.ts`, `ui.tsx` и связанные тесты;
- `packages/opencode/src/session-history.tsx` и связанные focused-тесты;
- `packages/opencode/README.md`;
- `apps/web/src/server/opencode-http.ts`, `opencode-http.test.ts`;
- `apps/web/src/app/api/opencode/session/**`;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/product-mvp.md`, `specs/architecture.md`, `specs/technology-stack.md`;
- `tasks/reports/KAN-064.md`.

Запрещено:

- удаление сессий и destructive API;
- SQLite, локальное дублирование истории в БД, миграции и изменения ядра;
- `/api/v1`, MCP exposure, client-controlled directory/project;
- новые зависимости и lock-файл.

## Контракты и зависимости

- Начинается после KAN-063 и использует per-session drafts.
- Источник истории — внешний OpenCode Service; Kanbaner хранит только last session ID
  и локальные черновики.
- Доступ ограничен `metadata.source=kanbaner`, агентом `kanbaner` и текущим проектом.
- Summary содержит только `id`, `title`, `updatedAt`. Допускается не более 4
  страниц по 50 upstream-сессий и 30 записей в ответе; cursor и фильтры не
  принимаются от браузера.
- Переименование выполняется только для текущей сессии через отдельный PATCH с
  единственным полем `title`; `metadata`, `permissions` и `archived` не
  передаются. Автоматического rename по prompt нет.
- Во время активного prompt переключение сессий блокируется до terminal/Stop;
  stale list/switch response отбрасывается по generation.
- При 404 сохранённый ID очищается без автосоздания сессии и показывается empty
  state с явной CTA. Первичный bootstrap без сохранённого ID сохраняет прежнее
  поведение; 503 не меняет сохранённый ID и текущую сессию.

## Критерии приёмки

- [x] Список содержит только разрешённые top-level сессии текущего проекта.
- [x] Выбор восстанавливает сообщения и черновик без смешивания streaming состояния.
- [x] Reload восстанавливает последнюю выбранную сессию.
- [x] 404 удаляет только недействительную запись; 503 не стирает last session ID.
- [x] Нет N+1 без ограничения, бесконечной pagination или утечки metadata/location/cost.
- [x] Keyboard/mobile, unit/integration/E2E и полный `pnpm check` зелёные.

## Проверки

- Focused gateway/http/UI tests и `e2e/opencode.spec.ts`.
- Безопасный live smoke с изолированным project/data environment.
- `pnpm check:imports`, `pnpm test:sqlite`, `pnpm check`.

## Риски

- Одинаковый `Kanbaner chat` title требует проверенной стратегии различимых названий.
- Stale list/switch response не должен перезаписать новую сессию.
- Переключение во время prompt должно безопасно применять abort/generation semantics.

## Журнал

- 2026-11-23 — Задача создана по пункту 5 roadmap; ожидала KAN-063.
- 2026-11-24 — KAN-063 завершена. Назначен `worker-kan-064`, создана ветка и
  worktree; статус `in_progress`. Зафиксированы bounded list, явный rename,
  запрет delete, блокировка switching во время prompt и 404 без автосоздания.
- 2026-11-24 — Worker реализовал list/switch/rename. Коммит `1b1fad5`; focused
  179/179, E2E 26/26, полный `pnpm check` — 144 files / 2036 tests. Live smoke
  остаётся оркестратору.
- 2026-11-24 — Ревью нашло high: rename/failed switch обнуляли visible turn и
  отменяли canonical refresh. Также требуются invalidation in-flight list,
  code-point title validation и focus recovery после 404. Задача возвращена в
  `in_progress`; merge запрещён до повторного ревью.
- 2026-11-24 — Worker исправил замечания коммитами `5d8aecd` и `bb4b824`.
  Финальное ревью не нашло blocker/high/medium/low. Focused tests 192/192,
  OpenCode E2E 27/27, полный `pnpm check` — 144 files / 2049 tests. Live smoke
  реального Service 2.2.5 подтвердил list/whitelist/pagination/rename/
  ownership/drafts/reload/404. Статус `review`.
- 2026-11-24 — После rebase коммиты `7ff04d8`, `8a9636e`, `1f7a355`
  интегрированы merge-коммитом `a63a46c`. `pnpm check` на ветке и `dev`
  зелёный; OpenCode E2E на `dev` — 27/27, imports и SQLite smoke зелёные.
  Статус `done`.

## Итог

Пункт 5 roadmap реализован и смержен в `dev`. Панель показывает последние
сессии текущего проекта, открывает их с canonical messages, моделью и
собственным черновиком, поддерживает явное переименование и восстановление
последней выбранной сессии после reload. Чужие, archived и subagent-сессии
отфильтровываются; удаление не добавлялось. Ошибки 404/503 и stale responses
не приводят к автосозданию или смешиванию состояния текущего хода.

Merge: `a63a46c`. Feature-ветка и worktree удалены. Push не выполнялся.
