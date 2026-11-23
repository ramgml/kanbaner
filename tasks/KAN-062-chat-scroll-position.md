---
id: KAN-062
title: Прокрутка чата без потери позиции чтения
status: review
stage: 8
priority: high
owner: worker-kan-062
blocked_by: []
branch: feat/kan-062-chat-scroll-position
worktree: .worktrees/kan-062-chat-scroll-position
created: 2026-11-23
updated: 2026-11-23
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/roadmap.md
---

# KAN-062 — Прокрутка чата без потери позиции чтения

## Цель

Реализовать пункт 3 roadmap: streaming не должен выталкивать пользователя из
читаемого фрагмента, а возврат к новым сообщениям должен быть явным.

## Результат

- Автоследование работает только когда пользователь находится у нижней границы.
- При чтении выше позиция сохраняется и появляется кнопка «К новому сообщению».
- Переключение сессий, resize и восстановление истории не дают ложных скачков.

## Объём работ

- [ ] Добавить near-bottom detection и управление scroll anchoring.
- [ ] Реализовать доступную кнопку возврата и индикацию новых сообщений.
- [ ] Учесть streaming deltas, tool calls, картинки, resize и mobile viewport.
- [ ] Добавить unit/E2E regression-тесты и документацию.

## Владение файлами

Разрешено:

- `packages/opencode/src/ui.tsx`, `ui.test.tsx`;
- при необходимости отдельные модули `packages/opencode/src/*scroll*`;
- `packages/opencode/README.md`;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/product-mvp.md`, `specs/architecture.md`;
- `tasks/reports/KAN-062.md`.

Запрещено:

- изменения shell/sticky-sidebar, не связанные с прокруткой чата;
- ядро, доменные плагины, SQLite, новые зависимости и lock-файл;
- ослабление generation/abort semantics и canonical refresh.

## Контракты и зависимости

- Начинается только после KAN-061 и использует его compact tool calls.
- Новые browser APIs проверяются по актуальной документации и имеют fallback.

## Критерии приёмки

- [ ] У нижней границы streaming остаётся следуемым.
- [ ] При прокрутке вверх позиция не скачет от deltas/tool updates.
- [ ] Кнопка возврата доступна клавиатурой и прокручивает к актуальному концу.
- [ ] После явного возврата автоследование включается снова.
- [ ] Mobile/desktop и загрузка вложений не создают неуправляемый scroll jump.
- [ ] Unit/E2E и полный `pnpm check` зелёные.

## Проверки

- Focused UI unit и Playwright `e2e/opencode.spec.ts` на desktop/mobile.
- `pnpm --filter @kanbaner/opencode typecheck` и `pnpm check`.

## Риски

- ResizeObserver/изображения могут менять высоту после пользовательского scroll.
- Порог near-bottom не должен мешать ручному чтению.

## Журнал

- 2026-11-23 — Задача создана по пункту 3 roadmap; ожидала KAN-061.
- 2026-11-23 — KAN-061 завершена. Назначен `worker-kan-062`, создана ветка и
  worktree; статус `in_progress`. Виртуализация и сохранение scroll position
  между reload в срез не входят.
- 2026-11-23 — Worker реализовал near-bottom follow, кнопку возврата и dynamic
  height handling. Коммит `2da15f5`; focused unit 79/79, E2E 15/15, полный
  `pnpm check` — 140 files / 1950 tests.
- 2026-11-23 — Ревью нашло high: streaming commit мог опередить async scroll
  event и вернуть пользователя вниз. Также требуются исправления unread при
  сокращении history, recovery near-bottom после shrink и fallback `toggle`.
  Нативный scroll anchoring сохраняется: контракт — стабильность видимого
  фрагмента, а не неизменный числовой `scrollTop` при reflow выше viewport.
  Задача возвращена в `in_progress`.
- 2026-11-23 — Worker исправил замечания коммитами `fe7fd7a` и `1dd7658`.
  Финальное ревью не нашло blocker/high/medium/low. Focused tests 88/88,
  OpenCode E2E 17/17, полный `pnpm check` — 140 files / 1959 tests. Статус
  `review`.

## Итог

Заполняется оркестратором после интеграции.
