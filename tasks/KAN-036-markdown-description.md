---
id: KAN-036
title: Markdown в описании карточки и подсказке
status: done
stage: 3
priority: medium
owner: orchestrator
blocked_by: []
branch: dev
worktree: null
created: 2026-11-13
updated: 2026-11-13
specs:
  - specs/product-mvp.md
  - specs/technology-stack.md
---

# KAN-036 — Markdown в описании карточки и подсказке

## Цель

Показывать форматированное Markdown-описание в карточке и hover/focus
подсказке вместо исходного текста с маркерами.

## Результат

- Modal и tooltip используют общий безопасный Markdown-рендер.
- Поддерживаются CommonMark и GFM: заголовки, акценты, списки, задачи, ссылки,
  код, цитаты, таблицы, зачёркивание и изображения.
- Raw HTML не выполняется; URL проходит sanitization react-markdown; ссылки
  открываются в новой вкладке с безопасным `rel`.
- Textarea продолжает хранить и редактировать исходный Markdown.
- Клик по Markdown-ссылке не открывает редактор; клик по остальному описанию и
  клавиатурный Enter/F2 продолжают открывать его.

## Объём работ

- [x] Зафиксировать и установить react-markdown + remark-gfm.
- [x] Создать общий MarkdownContent и подключить modal/tooltip.
- [x] Сохранить доступное редактирование и безопасные ссылки.
- [x] Добавить component и production E2E проверки.
- [x] Обновить спецификации/README и создать отчёт без коммита.

## Владение файлами

- `packages/plugin-projects/package.json`, `pnpm-lock.yaml`;
- `scripts/check-import-boundaries.mjs` — allowlist Markdown-зависимостей;
- `packages/plugin-projects/src/ui/markdown-content.tsx`;
- `packages/plugin-projects/src/ui/card-description-tooltip.tsx`;
- `packages/plugin-projects/src/ui/task-modal.tsx`;
- `packages/plugin-projects/src/**/**test.tsx` — только Markdown-проверки;
- `apps/web/e2e/kanban.spec.ts` — Markdown-сценарий описания/tooltip;
- `specs/product-mvp.md`, `specs/technology-stack.md`;
- `README.md`, `packages/plugin-projects/README.md`;
- `tasks/KAN-036-markdown-description.md`, `tasks/reports/KAN-036.md`.

Запрещено: менять доменную схему/команды, включать rehype-raw или
`dangerouslySetInnerHTML`, переносить Markdown в ядро или менять поведение
списка `/view/tasks`.

## Критерии приёмки

- [x] Modal и tooltip показывают форматированный Markdown, а не маркеры.
- [x] Raw HTML и javascript URL не выполняются.
- [x] Ссылки не запускают inline-редактор, обычный клик/Enter его сохраняют.
- [x] Длинная подсказка прокручивается и не мешает DnD.
- [x] Проверки зелёные.

## Журнал

- 2026-11-13 — Задача создана и взята в работу оркестратором.
- 2026-11-13 — Результат закоммичен непосредственно в `dev`, задача завершена.

## Итог

- Коммит: `db150d3`; отдельный merge не требовался, работа велась в `dev`.
- Modal и tooltip используют общий CommonMark/GFM renderer с безопасными URL и
  отключённым raw HTML.
- Исходный Markdown в textarea и доменные контракты не изменены; ссылки не
  запускают inline-редактор.
- Проверки: 103 файла / 1467 тестов и 114 Playwright E2E — зелёные.
- Runtime ограничен Chromium; Windows и другие браузеры не проверялись. Push не
  выполнялся.
