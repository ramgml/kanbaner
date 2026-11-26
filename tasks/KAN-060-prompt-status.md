---
id: KAN-060
title: Статусы и ошибки конкретного prompt
status: done
stage: 8
priority: high
owner: worker-kan-060
blocked_by: []
branch: dev
worktree: .
created: 2026-11-23
updated: 2026-11-23
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/technology-stack.md
  - specs/roadmap.md
---

# KAN-060 — Статусы и ошибки конкретного prompt

## Цель

Реализовать пункт 1 раздела «Предложения по OpenCode UI/UX после MVP»:
понятные этапы prompt и безопасное восстановление после неподтверждённого
результата без автоматического повторного запуска.

## Результат

- Пользователь видит этапы `Подключаемся → Выполняется → Завершаем → Готово`.
- Ошибка и retry относятся к конкретному ходу и не скрывают полученный ответ.
- При неподтверждённом результате предлагается «Проверить статус»; prompt
  автоматически не повторяется и уже полученный текст не затирается.
- Повторный запуск возможен только для хода, который точно не был принят.

## Объём работ

- [x] Проверить и при необходимости доработать переданную оркестратором
  baseline-заготовку canonical outcome; не ослаблять её проверки.
- [x] Добавить transport/UI-состояние `finalizing` и машинный признак
  `unconfirmed`, сохранив generation/abort semantics.
- [x] Реализовать turn-scoped этапы, ошибки, «Проверить статус» и безопасный retry.
- [x] Добавить unit/integration/E2E regression-тесты и обновить документацию.

## Владение файлами

Разрешено:

- `packages/opencode/src/types.ts`;
- `packages/opencode/src/gateway.ts` и связанные gateway-тесты;
- `packages/opencode/src/ui.tsx` и `ui.test.tsx`;
- `packages/opencode/README.md`;
- `apps/web/src/server/opencode-http.ts` и `opencode-http.test.ts`;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/product-mvp.md`, `specs/architecture.md`, `specs/technology-stack.md`;
- `tasks/reports/KAN-060.md`.

Запрещено:

- файл задачи `tasks/KAN-060-prompt-status.md`;
- `apps/web/e2e/notes.spec.ts`, shell-файлы и sticky-sidebar изменения;
- ядро, доменные плагины, SQLite, миграции, `/api/v1`, MCP allowlist;
- новые зависимости и изменения lock-файла.

## Контракты и зависимости

- Используется существующий внутренний same-origin `/api/opencode/*` transport.
- Новый публичный HTTP/MCP API не создаётся.
- Сохраняются session ownership, redaction, canonical verification, generation
  и abort semantics.
- Задача является первым приоритетом roadmap и не имеет незавершённых зависимостей.

## Критерии приёмки

- [x] Все четыре этапа отображаются на соответствующих событиях конкретного prompt.
- [x] Terminal/error/retry не смешиваются между ходами и сессиями.
- [x] Unconfirmed не вызывает автоматический prompt retry или потерю streamed-ответа.
- [x] «Проверить статус» читает canonical session и сообщает результат без дублирования prompt.
- [x] Ошибка не доминирует над уже полученным ответом; panel-level ошибки сохраняются.
- [x] Keyboard/mobile и остановка prompt не регрессируют.
- [x] Проверки зелёные, отчёт содержит результаты и остаточные риски.

## Проверки

```bash
pnpm exec vitest run packages/opencode/src/gateway.test.ts packages/opencode/src/gateway-service-version.test.ts packages/opencode/src/ui.test.tsx apps/web/src/server/opencode-http.test.ts
pnpm --filter @kanbaner/opencode typecheck
pnpm --filter @kanbaner/web typecheck
pnpm --filter @kanbaner/web exec playwright test e2e/opencode.spec.ts
pnpm check:imports
pnpm test:sqlite
pnpm check
```

## Риски

- Stale async response может перезаписать новый ход: все применения состояния
  должны быть generation-guarded.
- Автоматический refresh при unconfirmed может стереть streamed-ответ: он запрещён.
- После `finalizing` нельзя выпускать второй terminal error.
- Точные последовательности gateway-событий нельзя ослаблять ради зелёных тестов.

## Журнал

- 2026-11-23 — Задача создана по пункту 1 roadmap.
- 2026-11-23 — Назначен `worker-kan-060`, создана ветка и worktree; статус
  `in_progress`.
- 2026-11-23 — Worker применил и ревьюнул baseline patch, реализовал этапы,
  turn-scoped ошибки и ручную проверку статуса. Коммит `cd98faf`; focused
  tests 89/89, OpenCode E2E 10/10, `pnpm check` зелёный.
- 2026-11-23 — Независимое ревью нашло blocker/high: retry при ambiguous fetch
  failure, ordinal вместо stable turn ID и преждевременный done по assistant
  text. Merge остановлен; задача возвращена worker в `in_progress`.
- 2026-11-23 — Worker исправил замечания коммитами `0d7f1a4` и `f73bdcd`.
  Повторное ревью подтвердило отсутствие blocker/high/medium/low. Focused
  tests 109/109, OpenCode E2E 12/12, полный `pnpm check` — 139 files /
  1909 tests. Статус `review`.
- 2026-11-23 — После rebase коммиты получили SHA `ca41103`, `68d3920`,
  `c5f1b26`; интеграция выполнена merge-коммитом `61b597c`. `pnpm check` на
  ветке и `dev` зелёный; OpenCode E2E на `dev` — 12/12, imports и SQLite smoke
  зелёные. Статус `done`.

## Итог

Пункт 1 roadmap реализован и смержен в `dev`. Пользователь видит этапы
`Подключаемся → Выполняется → Завершаем → Готово`; ошибки и retry привязаны к
конкретному stable turn ID. Неподтверждённый результат не вызывает повторный
prompt, а ручная проверка использует canonical outcome и сохраняет streamed
ответ. Независимое ревью после исправлений не нашло замечаний.

Merge: `61b597c`. Feature-ветка и worktree удалены. Push не выполнялся.
Исходная незакоммиченная baseline-заготовка сохранена в
`stash@{0}: On dev: preserve KAN-060 baseline before merge`; она полностью
замещена более новой реализацией KAN-060 и не применялась поверх merge.
