---
id: KAN-038
title: Блочный BlockNote-редактор заметок
status: done
stage: 1
priority: high
owner: opencode-worker
blocked_by: []
branch: feat/kan-038-blocknote-editor
worktree: .worktrees/kan-038-blocknote-editor
created: 2026-11-14
updated: 2026-11-14
specs:
  - specs/product-mvp.md
  - specs/technology-stack.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-038 — Блочный BlockNote-редактор заметок

## Цель

Перенести UX блочного редактора Orenda в плагин заметок, сохранив canonical Markdown и существующие публичные контракты.

## Результат

Пользователь редактирует заметку как дерево блоков со slash-меню, side menu, drag handle и formatting toolbar. Автосохранение, вложения, поиск, экспорт, HTTP API и MCP продолжают работать без миграции данных.

## Объём работ

- [x] Заменить Milkdown на BlockNote с shadcn-вариантом UI.
- [x] Сохранить Markdown round-trip, включая GFM и локальные изображения.
- [x] Сохранить автосохранение, expectedVersion, readOnly/disabled и мобильную доступность.
- [x] Обновить unit/E2E-тесты и документацию.
- [x] Удалить неиспользуемый Milkdown-код и зависимости.

## Владение файлами

Разрешено:

- `packages/plugin-notes/**`
- `apps/web/src/app/globals.css`
- `apps/web/e2e/notes.spec.ts`
- `specs/product-mvp.md`
- `specs/technology-stack.md`
- `specs/architecture.md`
- `specs/plugin-contract.md`
- `pnpm-lock.yaml`
- `tasks/reports/KAN-038.md`

Запрещено:

- доменные модели, команды, запросы и схемы данных других плагинов;
- `tasks/KAN-038-blocknote-editor.md`;
- изменения публичного API заметок и переход на persisted block storage.

Общие файлы:

- `packages/plugin-notes/package.json` и `pnpm-lock.yaml` принадлежат этой задаче.

## Контракты и зависимости

- `contentMarkdown`, `note.update`, `expectedVersion` и attachment commands не изменяются.
- BlockNote используется только как UI-представление Markdown.
- Использовать `@blocknote/core`, `@blocknote/react`, `@blocknote/shadcn` одной версии 0.54.x.
- Не добавлять Mantine или вторую component library.

## Критерии приёмки

- [x] Стандартные меню блоков, slash-меню и formatting toolbar доступны.
- [x] Markdown не теряет заголовки, форматирование, списки, чекбоксы, таблицы, код, ссылки и изображения.
- [x] Инициализация и внешнее обновление не вызывают ложное автосохранение.
- [x] Изображения сохраняются через существующий attachment flow.
- [x] Основные действия доступны с клавиатуры и на мобильном viewport.
- [x] Тесты и проверки зелёные, границы импортов соблюдены.

## Проверки

- [x] `pnpm --filter @kanbaner/plugin-notes typecheck`
- [x] Релевантные unit/integration-тесты заметок.
- [x] `pnpm check:imports`
- [x] `pnpm check`
- [x] `pnpm --filter @kanbaner/web exec playwright test e2e/notes.spec.ts`

## Риски

- Markdown-сериализация BlockNote нормализует синтаксис и может терять отдельные конструкции; round-trip-тесты обязательны.
- Generic-типы BlockNote 0.54 несовместимы с `exactOptionalPropertyTypes`; локальный adapter типов не должен распространяться на домен.

## Журнал

- 2026-11-14 — Задача создана; начальная реализация перенесена из основного checkout в выделенный worktree и передана OpenCode worker.
- 2026-11-14 — Worker реализовал редактор; независимое ревью выявило потери Markdown и гонки upload, исправленные follow-up коммитами. Повторное ревью разрешило merge.
- 2026-11-14 — Ветка интегрирована в `dev` через merge queue; `pnpm check` на `dev` зелёный, worktree и feature-ветка удалены.

## Итог

- Коммит: merge `2b322aa4f16d2fc88e31d1c7fb5b688f73c1a95f`; рабочие коммиты `a5a30e4`, `261f6d3`, `d2d7b13`, `9c5358d`.
- Ветка: `feat/kan-038-blocknote-editor` → `dev`.
- Проверки: `pnpm check` на `dev`; notes unit 114/114; notes E2E 9/9; `pnpm check:imports`; typecheck.
- Остаточные риски: BlockNote нормализует Markdown и alt/URL; pending image не входит в промежуточные автосохранения; реальный DnD блоков не автоматизирован; проверено в Chromium/Linux, Windows и другие браузеры отдельно не запускались. Push не выполнялся.
