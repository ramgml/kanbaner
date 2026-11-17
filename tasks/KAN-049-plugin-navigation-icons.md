---
id: KAN-049
title: Иконки навигации плагинов
status: done
stage: 1
priority: medium
owner: opencode-worker
blocked_by: []
branch: feat/kan-049-plugin-navigation-icons
worktree: .worktrees/kan-049-plugin-navigation-icons
created: 2026-11-17
updated: 2026-11-17
specs:
  - specs/plugin-contract.md
  - specs/technology-stack.md
---

# KAN-049 — Иконки навигации плагинов

## Цель

Убрать одинаковый флаг у всех плагинов и дать заметкам и проектам узнаваемые разные значки.

## Результат

Navigation-вклад может декларировать иконку через сериализуемые metadata. Shell отображает её на desktop и mobile, а для старых или неизвестных значений сохраняет безопасный fallback.

## Объём работ

- [x] Добавить совместимое необязательное поле иконки в Plugin SDK и учесть его в registry.
- [x] Настроить отдельные Lucide-иконки для notes и projects.
- [x] Добавить unit-тесты metadata, registry и shell.
- [x] Обновить описание UI-контракта.

## Владение файлами

Разрешено:

- `packages/plugin-sdk/src/ui.ts` и его тесты;
- `apps/web/src/ui/registry.ts` и его тесты;
- `apps/web/src/components/shell/shell-nav.tsx`, `nav-items.ts` и их тесты;
- `packages/plugin-notes/src/metadata.ts` и тесты metadata;
- `packages/plugin-projects/src/metadata.ts`, `registration.test.ts`;
- `specs/plugin-contract.md`;
- `tasks/reports/KAN-049.md`.

Запрещено:

- доменная логика, хранение и API;
- новые зависимости и другая icon library.

## Контракты и зависимости

Добавление необязательного `icon` совместимо с Plugin Contract v1. SDK не должен зависеть от React или Lucide: metadata содержит строковый идентификатор, а shell сопоставляет его с компонентом из Lucide.

## Критерии приёмки

- [x] Заметки и проекты имеют разные иконки в desktop и mobile navigation.
- [x] Плагин без `icon` получает прежний fallback.
- [x] Изменение `icon` учитывается при синхронизации metadata.
- [x] Типы, линтер и тесты зелёные.

## Проверки

- `pnpm check`;
- релевантные tests SDK, web, notes, projects;
- при возможности browser smoke обеих navigation.

## Журнал

- 2026-11-17 — Задача создана по запросу пользователя.
- 2026-11-17 — Notes получил `notebook-tabs`, Projects — `folder-kanban`; SDK принимает необязательный `icon`, shell использует статический Map и fallback. Ревью выявило prototype lookup и рассинхрон whitespace-валидации; обе проблемы исправлены. Ветка влита в `dev`.

## Итог

- Коммит: worker `5789cbd`, fix `c1da614`, merge `9b1b66f031055b9e55b5c0add4e6007bc4115e86`.
- Проверки: `pnpm check` 1695 тестов и production build; shell E2E 4/4; browser smoke desktop/mobile. Push не выполнялся.
