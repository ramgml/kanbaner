---
id: KAN-061
title: Компактное представление tool calls
status: backlog
stage: 8
priority: high
owner: unassigned
blocked_by: [KAN-060]
branch: null
worktree: null
created: 2026-11-23
updated: 2026-11-23
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/roadmap.md
---

# KAN-061 — Компактное представление tool calls

## Цель

Реализовать пункт 2 roadmap: сделать ленту OpenCode читаемой, не превращая её
в серверный лог и сохраняя доступ к техническим деталям.

## Результат

- Свернутый tool call показывает иконку, название, состояние и длительность.
- Вход, вывод и технические детали раскрываются по явному действию.
- Последовательные вызовы одного этапа могут группироваться без потери состояний.
- Running/error/cancelled состояния остаются видимыми и корректно завершаются.

## Объём работ

- [ ] Спроектировать compact disclosure на существующих shadcn/Radix/Lucide средствах.
- [ ] Сохранить объединение событий по `assistantMessageID + tool call ID`.
- [ ] Добавить доступное раскрытие, длительность и при необходимости группировку.
- [ ] Покрыть unit/E2E сценарии, обновить документацию.

## Владение файлами

Разрешено:

- `packages/opencode/src/ui.tsx`, `ui.test.tsx`;
- при необходимости `packages/opencode/src/types.ts`, `gateway.ts` и их тесты;
- `packages/opencode/README.md`;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/product-mvp.md`, `specs/architecture.md`;
- `tasks/reports/KAN-061.md`.

Запрещено:

- файлы задач, ядро, доменные плагины, SQLite и миграции;
- новые зависимости, lock-файл и сторонние component libraries;
- изменение MCP/tool allowlist и ослабление redaction.

## Контракты и зависимости

- Начинается только после завершения KAN-060.
- Используются существующие tool event mapping и history pagination.
- Технические детали доступны, но не раскрывают секреты или upstream credentials.

## Критерии приёмки

- [ ] По умолчанию видны только компактные сведения о вызове.
- [ ] Клавиатура и указатель раскрывают детали; доступно на mobile без hover.
- [ ] Длительность корректна для running и terminal состояний.
- [ ] Ошибки и повторные события не дублируют вызовы и не теряют вывод.
- [ ] Большой вывод не создаёт новый horizontal overflow.
- [ ] Unit/E2E и полный `pnpm check` зелёные.

## Проверки

- Focused OpenCode unit/integration и `e2e/opencode.spec.ts`.
- `pnpm --filter @kanbaner/opencode typecheck`.
- `pnpm check:imports` и `pnpm check`.

## Риски

- Группировка не должна смешивать вызовы разных этапов или одинаковые ID разных сессий.
- Длительность не должна постоянно расти после terminal события.

## Журнал

- 2026-11-23 — Задача создана по пункту 2 roadmap; ожидает KAN-060.

## Итог

Заполняется оркестратором после интеграции.
