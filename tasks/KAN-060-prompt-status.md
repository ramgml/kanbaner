---
id: KAN-060
title: Статусы и ошибки конкретного prompt
status: in_progress
stage: 8
priority: high
owner: worker-kan-060
blocked_by: []
branch: feat/kan-060-prompt-status
worktree: .worktrees/kan-060-prompt-status
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

- [ ] Проверить и при необходимости доработать переданную оркестратором
  baseline-заготовку canonical outcome; не ослаблять её проверки.
- [ ] Добавить transport/UI-состояние `finalizing` и машинный признак
  `unconfirmed`, сохранив generation/abort semantics.
- [ ] Реализовать turn-scoped этапы, ошибки, «Проверить статус» и безопасный retry.
- [ ] Добавить unit/integration/E2E regression-тесты и обновить документацию.

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

- [ ] Все четыре этапа отображаются на соответствующих событиях конкретного prompt.
- [ ] Terminal/error/retry не смешиваются между ходами и сессиями.
- [ ] Unconfirmed не вызывает автоматический prompt retry или потерю streamed-ответа.
- [ ] «Проверить статус» читает canonical session и сообщает результат без дублирования prompt.
- [ ] Ошибка не доминирует над уже полученным ответом; panel-level ошибки сохраняются.
- [ ] Keyboard/mobile и остановка prompt не регрессируют.
- [ ] Проверки зелёные, отчёт содержит результаты и остаточные риски.

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

## Итог

Заполняется оркестратором после интеграции.
