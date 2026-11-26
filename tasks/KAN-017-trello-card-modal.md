---
id: KAN-017
title: Карточка задачи как Trello-модал
status: done
stage: 3
priority: high
owner: worker-kan-017
blocked_by: []
branch: feat/kan-017-trello-card-modal
worktree: .worktrees/kan-017-trello-card-modal
created: 2026-11-08
updated: 2026-11-08
specs:
  - specs/product-mvp.md
  - specs/plugin-contract.md
  - specs/technology-stack.md
---

# KAN-017 — Карточка задачи как Trello-модал

## Цель

Заменить десктопную боковую панель деталей канбана на большое центрированное
окно в стиле Trello: содержимое слева, действия справа. На мобильных сохранить
полноэкранный доступный dialog.

## Результат

- Карточка открывается поверх доски в окне примерно 760–860 px.
- Заголовок, проект и статус видны сверху.
- Слева — описание и подзадачи, справа — статус, приоритет, срок, теги,
  перемещение и удаление.
- Подзадачи отображаются списком со статусами и открываются по клику.
- На мобильных окно полноэкранное, с focus trap и восстановлением фокуса.

## Объём работ

- [x] Создать Trello-like модал на базе общего `ModalDialog`/`task-ui`, не
  дублируя внутренние модули task-list.
- [x] Разделить содержимое и действия на две колонки с адаптивным переходом в
  одну.
- [x] Реализовать редактирование заголовка и Markdown-описания через текущие
  формы и `expectedVersion`.
- [x] Показывать подзадачи, их статусы и создание подзадачи; переход между
  родителем и подзадачей не должен показывать устаревшие данные.
- [x] Сохранить `VERSION_CONFLICT`, подтверждение удаления, blocked loading и
  повторное чтение после команд.
- [x] Закрытие по `Escape`/кнопке/фону не должно молча терять несохранённый
  черновик.
- [x] Сохранить gating `/view/kanban`, selection и router-aware search.
- [x] Добавить component/E2E: desktop modal, mobile fullscreen, focus,
  редактирование, конфликт, подзадача, навигация parent/child, закрытие с
  черновиком.
- [x] Обновить README и отчёт `tasks/reports/KAN-017.md`.

## Владение файлами

Разрешено:

- `packages/plugin-kanban/**`;
- `packages/task-ui/**` — только additive общие примитивы;
- `apps/web/e2e/kanban.spec.ts`;
- `tasks/reports/KAN-017.md`.

Запрещено:

- kernel, SDK, storage, plugin-tasks, plugin-task-list, другие apps/specs/tasks.

## Контракты и зависимости

- Зависит от KAN-016.
- Использует существующие команды и запросы `kanbaner.tasks`.
- Новых доменных контрактов нет.
- Блокирует KAN-018.

## Критерии приёмки

- [x] Десктопная карточка открывается центрированным Trello-like модалом.
- [x] Мобильная версия полноэкранная и доступна с клавиатуры.
- [x] Подзадачи и действия работают через публичные операции.
- [x] Черновик и конфликты не теряются.
- [x] Все проверки и прежние E2E зелёные.

## Проверки

- [x] Typecheck, линтер, component/integration tests.
- [x] `pnpm check:imports`, полный `pnpm check`.
- [x] Все Playwright E2E, deferred SIGTERM.

## Риски

- Большой модал может дублировать форму списка. Смягчение: использовать общие
  компоненты task-ui.
- Переходы parent/child могут оставить stale state. Смягчение: привязка
  отображаемых данных к текущему ID и deferred-тесты.

## Журнал

- 2026-11-08 — KAN-017 влита в `dev` финальным merge-коммитом
  `90ae5d63e56c7ad6e7544eb9a60a468c589ee6b2`; strict install, check:imports,
  полный check, 54 E2E и deferred SIGTERM зелёные на ветке и `dev`, финальное
  ревью разрешило интеграцию. Feature-ветка и worktree удалены, задача done.
- 2026-11-08 — Задача создана вслед за Trello-обновлением доски.

## Итог

- Коммит: финальный merge `90ae5d63e56c7ad6e7544eb9a60a468c589ee6b2`;
  feature-коммиты `8a124c9`, `f4c0af1`, `4ba5c5b`, `ebf5022`, `ba93c70`.
- Ветка: `feat/kan-017-trello-card-modal` влита в `dev`; ветка и worktree удалены.
- Проверки: strict frozen install, `check:imports`, полный `pnpm check`,
  Playwright и deferred SIGTERM на ветке и `dev`; 11 focused files / 114 tests,
  85 workspace files / 1131 tests, 54 production E2E.
- Остаточные риски: Markdown показан как исходный текст; большие списки
  подзадач загружаются полностью; pixel-diff отсутствует; Chromium-only E2E и
  Windows не проверен. Первая попытка merge была откачена из-за flaky test,
  после `waitFor`-фикса и повторного rebase интеграция прошла.
