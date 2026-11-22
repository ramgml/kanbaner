---
id: KAN-058
title: Перенос входа в Обзор в настройки
status: in_progress
stage: 7
priority: low
owner: worker
blocked_by: []
branch: dev
worktree: .
created: 2026-11-22
updated: 2026-11-22
specs:
  - specs/product-mvp.md
  - specs/architecture.md
---

# KAN-058 — Перенос входа в Обзор в настройки

## Цель

Убрать редко используемый пункт «Обзор» из desktop sidebar и mobile bottom
navigation, сохранив доступ к странице через настройки.

## Решение

- `CORE_NAV_ITEMS` больше не содержит `/`; доменные navigation-вклады плагинов
  не изменяются.
- `/settings` содержит карточку «Обзор» с кнопкой «Открыть обзор» на `/`.
- Сам маршрут `/`, его содержимое и переход по логотипу не меняются; redirect и
  новый маршрут `/settings/overview` не вводятся.
- Настройки и plugin manager сохраняют прежнее поведение.

## Критерии приёмки

- [x] Desktop и mobile основная навигация не содержит ссылку «Обзор».
- [x] Из настроек страница `/` открывается клавиатурой и указателем.
- [x] Проекты, настройки, safe mode и мобильная навигация не регрессируют.
- [x] Unit/E2E и полный `pnpm check` зелёные.

## Ограничения

Работа ведётся в текущем checkout без worktree, commit, merge и push. Статус
остаётся `in_progress` до отдельной интеграции в `dev`.
