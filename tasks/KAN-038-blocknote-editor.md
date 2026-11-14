---
id: KAN-038
title: Блочный BlockNote-редактор заметок
status: review
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

- [ ] Заменить Milkdown на BlockNote с shadcn-вариантом UI.
- [ ] Сохранить Markdown round-trip, включая GFM и локальные изображения.
- [ ] Сохранить автосохранение, expectedVersion, readOnly/disabled и мобильную доступность.
- [ ] Обновить unit/E2E-тесты и документацию.
- [ ] Удалить неиспользуемый Milkdown-код и зависимости.

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

- [ ] Стандартные меню блоков, slash-меню и formatting toolbar доступны.
- [ ] Markdown не теряет заголовки, форматирование, списки, чекбоксы, таблицы, код, ссылки и изображения.
- [ ] Инициализация и внешнее обновление не вызывают ложное автосохранение.
- [ ] Изображения сохраняются через существующий attachment flow.
- [ ] Основные действия доступны с клавиатуры и на мобильном viewport.
- [ ] Тесты и проверки зелёные, границы импортов соблюдены.

## Проверки

- [ ] `pnpm --filter @kanbaner/plugin-notes typecheck`
- [ ] Релевантные unit/integration-тесты заметок.
- [ ] `pnpm check:imports`
- [ ] `pnpm check`
- [ ] `pnpm --filter @kanbaner/web test:e2e -- e2e/notes.spec.ts`

## Риски

- Markdown-сериализация BlockNote нормализует синтаксис и может терять отдельные конструкции; round-trip-тесты обязательны.
- Generic-типы BlockNote 0.54 несовместимы с `exactOptionalPropertyTypes`; локальный adapter типов не должен распространяться на домен.

## Журнал

- 2026-11-14 — Задача создана; начальная реализация перенесена из основного checkout в выделенный worktree и передана OpenCode worker.

## Итог

Заполняется оркестратором после интеграции:

- Коммит:
- Ветка:
- Проверки:
- Остаточные риски:
