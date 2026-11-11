---
id: KAN-027
title: Inline-редактирование карточки канбана
status: done
stage: 3
priority: high
owner: worker-kan-027
blocked_by: []
branch: feat/kan-027-inline-task-editing
worktree: .worktrees/kan-027-inline-task-editing
created: 2026-11-11
updated: 2026-11-11
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/technology-stack.md
---

# KAN-027 — Inline-редактирование карточки канбана

## Цель

Упростить модалку задачи канбана: убрать лишний переключатель представлений
и редактировать название с описанием непосредственно на своих местах.

## Результат

- Внутри модалки больше нет `Список / Канбан`; переключатель остаётся в шапке
  проекта.
- Кнопка «Редактировать» и полная `TaskForm` больше не заменяют содержимое
  модалки канбана.
- Название редактируется inline после двойного клика; описание — после
  двойного клика по его области.
- Touch и клавиатура имеют равнозначный способ открыть редактор.
- Существующие быстрые поля, подзадачи и защита черновиков сохраняются.

## Объём работ

### Inline-редакторы

- [x] Название: двойной клик desktop, одиночный tap touch, `Enter`/`F2` с
  клавиатуры; однострочное поле на месте заголовка, autofocus.
- [x] Описание: те же способы открытия; Markdown textarea, пустое состояние
  приглашает добавить описание, ненавязчивая подсказка о двойном клике.
- [x] Название сохраняется по `Enter` и кнопке; описание — по
  `Ctrl/Cmd+Enter` и кнопке. `Escape` и «Отмена» завершают только активный
  редактор и не закрывают модалку.
- [x] Нет autosave по blur. Одновременно активен один редактор; переключение
  полей не должно молча терять изменённый черновик.
- [x] Во время редактирования остальные секции остаются видимыми; старая
  полная форма и загрузка rootTasks только ради неё удаляются из overlay.

### Команды и состояние

- [x] Использовать существующую `task.update`: при сохранении отправлять только
  `title` или только `descriptionMarkdown`, id и expectedVersion, зафиксированный
  при начале редактирования.
- [x] Валидация пустого названия; trim по существующим правилам; описание может
  быть пустым. Не отправлять команду при неизменённом значении.
- [x] Сохранить busy/double-submit guard, ошибки без потери ввода, stale server
  refresh/VERSION_CONFLICT и запрет молчаливой перезаписи чужой правки.
- [x] Черновик активного поля участвует в общем dirty-close guard; X/backdrop/
  Escape модалки вне редактора не теряют ввод. Keep editing возвращает фокус в
  активное поле.
- [x] Смена задачи A→B, поздние ответы и сохранение другого quick-поля не
  переносят и не затирают черновик неправильно.

### Переключатель и документация

- [x] Удалить только `viewSwitch` из TaskOverlay/TaskModal; общий ViewToggle и
  его использование в ProjectHeader не менять.
- [x] Панель деталей `/view/tasks` и её полная форма не входят в объём.
- [x] Обновить `packages/plugin-projects/README.md` и создать отчёт.

## Владение файлами

Разрешено:

- `packages/plugin-projects/src/ui/task-modal.tsx`;
- `packages/plugin-projects/src/ui/task-overlay.tsx`;
- связанные тесты `packages/plugin-projects/**`;
- `apps/web/e2e/kanban.spec.ts`;
- `apps/web/e2e/task-list.spec.ts` — только адаптация сценариев, которые
  переключаются в изменённую модалку канбана;
- `packages/plugin-projects/README.md`;
- `tasks/reports/KAN-027.md`.

Запрещено:

- `packages/plugin-projects/src/task-list/**`;
- `packages/task-ui/**`, домен `plugin-tasks`, kernel, SDK, storage;
- спецификации, другие задачи, зависимости и публичные контракты.

## Контракты и зависимости

- Зависит от KAN-020…KAN-026.
- Используется существующий `kanbaner.tasks.task.update`; новых команд и
  событий нет.

## Критерии приёмки

- [x] В модалке нет переключателя представления и кнопки полного редактирования.
- [x] Название и описание независимо редактируются и сохраняются после reload.
- [x] Desktop double click, touch tap и клавиатура работают; mobile 360 не имеет
  горизонтального overflow.
- [x] Ошибки, конфликты, dirty close, focus и быстрые черновики не регрессируют.
- [x] Все проверки зелёные.

## Проверки

- [x] Strict frozen install, focused tests, check:imports и self-test.
- [x] Полный `pnpm check`.
- [x] Все Playwright после свежего build и deferred SIGTERM.

## Риски

- Нативный dialog обрабатывает Escape: событие активного поля не должно
  одновременно закрыть карточку. Смягчение: stopPropagation/preventDefault и
  component/E2E на оба уровня.
- Refresh после сохранения другого поля может сделать inline-session stale.
  Смягчение: captured expectedVersion, сохранение локального ввода и тесты
  out-of-order/refresh.

## Журнал

- 2026-11-11 — Влита в `dev` merge-коммитом
  `08d2debe82bb47c7fd17f52aee6ab6692b44e1da`. Финальное ревью разрешило
  интеграцию; повторные проверки на ветке и `dev` зелёные.
- 2026-11-11 — Поведение согласовано с пользователем.

## Итог

- Коммит: merge `08d2debe82bb47c7fd17f52aee6ab6692b44e1da`.
- Ветка: `feat/kan-027-inline-task-editing` влита, ветка и worktree удалены.
- Проверки: 96 файлов / 1352 теста, 98 production E2E, strict install,
  check:imports и deferred SIGTERM зелёные.
- Остаточные риски: Windows и браузеры кроме Chromium не проверялись; touch
  сценарии проверены через CDP Chromium.
