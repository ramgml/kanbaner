---
id: KAN-048
title: Исправить CSS resize sidebar
status: in_progress
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

- [ ] Заменить проблемную arbitrary value запись на валидный arbitrary property или inline CSS.
- [ ] Проверить отсутствие `var(...)` в сгенерированном CSS.
- [ ] Прогнать dev smoke и существующие resize проверки.

## Владение файлами

Разрешено:
- `packages/plugin-notes/src/ui/notes-view.tsx` и тесты;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-048.md`.

Запрещено:
- изменение resize hook, домена и других компонентов без необходимости.

## Критерии приёмки

- [ ] `pnpm dev` открывает notes без CSS Build Error.
- [ ] Production build и resize E2E зелёные.
- [ ] Сгенерированный CSS не содержит `width: var(...)`.

## Журнал

- 2026-11-16 — Задача создана по Build Error пользователя.

## Итог

- Коммит:
- Проверки:
