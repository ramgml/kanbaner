---
id: KAN-054
title: Глобальная панель OpenCode и ограниченный MCP
status: in_progress
stage: 7
priority: high
owner: opencode-orchestrator
blocked_by: []
branch: dev
worktree: .
created: 2026-11-19
updated: 2026-11-19
specs:
  - specs/context.md
  - specs/product-mvp.md
  - specs/technology-stack.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-054 — Глобальная панель OpenCode и ограниченный MCP

## Цель

Добавить глобальную правую панель чата с текущей конфигурацией OpenCode и безопасные операции над задачами, проектами и заметками через MCP.

## Результат

Пользователь явно открывает панель, выбирает доступные модель и variant, получает streaming-ответ и может разрешить агенту создавать и обновлять ресурсы Kanbaner без shell, filesystem и delete-инструментов.

## Объём работ

- [x] Добавить отдельный пакет `@kanbaner/opencode` и слот `app.assistant`.
- [x] Подключить текущий OpenCode Service через `Service.ensure()` и `@opencode/client`.
- [x] Реализовать catalog, session lifecycle, model switch, history и NDJSON streaming с отменой.
- [x] Добавить ограниченный MCP с create/update и обязательными `expectedVersion`/`Idempotency-Key`.
- [x] Защитить UI transport, исключить передачу provider settings и секретов в браузер.
- [x] Добавить unit/integration/E2E-тесты и live smoke.
- [x] Обновить спецификации и документацию.

## Владение файлами

Разрешено:

- `packages/opencode/**`;
- `apps/web/src/app/api/opencode/**`;
- `apps/web/src/server/opencode-http*`;
- `apps/web/src/components/shell/app-shell.tsx`;
- `apps/web/src/ui/builtin-ui-plugins.ts`;
- `apps/web/e2e/opencode.spec.ts`;
- `opencode.jsonc`, `.env.example`, `README.md`, `AGENTS.md`;
- `package.json`, `apps/web/package.json`, `pnpm-lock.yaml`;
- `specs/**`, `tasks/KAN-054-opencode-assistant.md`, `tasks/reports/KAN-054.md`.

Запрещено:

- доменная логика задач/заметок в адаптере;
- доступ MCP к SQLite или Storage Provider;
- delete, shell и filesystem tools;
- секреты в `opencode.jsonc` и клиентском JavaScript;
- изменение или удаление других незакоммиченных работ.

## Критерии приёмки

- [x] Desktop right panel и mobile fullscreen открываются и закрываются глобально.
- [x] Catalog не содержит credentials, headers, provider settings или request body.
- [x] Prompt стартует после готовности event subscription, завершается и прерывается корректно.
- [x] Tool calls обновляются по ID, history не дублируется, async UI races исключены.
- [x] Доступны только сессии `metadata.source=kanbaner` с агентом `kanbaner`.
- [x] Update требует `expectedVersion`; повторяемые mutations получают `Idempotency-Key`.
- [x] Проверки, production build и smoke зелёные либо ограничения явно перечислены.

## Журнал

- 2026-11-19 — Задача создана по явному запросу пользователя; это разрешённое исключение из запрета встроенного ИИ для необязательной интеграции с внешним OpenCode Service.
- 2026-11-19 — Независимое ревью выявило завершение потока, subscription race, abort, UI races и ограничение сессий; исправления интегрированы централизованно без отдельных worktree из-за общих файлов.
- 2026-11-19 — Повторное ревью выявило durable inbox/admission races и MCP strict/idempotency issues; исправления покрыты regression-тестами. `pnpm check` 1793/1793, E2E 143/143 и live smoke успешны. Подробности: `tasks/reports/KAN-054.md`.

## Итог

Реализация и проверки завершены; изменения не коммитятся без явной просьбы пользователя. Статус остаётся `in_progress` до интеграционного коммита/merge в `dev`.
