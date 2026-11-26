---
id: KAN-030
title: Цвета проекта и колонок в домене
status: done
stage: 3
priority: high
owner: worker-kan-030
blocked_by: []
branch: feat/kan-030-board-column-colors-domain
worktree: /home/aero/.herdr/worktrees/kanbaner/feat-kan-030-board-column-colors-domain
created: 2026-11-12
updated: 2026-11-12
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-030 — Цвета проекта и колонок в домене

## Цель

Сохранять выбранный цвет доски и каждой колонки в публичном доменном контракте,
не добавляя отдельное поле цвета задаче.

## Результат

- `Project` и `TaskColumn` поддерживают optional `color` из общей палитры.
- Проект и колонку можно создать и обновить с цветом через существующие команды.
- Color-only `column.update` не меняет заголовок; пустой update отклоняется.
- Старые документы без поля остаются валидными и получают стандартное оформление
  в UI.

## Объём работ

- [x] Добавить `BOARD_COLORS`/`BoardColor` и TypeBox-схему со значениями
  `default`, `slate`, `blue`, `green`, `yellow`, `orange`, `red`, `purple`.
- [x] Добавить optional `color` в модели и входы `project.create|update`,
  `column.create|update`; сделать `title` в `column.update` необязательным при
  обязательном наличии хотя бы одного изменяемого поля.
- [x] Сохранять цвет через backend-neutral Store без SQL и новых таблиц.
- [x] Проверить версии, changed-поля, события после коммита и no-op поведение.
- [x] Добавить schema/store/activation/contract/conformance-тесты.
- [x] Актуализировать `packages/plugin-tasks/README.md` и создать отчёт.

## Владение файлами

Разрешено:

- `packages/plugin-tasks/**`;
- `tasks/reports/KAN-030.md`.

Запрещено:

- `packages/plugin-projects/**`, `apps/web/**`;
- kernel, SDK и Storage Provider;
- `package.json`, lock-файл;
- файлы задач и чужие отчёты.

Общие спецификации уже обновлены оркестратором в KAN-029; изменение их смысла
требует остановки и согласования.

## Контракты и зависимости

- Пользователь одобрил совместимое расширение публичных моделей и команд.
- SQLite-миграция не требуется: поле находится внутри JSON-документа.
- Отсутствие `color` эквивалентно `default` только на уровне представления;
  обязательного read-backfill нет.
- Произвольные HEX/CSS-значения запрещены схемой.

## Критерии приёмки

- [x] Все значения палитры проходят создание и обновление проекта/колонки.
- [x] Произвольный цвет и update без полей получают validation error до записи.
- [x] Color-only update сохраняет title и повышает версию только при изменении.
- [x] Документы прежней схемы читаются без миграции.
- [x] SQLite и in-memory conformance зелёные.

## Проверки

- [x] Focused domain tests и typecheck пакета.
- [x] `pnpm test:sqlite` и релевантные conformance-тесты.
- [x] Полный `pnpm check` перед коммитом.

## Риски

- Ослабление обязательного `title` в `column.update` может пропустить пустой
  patch; требуется доменная проверка хотя бы одного поля.

## Журнал

- 2026-11-12 — Задача создана после согласования цветовой модели.
- 2026-11-12 — Назначены worker и worktree, задача взята в работу.
- 2026-11-12 — Коммит `3d8d3ec`, проверки зелёные, задача переведена в review.

## Итог

- Коммиты: `3d8d3ec`, `b3fc3fe`; merge `143ef30`.
- Проверки: полный `pnpm check` на ветке и `dev`, 100 файлов / 1434 теста;
  command-level activation 14/14, conformance 156/156, check:imports и SQLite.
- Независимое ревью: функциональных проблем нет; замечание о command-level
  покрытии устранено до merge.
- Worktree и ветка удалены. Push не выполнялся: remote не настроен.
- Остаточные риски: Windows и браузеры кроме Chromium не проверялись.
