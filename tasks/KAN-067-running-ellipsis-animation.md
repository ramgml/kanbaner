---
id: KAN-067
title: Анимация троеточия статуса «Выполняется»
status: review
stage: 8
priority: low
owner: worker-kan-067
blocked_by: []
branch: feat/kan-067-running-ellipsis-animation
worktree: .worktrees/kan-067-running-ellipsis-animation
created: 2026-11-25
updated: 2026-11-25
specs:
  - specs/product-mvp.md
  - specs/architecture.md
---

# KAN-067 — Анимация троеточия статуса «Выполняется»

## Цель

Сделать выполнение prompt визуально живым через спокойную последовательную
анимацию троеточия рядом со статусом «Выполняется».

## Результат

- Во время phase `running` отображаются три отдельные точки со ступенчатым
  pulse и стабильной шириной, без layout shift.
- Точки декоративны и не вызывают повторных объявлений live region.
- При `prefers-reduced-motion: reduce` анимация отключена, статус остаётся
  понятным.
- Остальные prompt phases и KAN-060–066 behavior не меняются.

## Объём работ

- [ ] Отделить визуальные точки от текстового статуса только для `running`.
- [ ] Добавить последовательную анимацию существующими Tailwind/CSS средствами
  без новых зависимостей.
- [ ] Добавить focused regression для трёх точек, aria-hidden, stable status и
  reduced-motion классов; при необходимости Playwright computed style.
- [ ] Обновить краткую UI-документацию и создать отчёт.

## Владение файлами

Разрешено:

- `packages/opencode/src/ui.tsx`, `ui.test.tsx`;
- `apps/web/e2e/opencode.spec.ts`;
- `packages/opencode/README.md`;
- `specs/product-mvp.md` только при необходимости;
- `tasks/reports/KAN-067.md`.

Запрещено:

- новые зависимости, отдельный animation runtime и глобальные CSS без нужды;
- изменение turn/admission/canonical outcome, текстов ошибок и других phases;
- файлы задач, roadmap, package/lock, notes/sticky и чужие worktree.

## Контракты и зависимости

- Статус остаётся в существующем `role=status` / `aria-live=polite`.
- Анимированный контейнер имеет `aria-hidden=true`; его текст/opacity не
  обновляется по таймеру React.
- Предпочтительны три заранее отрисованные точки, `animate-pulse`, staggered
  delay и `motion-reduce:animate-none`, чтобы не добавлять глобальные keyframes.
- Визуальная ширина троеточия стабильна на весь период анимации.

## Критерии приёмки

- [ ] `running` содержит «Выполняется» и ровно три декоративные точки.
- [ ] Точки имеют последовательные задержки и reduced-motion отключение.
- [ ] `connecting`, `finalizing`, `done`, `cancelled`, `error`, retry и ручная
  проверка статуса не изменились.
- [ ] Focused tests, OpenCode E2E и полный `pnpm check` зелёные.

## Проверки

- Focused `packages/opencode/src/ui.test.tsx`.
- `pnpm --filter @kanbaner/opencode typecheck` и web typecheck.
- `pnpm --filter @kanbaner/web test:e2e e2e/opencode.spec.ts`.
- `pnpm check:imports`, `pnpm test:sqlite`, `pnpm check`.
- Browser smoke анимации и reduced-motion выполняет оркестратор.

## Риски

- Tailwind должен увидеть произвольные delay-классы в исходнике пакета.
- Нельзя допустить layout shift или постоянные live-region announcements.

## Журнал

- 2026-11-25 — Задача создана по запросу пользователя; назначен
  `worker-kan-067`, статус `in_progress`.
- 2026-11-25 — Worker добавил staggered pulse и reduced-motion regression.
  Коммит `0967e58`; focused UI 110/110, OpenCode E2E 30/30, полный
  `pnpm check` зелёный. Статус `review`.

## Итог

Заполняется оркестратором после интеграции.
