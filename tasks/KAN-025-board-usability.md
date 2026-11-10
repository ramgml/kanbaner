---
id: KAN-025
title: Настройки доски и удобство карточек
status: in_progress
stage: 3
priority: high
owner: worker-kan-025
blocked_by: []
branch: feat/kan-025-board-usability
worktree: .worktrees/kan-025-board-usability
created: 2026-11-10
updated: 2026-11-10
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/technology-stack.md
---

# KAN-025 — Настройки доски и удобство карточек

## Цель

Собрать настройки проекта и колонок в одном месте и устранить UX-дефекты
карточек и ширины канбана.

## Результат

- В канбане и списке вместо «Переименовать» действие «Настроить».
- Модалка «Настройки доски» редактирует название проекта, названия и порядок
  колонок через существующие операции.
- Карточку можно перетаскивать за любую неинтерактивную область.
- Меню карточки плавающее и не изменяет её высоту.
- Desktop-колонки имеют фиксированную ширину 288 px и не растягиваются на экран.

## Объём работ

### Настройки доски

- [ ] Общая кнопка «Настроить» в ProjectHeader для канбана и списка.
- [ ] Модалка: название проекта с независимым сохранением; список колонок с
  редактированием названий, drag reorder и кнопками вверх/вниз; «Готово».
- [ ] Использовать `project.update`, `column.update`, `column.move`; новых
  доменных операций и пакетного частичного сохранения нет.
- [ ] Сохранить expectedVersion, pending per action, awaited refresh, conflict
  retry, ошибки без потери ввода и actual project guards.
- [ ] Создание/удаление/тип колонок не дублировать в модалке.
- [ ] Dirty-close confirm, focus/Escape, selected task и другие формы не
  закрываются вместе с модалкой; mobile 360 px.

### Drag карточки за любую область

- [ ] Pointer down на неинтерактивной области article, desktop threshold 6–8 px.
- [ ] Клик открывает карточку; после drag click подавляется.
- [ ] Игнорировать buttons/links/inputs/selects/contenteditable и выделение
  текста. Меню и ручка не должны быть единственным способом drag.
- [ ] Mobile long-press 200–250 ms без поломки вертикального scroll.
- [ ] Сохранить top/between/append, cleanup при project switch/unmount и меню
  «Переместить в…» как альтернативу.

### Меню и ширина

- [ ] Меню карточки через portal/fixed overlay от кнопки, flip вверх при нехватке
  места, viewport clamp, outside/Escape/focus return, одно открытое меню.
- [ ] Меню не растягивает карточку и не обрезается scroll-контейнером; scroll
  reposition или close.
- [ ] Desktop columns `flex: 0 0 288px`, left aligned; add-column не растягивается;
  многоколоночный horizontal scroll и mobile 85vw сохраняются.

### Тесты и документация

- [ ] Component: settings operations/conflicts/dirty close, card drag threshold/
  exclusions/click suppression/touch, popover geometry и fixed widths.
- [ ] E2E: настройки из канбана/списка, rename/reorder persistence, drag из
  title/tags/padding, menu rect не меняет card, viewport edges, desktop resize,
  mobile 360, прежние DnD/CRUD.
- [ ] README и `tasks/reports/KAN-025.md`.

## Владение файлами

Разрешено:

- `packages/plugin-projects/**`;
- `packages/task-ui/**` только общие UI-примитивы при необходимости;
- `apps/web/e2e/**` связанные сценарии;
- `tasks/reports/KAN-025.md`.

Запрещено:

- домен `plugin-tasks`, kernel, SDK, storage, спецификации и другие задачи;
- новые зависимости и изменение публичных контрактов.

## Контракты и зависимости

- Зависит от KAN-022…KAN-024.
- Используются только существующие публичные команды и запросы.

## Критерии приёмки

- [ ] Настройки доступны в обоих представлениях и сохраняют данные после reload.
- [ ] Drag работает за неинтерактивные области и не мешает кликам/scroll.
- [ ] Меню не меняет card layout и остаётся в viewport.
- [ ] Колонки не растягиваются при resize широкого экрана.
- [ ] Все проверки зелёные.

## Проверки

- [ ] Strict frozen install, check:imports и self-test.
- [ ] Полный `pnpm check`.
- [ ] Все Playwright и deferred SIGTERM.

## Риски

- Unified pointer handling может повредить click/scroll. Смягчение: threshold,
  interactive exclusions, touch long-press и реальные pointer E2E.
- Несколько независимых сохранений в модалке могут конфликтовать. Смягчение:
  per-action pending, awaited refresh и актуальные версии.

## Журнал

- 2026-11-10 — Требования согласованы с пользователем.

## Итог

Заполняется оркестратором после интеграции.
