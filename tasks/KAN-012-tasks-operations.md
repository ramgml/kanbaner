---
id: KAN-012
title: Команды, события и поиск задач
status: done
stage: 2
priority: high
owner: worker-kan-012
blocked_by: []
branch: feat/kan-012-tasks-operations
worktree: .worktrees/kan-012-tasks-operations
created: 2026-11-07
updated: 2026-11-07
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/technology-stack.md
---

# KAN-012 — Команды, события и поиск задач

## Цель

Подключить домен задач к публичному lifecycle: зарегистрировать команды,
запросы, типы ресурсов, поисковые документы и события. Операции должны
выполняться через общие шины, изменения — в транзакциях, события —
только после успешного коммита.

После этой задачи `kanbaner.tasks` является рабочим headless-плагином: его
можно использовать через API и из будущих представлений KAN-013 и KAN-014.

## Результат

- Плагин активируется через `KANBANER_PLUGIN_DIRS` и регистрирует все операции
  из KAN-010.
- Команды проходят валидацию до записи, поддерживают `expectedVersion` и
  `Idempotency-Key`.
- События публикуются после коммита и не превращают успешную операцию в
  ошибку при сбое доставки.
- `ResourceRef` проекта и задачи разрешается через реестр ресурсов.
- Поисковый индекс обновляется при создании, изменении и удалении; удаление
  ресурса очищает связанные документы поиска.
- Данные сохраняются после перезапуска приложения.

## Объём работ

- [x] Реализовать `activate(context)` в `packages/plugin-tasks/src/activation.ts`
      только через публичный `PluginActivationContext`.
- [x] Зарегистрировать команды:
  - `kanbaner.tasks.project.create|update|delete`;
  - `kanbaner.tasks.task.create|update|move|complete|delete`.
- [x] Зарегистрировать запросы:
  - `kanbaner.tasks.project.list|get`;
  - `kanbaner.tasks.task.get|list`.
- [x] Использовать схемы KAN-010 в метаданных операций; не дублировать
      валидацию вручную.
- [x] Назначить риски: `delete` — `destructive`, `complete` — `write`,
      `get`/`list` — `read`.
- [x] Включить `exposure.ui: true` только для операций, которые реально нужны
      UI KAN-013/KAN-014:
      `project.list|get`, `task.get|list`, `project.create|update|delete`,
      `task.create|update|move|complete|delete`. HTTP и MCP оставить
      выключенными до отдельного решения.
- [x] Реализовать `Idempotency-Key`:
  - хранить результат успешной команды в коллекции `idempotency` в namespace
    `kanbaner.tasks`;
  - запись результата и доменная мутация выполняются в одной транзакции;
  - ID записи — стабильный hash от `operationId + idempotencyKey`, а не
    произвольная строка ключа;
  - повтор с тем же operation ID и тем же нормализованным вводом возвращает
    сохранённый результат;
  - другой operation ID или другой ввод с тем же ключом возвращает
    `IDEMPOTENCY_CONFLICT`;
  - неуспешная команда не оставляет записи;
  - записи старше 24 часов можно не учитывать;
  - операции без ключа не дедуплицируются.
- [x] Публиковать события после коммита:
  - `project.created|updated|deleted`;
  - `task.created|updated|moved|completed|deleted`;
  - `source = "kanbaner.tasks"`, `contractVersion = 1`,
    `resourceVersion` равен новой версии сущности;
  - для delete использовать `eventVersion` из Store, а не последнюю сохранённую
    версию;
  - при insert/move/complete/delete вычислять diff снимков затронутых задач в
    той же транзакции и публиковать `task.updated` для сдвинутых соседей с их
    новыми `position` и `resourceVersion`;
  - ошибка публикации логируется и не отменяет результат команды.
- [x] Зарегистрировать типы ресурсов `project` и `task`:
  - `resolve` возвращает `ResourceDescriptor` или `null`;
  - `open` не требуется для headless-этапа.
- [x] Индексировать задачи:
  - `title` и `descriptionMarkdown` в поисковый документ;
  - `metadata.projectId`, `metadata.status`;
  - `upsert` после коммита;
  - `delete` при удалении задачи или проекта;
  - полная переиндексация задач при активации плагина: best-effort, не
    блокирует активацию, идемпотентна и не выполняется параллельно с
    create/update/delete через per-plugin очередь.
- [x] При удалении проекта вернуть из Store удалённые ссылки и очистить
      поисковые документы всех задач проекта.
- [x] Убедиться, что удаление ресурса через существующий cleanup подписки
      ядра не затрагивает чужие связи.
- [x] Добавить интеграционные тесты с реальным composition root и SQLite:
  - полный жизненный цикл проекта и задачи;
  - подзадача и запрет второго уровня;
  - все четыре статуса и `completedAt`;
  - `VERSION_CONFLICT` и отсутствие перезаписи;
  - повтор команды с тем же `Idempotency-Key` возвращает тот же результат;
  - другой operation ID или ввод с тем же ключом даёт
    `IDEMPOTENCY_CONFLICT`;
  - сбой между мутацией и записью результата не оставляет idempotency-запись;
  - событие наблюдается после коммита;
  - сдвинутые соседи получают `task.updated` с новой позицией и версией;
  - delete использует `eventVersion = последняя сохранённая версия + 1`;
  - `ResourceRef` разрешается;
  - поиск находит задачу по кириллице и очищается при удалении;
  - переиндексация при активации не теряет параллельно созданную задачу;
  - перезапуск и повторная активация не создают дублей;
  - работа на delayed SQLite.
- [x] Расширить `scripts/check-import-boundaries.mjs`: `plugin-tasks` может
      импортировать только `@kanbaner/plugin-sdk` и собственные модули, не
      ядро и не другие плагины.
- [x] Обновить README пакета: запуск с `KANBANER_PLUGIN_DIRS`, список
      операций и событий.

## Владение файлами

Разрешено:

- `packages/plugin-tasks/src/activation.ts`, `packages/plugin-tasks/src/activation/**`;
- `packages/plugin-tasks/src/index.ts` — экспорт `activate`;
- `packages/plugin-tasks/src/**/*.test.ts` для activation;
- `packages/plugin-tasks/README.md`;
- `tests/integration/tasks-activation*.test.ts`;
- `scripts/check-import-boundaries.mjs`;
- `packages/plugin-sdk/src/errors.ts`, `packages/plugin-sdk/src/index.ts` —
  только additive публичный throwable-тип ошибки операции;
- `packages/kernel/src/operations/errors.ts` и его тесты — совместимость
  `OperationFailure` с публичным SDK-типом;
- `specs/plugin-contract.md` — только фиксация способа выброса ожидаемой
  ошибки операции;
- `pnpm-lock.yaml` — только если изменились зависимости.

Запрещено:

- `packages/kernel/**`, `packages/plugin-sdk/**`, `packages/storage-sqlite/**`,
  кроме явно разрешённого additive error contract выше;
- `apps/web/**` и `tests/contract/**`;
- другие плагины;
- изменение публичных схем без согласования с KAN-010;
- файлы других задач.

Общие файлы:

- `scripts/check-import-boundaries.mjs` меняет только эта задача; KAN-013 и
  KAN-014 расширяют его только по согласованию.

## Контракты и зависимости

- Использует модель, схемы и `TasksStore` KAN-010/KAN-011.
- Использует публичные registrars, `PluginStorage`, `PluginSearchService`,
  `publishAfterCommit` и типы ресурсов SDK.
- Не импортирует ядро и не обращается к SQLite напрямую.
- Блокирует KAN-013 и KAN-014.

## Критерии приёмки

- [x] Все команды и запросы KAN-010 доступны через общий OperationBus.
- [x] Валидация выполняется до записи; частичный успех невозможен.
- [x] `expectedVersion` соблюдается, конфликт возвращает `VERSION_CONFLICT`.
- [x] `Idempotency-Key` не создаёт дубль и не подменяет чужую операцию.
- [x] События публикуются только после коммита; сбой публикации не отменяет
      изменения.
- [x] `ResourceRef` проекта и задачи разрешается.
- [x] Поиск находит задачу и очищается при удалении задачи или проекта.
- [x] Плагин не импортирует ядро, SQL и другие плагины.
- [x] Перезапуск приложения сохраняет данные и не дублирует индексацию.
- [x] Integration-тесты проходят на SQLite и delayed SQLite.

## Проверки

- [x] Typecheck.
- [x] Линтер.
- [x] Focused-тесты activation.
- [x] Integration-тесты с реальным composition root.
- [x] `pnpm check:imports`.
- [x] Полный `pnpm check`.
- [x] Проверка перезапуска и сохранности данных.

## Риски

- `Idempotency-Key` добавляет запись в хранилище и усложняет команды.
  Смягчение: хранится только результат успешной команды, TTL 24 часа,
  конфликт ключей явный.
- Полная переиндексация на активации может быть дорогой. Смягчение: выполняется
  best-effort и идемпотентно; ошибка не блокирует активацию.
- Удаление проекта генерирует много событий задач. Смягчение: очистка поиска
  выполняется синхронно по возвращённым ссылкам, события — best-effort.
- Плагин по умолчанию не попадает в production discovery без
  `KANBANER_PLUGIN_DIRS`. Смягчение: README и E2E фиксируют запуск с
  `packages/`; упаковка встроенных плагинов остаётся отдельной задачей.

## Журнал

- 2026-11-07 — KAN-012 влита в `dev` merge-коммитом
  `11317b407e3ce57995cd06daa908c54675be8401`; strict install, check:imports и
  полный check зелёные на ветке и `dev`, повторное ревью разрешило интеграцию.
  Feature-ветка и worktree удалены, задача переведена в done.
- 2026-11-07 — Независимое ревью нашло deadlock при вызове tasks-команды из
  обработчика события и непереносимый capture приватного `OperationFailure`.
  Оркестратор согласовал additive SDK throwable-тип ошибки операции и
  совместимое наследование существующего kernel `OperationFailure`; capture-shim
  запрещён. Дополнительно требуются normalized idempotency input и реальные
  race/sibling/failure-тесты.
- 2026-11-07 — После ревью KAN-012 уточнена событийная модель: сдвинутые
  соседи получают `task.updated`, а delete использует `eventVersion`. Это
  предотвращает устаревшие проекции у подписчиков.
- 2026-11-07 — По итогам проверки задач уточнены: список UI-операций,
  атомарная запись idempotency вместе с мутацией, hash ключа, конфликт по
  operation ID/вводу и сериализация переиндексации с изменениями задач.
- 2026-11-07 — Задача создана. Headless-плагин должен стать доступен без UI,
  чтобы KAN-013 и KAN-014 работали только через публичные операции.

## Итог

- Коммит: merge `11317b407e3ce57995cd06daa908c54675be8401`; feature-коммиты
  `17a9ecd`, `6cb63c5`.
- Ветка: `feat/kan-012-tasks-operations` влита в `dev`; ветка и worktree удалены.
- Проверки: strict frozen install, `check:imports` и self-test, полный
  `pnpm check` на ветке и `dev`; 17 focused files / 181 tests, 71 workspace
  file / 985 tests; 25 activation integration-тестов на SQLite/delayed SQLite.
- Остаточные риски: события параллельных команд могут переупорядочиваться,
  подписчики обязаны учитывать `resourceVersion`; sibling payload `position`
  остаётся additive-полем для отдельного уточнения; полная переиндексация и
  сдвиги O(N); UI helper пока не принимает Idempotency-Key; Windows не проверен.
