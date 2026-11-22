---
id: KAN-057
title: Полный доступ OpenCode для агента kanbaner
status: in_progress
stage: 7
priority: high
owner: worker
blocked_by: []
branch: dev
worktree: .
created: 2026-11-20
updated: 2026-11-20
specs:
  - specs/context.md
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-057 — Полный доступ OpenCode для агента kanbaner

## Цель

Открыть chat-агенту `kanbaner` полный стандартный toolset OpenCode и показать
его в панели отдельно от ограниченного Kanbaner MCP, явно зафиксировав риски.

## Решение пользователя

2026-11-20 пользователь явно выбрал «Полный доступ OpenCode» после обсуждения
рисков. Прежний запрет shell/filesystem для chat-агента заменён. Это осознанное
расширение прав внешнего OpenCode-агента, а не sandbox:

- агент может читать и изменять файлы, включая секреты и `.env`;
- shell выполняется с правами пользователя и имеет доступ к сети;
- websearch/webfetch/subagent/skill/external_directory доступны;
- сторонние MCP servers, Code Mode `execute` и удаление данных Kanbaner
  через MCP по-прежнему не включены.

## Результат

- `opencode.jsonc`: ordered deny `*`, затем явные allow для `question`,
  `websearch`, `webfetch`, `read`, `glob`, `grep`, `edit`, `shell`, `subagent`,
  `skill`, `external_directory` и `kanbaner_*`.
- `codemode: false` для Kanbaner MCP сохранён; модели и credentials не менялись.
- Catalog отдаёт встроенные tools отдельно от 14 Kanbaner MCP tools; UI
  показывает две группы и предупреждение «Полный доступ: интернет, файлы и shell».
- Типы tool metadata совместимы: `source`, optional `operationId` и
  `requiresExpectedVersion`; существующий MCP allowlist не изменён.
- Документация фиксирует решение пользователя, риск доступа к секретам, файлам
  и сети, а также отсутствие песочницы.

## Объём работ

- [x] Обновить permissions и system prompt агента kanbaner.
- [x] Разделить built-in и MCP tools в catalog/UI, добавить предупреждение.
- [x] Добавить metadata-тест против `opencode.jsonc` и обновить UI/E2E тесты.
- [x] Обновить спецификации, README, AGENTS.md и README пакета.
- [x] Прогнать проверки и зафиксировать фактические результаты.
- [ ] Интеграционный commit/merge выполняет оркестратор.

## Владение файлами

Разрешено:

- `opencode.jsonc`;
- `packages/opencode/src/{types,tool-metadata,ui,gateway}.ts(x)` и тесты;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/{context,product-mvp,architecture,plugin-contract}.md`;
- `README.md`, `AGENTS.md`, `packages/opencode/README.md`;
- `tasks/KAN-057-opencode-full-access.md`, `tasks/reports/KAN-057.md`.

Запрещено:

- app-shell, resizer и другие пакеты/домены;
- сторонние MCP servers, Code Mode `execute`, delete MCP tools;
- approval flow с `ask` и заявление о sandbox;
- чужие незакоммиченные изменения;
- commit/push/merge/rebase.

## Критерии приёмки

- [x] Allowlist built-ins совпадает с permissions в `opencode.jsonc`.
- [x] Нет wildcard allow для всех сторонних tools и нет allow для `execute`.
- [x] UI показывает built-ins и Kanbaner MCP отдельными группами и предупреждение.
- [x] Composer, вложения, Markdown и streaming не сломаны.
- [x] Unit/E2E/config проверки зелёные либо ограничения перечислены.

## Журнал

- 2026-11-20 — Задача создана после явного решения пользователя о полном
  доступе. Работа выполняется в текущем checkout без worktree и коммита.
- 2026-11-20 — Worker реализовал allowlist, catalog/UI и документацию; focused
  tests 58/58, OpenCode E2E 7/7, build и typecheck успешны.
- 2026-11-20 — Полный `pnpm check`: 135 test files / 1826 tests; import,
  SQLite и composition checks успешны.
- 2026-11-20 — Live smoke подтвердил 11 built-in + 14 MCP и реальные вызовы
  `glob`, `read`, `shell pwd`, `webfetch`; terminal `done`. Подробности:
  `tasks/reports/KAN-057.md`.
- 2026-11-20 — Независимый reviewer не нашёл blocker/high/medium. Low-пробел
  теста закрыт assertion на единственный MCP server `kanbaner`; повторный
  `pnpm check` — 1826/1826.
- 2026-11-20 — По запросу пользователя блок модели стал disclosure с
  выбранной моделью в summary; UI unit 21/21, OpenCode E2E 7/7, полный
  `pnpm check` — 1827/1827.

## Итог

Реализация, независимый review и проверки завершены. Изменения сохраняются без
коммита; статус остаётся `in_progress` до интеграционного commit/merge в `dev`.
