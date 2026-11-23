---
id: KAN-064
title: История и управление OpenCode-сессиями
status: backlog
stage: 8
priority: high
owner: unassigned
blocked_by: [KAN-063]
branch: null
worktree: null
created: 2026-11-23
updated: 2026-11-23
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

- [ ] Проверить live/типы `session.list` и правила заголовков на pinned client.
- [ ] Добавить whitelist gateway summary, pagination и ownership/project filtering.
- [ ] Добавить внутренний same-origin GET list transport; rename — только отдельной
  явной операцией, если входит в выбранную стратегию заголовков.
- [ ] Реализовать lazy history UI, переключение и ошибки 404/503 без автосоздания сессии.
- [ ] Сохранить generation/abort/canonical semantics и per-session drafts.
- [ ] Добавить unit/integration/E2E/live smoke и документацию.

## Владение файлами

Разрешено:

- `packages/opencode/src/types.ts`, `gateway.ts`, `ui.tsx` и связанные тесты;
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

## Критерии приёмки

- [ ] Список содержит только разрешённые top-level сессии текущего проекта.
- [ ] Выбор восстанавливает сообщения и черновик без смешивания streaming состояния.
- [ ] Reload восстанавливает последнюю выбранную сессию.
- [ ] 404 удаляет только недействительную запись; 503 не стирает last session ID.
- [ ] Нет N+1 без ограничения, бесконечной pagination или утечки metadata/location/cost.
- [ ] Keyboard/mobile, unit/integration/E2E и полный `pnpm check` зелёные.

## Проверки

- Focused gateway/http/UI tests и `e2e/opencode.spec.ts`.
- Безопасный live smoke с изолированным project/data environment.
- `pnpm check:imports`, `pnpm test:sqlite`, `pnpm check`.

## Риски

- Одинаковый `Kanbaner chat` title требует проверенной стратегии различимых названий.
- Stale list/switch response не должен перезаписать новую сессию.
- Переключение во время prompt должно безопасно применять abort/generation semantics.

## Журнал

- 2026-11-23 — Задача создана по пункту 5 roadmap; ожидает KAN-063.

## Итог

Заполняется оркестратором после интеграции.
