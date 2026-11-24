---
id: KAN-066
title: Автоматические названия OpenCode-сессий из первого запроса
status: in_progress
stage: 8
priority: medium
owner: worker-kan-066
blocked_by: []
branch: feat/kan-066-auto-session-titles
worktree: .worktrees/kan-066-auto-session-titles
created: 2026-11-24
updated: 2026-11-24
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/roadmap.md
---

# KAN-066 — Автоматические названия OpenCode-сессий из первого запроса

## Цель

Автоматически давать новой OpenCode-сессии короткое понятное название из первого
запроса пользователя, сохраняя возможность явного переименования.

## Результат

- Первый запрос заменяет стандартное `Kanbaner chat` коротким однострочным
  названием, полученным детерминированно без дополнительного вызова модели.
- Ручное название и название непустой сессии автоматически не перезаписываются.
- Новое название сразу появляется в шапке и истории, переживает reload и не
  откатывается старым canonical refresh.
- Автоматическое название является best-effort и не мешает выполнению prompt.

## Объём работ

- [ ] Добавить ограниченную нормализацию текста запроса в название длиной не
  более 60 Unicode code points с понятным fallback.
- [ ] Добавить server-side eligibility: owned current-project session, default
  title и пустая canonical history.
- [ ] Передать в internal prompt transport только display text запроса без
  контекстной преамбулы, base64 и содержимого вложений.
- [ ] Вернуть подтверждённое автоматическое название в internal UI response и
  интегрировать его с title overlay/history invalidation.
- [ ] Добавить unit/integration/E2E regressions и обновить спецификации.

## Владение файлами

Разрешено:

- `packages/opencode/src/session-title.ts` и focused tests;
- `packages/opencode/src/types.ts`, `gateway.ts`, `gateway.test.ts`;
- `packages/opencode/src/ui.tsx`, `ui.test.tsx`;
- `apps/web/src/server/opencode-http.ts`, `opencode-http.test.ts`;
- `apps/web/e2e/opencode.spec.ts`;
- `packages/opencode/README.md`;
- `specs/product-mvp.md`, `specs/architecture.md`;
- `tasks/reports/KAN-066.md`.

Запрещено:

- публичный `/api/v1`, MCP, SQLite, миграции, новые зависимости и AI-summary;
- delete API и изменение ручного rename contract;
- файлы задач, roadmap, package/lock, notes/sticky и чужие worktree;
- ослабление ownership, turn/admission, canonical outcome, title/model overlay,
  drafts, unread и scroll semantics.

## Контракты и зависимости

- Зависит от KAN-060–KAN-065 и сохраняет их поведение.
- Источник названия — отображаемый текст первого запроса, а не прикреплённый
  контекст или содержимое файлов.
- Сервер повторно проверяет default title и пустую history; клиентскому
  признаку новой сессии не доверяем.
- Обновление выполняется до prompt как best-effort. Ошибка генерации/сохранения
  названия не отменяет и не меняет исход prompt.
- `session.update` получает только `title`; metadata и permissions не
  передаются. Названия и текст запроса не логируются.
- Для немедленного UI update допускается ASCII-encoded internal response header;
  NDJSON contract и публичный HTTP API не расширяются.

## Критерии приёмки

- [ ] Обычный первый запрос создаёт короткое название без Markdown-шума и
  лишних пробелов; длинный/Unicode текст ограничен корректно.
- [ ] Пустой или бессмысленный текст оставляет default title и не вызывает
  лишних upstream-мутаций.
- [ ] Manual/non-default title, чужая/child/wrong-project и непустая сессия не
  переименовываются.
- [ ] Title при done/error/cancelled/unconfirmed/non-admission не нарушает prompt
  outcome; retry не переименовывает повторно.
- [ ] Header обновляет текущую шапку и историю; stale refresh сохраняет
  подтверждённое название, а последующий fresh canonical title принимается.
- [ ] Полные проверки и OpenCode E2E зелёные.

## Проверки

- Focused session-title/gateway/http/ui tests.
- `pnpm --filter @kanbaner/opencode typecheck` и web typecheck.
- `pnpm --filter @kanbaner/web test:e2e e2e/opencode.spec.ts`.
- `pnpm check:imports`, `pnpm test:sqlite`, `pnpm check`.
- Live smoke первого prompt и ручного rename выполняет оркестратор, если
  доступна настроенная модель; ограничения явно фиксируются в отчёте.

## Риски

- SDK не предоставляет conditional rename; теоретическая гонка с ручным rename
  из другой вкладки остаётся last-write-wins.
- Ручной title, совпадающий с `Kanbaner chat`, неотличим от default.
- Детерминированная очистка не является полноценным CommonMark parser.
- Дополнительные preflight-запросы не должны бросать ошибку наружу или менять
  admission/unconfirmed semantics.

## Журнал

- 2026-11-24 — Задача создана по запросу пользователя; назначен
  `worker-kan-066`, статус `in_progress`.

## Итог

Заполняется оркестратором после интеграции.
