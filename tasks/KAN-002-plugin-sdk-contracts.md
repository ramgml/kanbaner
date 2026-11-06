---
id: KAN-002
title: Контракты Plugin SDK
status: done
stage: 1
priority: high
owner: worker-kan-002
blocked_by: []
branch: feat/kan-002-plugin-sdk-contracts
worktree: .worktrees/kan-002-plugin-sdk-contracts
created: 2026-11-06
updated: 2026-11-06
specs:
  - specs/technology-stack.md
  - specs/plugin-contract.md
  - specs/architecture.md
---

# KAN-002 — Контракты Plugin SDK

## Цель

Реализовать публичные типы, схемы и валидаторы Plugin Contract v1, не зависящие от внутренностей ядра.

## Результат

Плагин может импортировать `@kanbaner/plugin-sdk`, описать манифест, команду, запрос, событие, ресурс и UI-вклад, а также получить типизированный контекст выполнения.

## Объём работ

- [x] Определить типы Plugin ID, версий и манифеста.
- [x] Добавить валидацию манифеста.
- [x] Определить метаданные команд и запросов.
- [x] Определить JSON Schema-поля входа и выхода.
- [x] Использовать TypeBox 0.34 как источник типов и JSON Schema.
- [x] Использовать Ajv 8.20 для runtime-валидации.
- [x] Определить метаданные событий и подписок.
- [x] Реализовать разбор и валидацию `ResourceRef`.
- [x] Определить типы `relation` и операций связей.
- [x] Определить контекст выполнения.
- [x] Определить единый конверт результата и коды ошибок.
- [x] Определить метаданные экспорта в HTTP и MCP.
- [x] Определить типы UI-вкладов без React-зависимости.
- [x] Экспортировать публичные точки входа пакета.
- [x] Добавить unit-тесты валидных и невалидных контрактов.

## Владение файлами

Разрешено:

- `packages/plugin-sdk/**`.

Запрещено:

- `packages/kernel/**`;
- `apps/web/**`;
- `specs/**`;
- `tasks/**`, кроме собственного отчёта;
- реализация runtime, БД или React-компонентов.

Общие файлы:

- Корневой `package.json` и lock-файл изменяются только по координации с оркестратором.

## Контракты и зависимости

- Реализует типы из `specs/plugin-contract.md`.
- Использует TypeBox 0.34 и Ajv 8.20 согласно `specs/technology-stack.md`.
- Не зависит от `@kanbaner/kernel`.
- Может использовать небольшую библиотеку JSON Schema-валидации после проверки документации.
- Не фиксирует поведение конкретного плагина.

## Критерии приёмки

- [x] Манифест без обязательного поля отклоняется с понятной ошибкой.
- [x] Некорректный Plugin ID отклоняется.
- [x] `ResourceRef` корректно разбирается и отвергает неверный формат.
- [x] Метаданные команды и запроса различают mutation и query.
- [x] Экспорт по умолчанию выключен.
- [x] Ошибки содержат стабильный код и признак `retryable`.
- [x] JSON Schema генерируется из TypeBox без ручного дублирования.
- [x] Ajv валидирует команды, запросы и ответы по сгенерированным схемам.
- [x] Публичный API SDK не импортирует код ядра.
- [x] Пакет собирается как самостоятельный модуль.
- [x] Тесты покрывают успешные и ошибочные сценарии.

## Проверки

- [x] Typecheck.
- [x] Линтер.
- [x] Unit-тесты пакета.
- [x] Проверка экспортов пакета.
- [x] Проверка отсутствия импортов из `kernel` и `apps`.

## Риски

- Слишком широкий SDK до появления реальных плагинов. Реализовать только Contract v1.
- Дублирование JSON Schema и TypeScript-типов. Использовать TypeBox как единый источник и Ajv для runtime-проверки.
- Связать SDK с фреймворком UI. Держать типы UI-вкладов независимыми от React.

## Журнал

- 2026-11-06 — KAN-002 влита в `dev` merge-коммитом `e513399f3c247dfd8fd754e28d2b76eb9a11ba3b`; merge queue и runtime import на `dev` зелёные, финальное ревью разрешило интеграцию. Feature-ветка и worktree удалены, задача переведена в done.
- 2026-11-06 — Worker коммитом `a209cf0` перенёс JSON boundary-guard на общую границу `validateWithSchema` и `createSchemaValidator`; добавлены регрессии для generic API и циклических/non-plain metadata. 85 focused-тестов и 89 тестов workspace, полный check и runtime import зелёные. Задача переведена в review.
- 2026-11-06 — Повторное ревью подтвердило исправления 2 и 4–9, но нашло обход JSON boundary-guard через generic API и циклические/non-plain `inputSchema`/`outputSchema`. Требуется единая проверка на границе всех публичных JSON Schema-валидаторов; задача возвращена worker-у.
- 2026-11-06 — Worker коммитом `9acbbba` устранил все 9 замечаний ревью и дополнительный конфликт `$id` в схеме результата; 82 focused-теста и 86 тестов workspace, полный `pnpm check`, runtime import и strict install зелёные. Задача повторно переведена в review.
- 2026-11-06 — Независимое ревью нашло проблемы глубокой JSON-валидации, обработки `format`, проверки плагинных схем, типизации generic-валидаторов, SemVer range, `ResourceService.resolve` и мелкие несогласованности. Задача возвращена worker-у. Оркестратор согласовал `ajv-formats@3.0.1`, `semver@7.8.6` и `@types/semver@7.8.0`; стек обновлён коммитом `e8233c5`, изменение lock-файла разрешено.
- 2026-11-06 — Worker завершил Plugin Contract v1 коммитами `66f5480` и `ab25d03`; 55 focused-тестов и 59 тестов workspace, strict install, lint, typecheck, build и runtime import зелёные. Создан `tasks/reports/KAN-002.md`, задача переведена в review.
- 2026-11-06 — KAN-001 завершена, зависимость закрыта. Оркестратор подтвердил готовность задачи, назначил worker-kan-002, ветку `feat/kan-002-plugin-sdk-contracts` и worktree `.worktrees/kan-002-plugin-sdk-contracts`; обновление lock-файла для TypeBox/Ajv согласовано без изменения корневого `package.json`.
- 2026-11-06 — Задача создана.
- 2026-11-06 — Зафиксированы TypeBox и Ajv согласно `specs/technology-stack.md`.

## Итог

- Коммит: merge `e513399f3c247dfd8fd754e28d2b76eb9a11ba3b`; финальные feature-коммиты `13e2e8a`, `eaf2f91`, `4a16ea2`, `036d76c`.
- Ветка: `feat/kan-002-plugin-sdk-contracts` влита в `dev`; ветка и worktree удалены после успеха.
- Проверки: strict frozen install без unmet peers, полный `pnpm check`, 7 focused test files / 85 tests и 11 workspace test files / 89 tests, production build, runtime import, declarations и границы импортов зелёные. Три независимых ревью завершены разрешением на интеграцию.
- Остаточные риски: Windows не проверен; runtime, Storage Provider, HTTP и MCP относятся к следующим задачам; внешние `$ref` не поддерживаются, схемы должны быть самодостаточными; `eslint@9.39.x` остаётся разрешённым временным deprecated-исключением.
