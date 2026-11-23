---
id: KAN-061
title: Компактное представление tool calls
status: review
stage: 8
priority: high
owner: worker-kan-061
blocked_by: []
branch: feat/kan-061-compact-tool-calls
worktree: .worktrees/kan-061-compact-tool-calls
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
- `packages/opencode/src/tool-call.tsx` и связанные focused-тесты;
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

- 2026-11-23 — Задача создана по пункту 2 roadmap; ожидала KAN-060.
- 2026-11-23 — KAN-060 завершена. Назначен `worker-kan-061`, создана ветка и
  worktree; статус `in_progress`. Группировка вызовов в минимальный срез не
  входит, поскольку roadmap делает её опциональной.
- 2026-11-23 — Worker реализовал compact disclosure, duration и canonical
  timings. Коммит `4fb90ff`; gateway 45/45, UI 57/57, E2E 13/13, полный
  `pnpm check` — 139 files / 1927 tests.
- 2026-11-23 — Ревью нашло high: terminal одного prompt завершал tools других
  ходов и non-admission мог изменить старый running tool. Также требуются
  aborted streaming normalization, representative v1 fixture и `aria-live=off`
  для ticking duration. Задача возвращена в `in_progress`; новый
  `tool-call.tsx` явно добавлен во владение.
- 2026-11-23 — Worker исправил замечания коммитами `1ec5d9a` и `306764a`.
  Финальное ревью не нашло blocker/high/medium/low. Focused tests 111/111,
  OpenCode E2E 13/13, полный `pnpm check` — 139 files / 1936 tests. Статус
  `review`.

## Итог

Заполняется оркестратором после интеграции.
