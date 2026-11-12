---
id: KAN-031
title: Меню колонки, inline-редакторы и иконки
status: in_progress
stage: 3
priority: high
owner: worker-kan-031
blocked_by: []
branch: feat/kan-031-board-usability-icons
worktree: .worktrees/kan-031-board-usability-icons
created: 2026-11-12
updated: 2026-11-12
specs:
  - specs/product-mvp.md
  - specs/technology-stack.md
  - specs/architecture.md
---

# KAN-031 — Меню колонки, inline-редакторы и иконки

## Цель

Завершить согласованные UX-правки: предсказуемо закрывать меню колонки, убрать
лишние кнопки редакторов и применить единый набор Lucide-иконок.

## Результат

- Меню колонки закрывается снаружи, по Escape и после действия.
- У title/description нет кнопок Save/Cancel; остаются autosave и Escape.
- Основные действия канбана и модала используют Lucide без потери доступных имён.
- Текущие незакоммиченные UX-изменения сохранены как исходная база задачи.

## Объём работ

### Уже реализовано в исходной базе

- [x] Одинарный клик и auto-resize title/description.
- [x] Автосохранение по pointerdown/blur вне редактора без double-submit.
- [x] Перенос по выбору target, нижняя bulk-панель, checkbox 16/label 20.

### Осталось

- [ ] Добавить outside/Escape/action close для `<details>` меню колонки без
  вмешательства в DnD и фокус следующего контрола.
- [ ] Удалить Save/Cancel у обоих редакторов; title сохраняет Enter, description
  — Ctrl/Cmd+Enter, оба сохраняют кликом снаружи, Escape отменяет.
- [ ] Обновить подсказки и focus/close guard тесты под отсутствие кнопок.
- [ ] Подключить `lucide-react@1.70.0` к `plugin-projects`, обновить lock-файл
  обычной pnpm-установкой без force/legacy-peer-deps.
- [ ] Заменить текстовые символы на согласованные иконки для create/settings/
  menus/drag/rename/move/delete/save/cancel/close/priority/due/tags/subtasks.
  Удалённые кнопки inline Save/Cancel иконками не заменять.
- [ ] Сохранить текст основных действий и accessible names icon-only кнопок.
- [ ] Обновить `packages/plugin-projects/README.md`, component/E2E и отчёт.

## Владение файлами

Разрешено:

- `packages/plugin-projects/**`;
- `apps/web/e2e/kanban.spec.ts`;
- `pnpm-lock.yaml` — только регистрация существующего `lucide-react` в пакете;
- `tasks/reports/KAN-031.md`.

Запрещено:

- `packages/plugin-tasks/**` и другие плагины;
- спецификации и файлы задач;
- панель деталей `/view/tasks`;
- корневой `package.json` и чужие отчёты.

## Контракты и зависимости

- Используется существующий `task.update`; новых доменных команд нет.
- Lucide уже зафиксирован в `specs/technology-stack.md`.
- KAN-032 выполняется после этой задачи в тех же UI-файлах.

## Критерии приёмки

- [ ] Клик по свободному месту и Escape закрывают меню в реальном Chromium.
- [ ] Выбор действия не оставляет меню открытым.
- [ ] Заголовок и описание сохраняются снаружи без видимых Save/Cancel.
- [ ] Escape по-прежнему отменяет только активный редактор.
- [ ] Иконки не меняют hit targets, keyboard/touch и mobile overflow.
- [ ] Все проверки зелёные.

## Проверки

- [ ] Focused component tests и typecheck пакета.
- [ ] Strict frozen install без unmet peers.
- [ ] Полный `pnpm check` и `pnpm --filter @kanbaner/web test:e2e`.

## Риски

- Нативный `<details>` не закрывается сам; обработчик document не должен
  перехватывать событие или возвращать фокус при обычном outside click.

## Журнал

- 2026-11-12 — Задача создана; исходная UX-база зафиксирована коммитом `6d57cf2`.
- 2026-11-12 — Назначены worker и worktree, задача взята в работу.

## Итог

Заполняется оркестратором после интеграции.
