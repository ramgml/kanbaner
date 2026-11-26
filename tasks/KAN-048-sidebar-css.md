---
id: KAN-048
title: Исправить CSS resize sidebar
status: done
stage: 1
priority: high
owner: opencode-worker
blocked_by: []
branch: fix/kan-048-sidebar-css
worktree: .worktrees/kan-048-sidebar-css
created: 2026-11-16
updated: 2026-11-16
specs:
  - specs/technology-stack.md
---

# KAN-048 — Исправить CSS resize sidebar

## Цель

Dev server падает при парсинге `width: var(...)` из-за Tailwind-класса `lg:w-[var(--note-sidebar-width)]`.

## Результат

PostCSS/Turbopack генерирует валидный CSS, sidebar продолжает менять ширину во всех проверенных режимах.

## Объём работ

- [x] Заменить проблемную arbitrary value запись на валидный arbitrary property или inline CSS.
- [x] Проверить отсутствие `var(...)` в сгенерированном CSS.
- [x] Прогнать dev smoke и существующие resize проверки.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/notes-view.tsx` и тесты;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-048.md`.

Запрещено:
- изменение resize hook, домена и других компонентов без необходимости.

## Критерии приёмки

- [x] `pnpm dev` открывает notes без CSS Build Error.
- [x] Production build и resize E2E зелёные.
- [x] Сгенерированный CSS не содержит `width: var(...)`.

## Журнал

- 2026-11-16 — Задача создана по Build Error пользователя.
- 2026-11-16 — Причина устранена: Tailwind сканировал комментарий `lg:w-[var(...)]` и генерировал `width: var(...)`; комментарий исправлен, класс переведён на arbitrary property. Dev smoke и E2E зелёные, ветка влита в `dev`.

## Итог

- Коммит: worker `f116cec`, merge `b87b4284913973511e4164435a185c76fd9a996b`.
- Проверки: dev `/view/notes` 200 без CSS error, `pnpm check` 1686 тестов, resize E2E 16/16, production CSS без `var(...)`. Push не выполнялся.
