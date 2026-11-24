---
id: KAN-065
title: Сквозные регрессии OpenCode UX
status: done
stage: 8
priority: high
owner: worker-kan-065
blocked_by: []
branch: dev
worktree: .
created: 2026-11-24
updated: 2026-11-24
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/roadmap.md
---

# KAN-065 — Сквозные регрессии OpenCode UX

## Цель

Устранить замечания финального сквозного ревью KAN-060–KAN-064 без расширения
функционального объёма roadmap.

## Результат

- Смена модели и ошибочное создание новой сессии не скрывают текущий turn,
  unconfirmed/`Проверить статус` и не отменяют canonical refresh.
- Canonical user-message собственного prompt не увеличивает unread.
- Ручное подтверждение terminal outcome инвалидирует кэш истории сессий.

## Объём работ

- [x] Перевести model switch и newChat на отдельные request token/controller;
  generation меняется только после успешного создания новой сессии.
- [x] Синхронизировать optimistic/canonical unread для реальной формы history
  `user:<turnID>` + assistant/tools.
- [x] Инвалидировать history при ручном terminal outcome.
- [x] Добавить unit/E2E regression и обновить документацию.

## Владение файлами

Разрешено:

- `packages/opencode/src/ui.tsx`, `ui.test.tsx`;
- `packages/opencode/src/chat-scroll.ts`, `chat-scroll.test.tsx`;
- `packages/opencode/src/session-history.tsx` и связанные тесты;
- `packages/opencode/README.md`;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/product-mvp.md`, `specs/architecture.md`;
- `tasks/reports/KAN-065.md`.

Запрещено:

- новые продуктовые функции, delete API, SQLite, миграции и новые зависимости;
- файлы задач, roadmap, package/lock, notes/sticky и чужие worktree;
- ослабление stable turn/admission/canonical/redaction semantics.

## Контракты и зависимости

- Зависит от завершённых KAN-060–KAN-064 и сохраняет их контракты.
- Неуспешная побочная операция не меняет generation текущей сессии.
- Pending model/newChat инвалидируется более новой операцией без stale apply.

## Критерии приёмки

- [x] Unconfirmed сохраняется после model success/error и failed newChat.
- [x] Delayed canonical refresh после done применяется при model switch.
- [x] Один assistant-ответ после canonical user+assistant даёт unread=1, не 2.
- [x] Ручной done/error/cancelled инвалидирует history cache.
- [x] Unit/E2E и полный `pnpm check` зелёные.

## Проверки

- Focused ui/chat-scroll/session-history tests и весь `e2e/opencode.spec.ts`.
- `pnpm --filter @kanbaner/opencode typecheck` и web typecheck.
- `pnpm check:imports`, `pnpm test:sqlite`, `pnpm check`.

## Риски

- Pending operations могут примениться к другой сессии без token/session guards.
- Нельзя подавить unread assistant/tools вместе с user-message.

## Журнал

- 2026-11-24 — Задача создана по результатам сквозного ревью; назначен
  `worker-kan-065`, создана ветка и worktree, статус `in_progress`.
- 2026-11-24 — Worker исправил model/newChat guards, user-unread и history
  invalidation. Коммит `67c77a6`; focused 133/133, полный Playwright 171/171,
  `pnpm check` — 144 files / 2056 tests.
- 2026-11-24 — Ревью подтвердило основные исправления, но нашло medium:
  pre-switch canonical GET мог откатить выбранную модель. Также требуется
  regression вложений при failed newChat. Задача возвращена в `in_progress`.
- 2026-11-24 — Worker добавил model overlay и усилил attachments regression
  коммитом `33051d4`. Финальное ревью не нашло blocker/high/medium/low.
  Focused 133/133, OpenCode E2E 27/27, полный `pnpm check` — 144 files /
  2056 tests. Статус `review`.
- 2026-11-24 — После rebase коммиты `e96bacb` и `4423e62` интегрированы
  merge-коммитом `e5406e6`. `pnpm check` на ветке и `dev` зелёный; OpenCode
  E2E на `dev` — 27/27, imports и SQLite smoke зелёные. Статус `done`.

## Итог

Сквозные регрессии устранены и смержены в `dev`. Смена модели и ошибочное
создание новой сессии больше не скрывают unconfirmed-turn и не отменяют
canonical refresh. Подтверждённые model/title защищены от старых GET без
блокировки более новых canonical значений. Собственный user-turn не увеличивает
unread, а ручной terminal outcome инвалидирует history cache.

Merge: `e5406e6`. Feature-ветка и worktree удалены. Push не выполнялся.
