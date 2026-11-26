---
id: KAN-006
title: Storage Provider Registry, Store-контракты и миграции
status: done
stage: 1
priority: high
owner: worker-kan-006
blocked_by: []
branch: feat/kan-006-storage-migrations
worktree: .worktrees/kan-006-storage-migrations
created: 2026-11-06
updated: 2026-11-07
specs:
  - specs/technology-stack.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-006 — Storage Provider Registry, Store-контракты и миграции

## Цель

Реализовать backend-neutral слой хранения ядра: контракт Storage Provider, реестр провайдеров, capabilities, инфраструктурные Store-контракты, runner миграций и общий набор проверок совместимости.

## Результат

Доменные плагины работают только через Store-контракты. Реестр провайдеров выдаёт реализации, проверяет capabilities и фиксирует backend ID. Один Storage Provider Conformance Suite проходит на тестовом in-memory provider и позже на SQLite provider без изменения доменного кода.

## Объём работ

- [x] Определить публичный контракт `StorageProvider`.
- [x] Реализовать `StorageProviderRegistry`.
- [x] Запретить дублирующий `backendId`.
- [x] Определить lifecycle: `open`, `close`, `healthCheck`.
- [x] Зафиксировать асинхронный публичный контракт всех операций.
- [x] Определить `withTransaction(async (tx) => ...)` с границей до завершения callback.
- [x] Сериализовать операции на общем соединении; транзакция монополизирует соединение.
- [x] Откатывать транзакцию при rejected Promise.
- [x] Запретить выход синхронного API драйвера за пределы провайдера.
- [x] Зафиксировать app-generated ID и UTC-время на границе Store.
- [x] Определить bootstrap-порядок: открытие провайдера до миграций остальных плагинов.
- [x] Считать `transactions` обязательной capability провайдера.
- [x] Определить модель savepoints через capabilities.
- [x] Определить явные capabilities провайдера.
- [x] Реализовать механизм регистрации domain Store-контрактов.
- [x] Определить `PluginDocumentStore`.
- [x] Определить `LinkStore`, `PluginStateStore`, `MigrationStore` и `SearchIndexStore`.
- [x] Не добавлять в ядро доменные понятия задач и заметок.
- [x] Создать инфраструктурные таблицы `core_plugins`, `core_plugin_migrations`, `core_resource_links`.
- [x] Реализовать runner миграций.
- [x] Использовать ключ миграции `(backendId, pluginId, version, checksum)`.
- [x] Применять миграции транзакционно и ровно один раз.
- [x] Обнаруживать несовпадение checksum применённой миграции.
- [x] Обрабатывать ошибку миграции без частичного применения.
- [x] Реализовать персистентный link store через провайдер.
- [x] Обеспечить уникальность связей.
- [x] Удалять связи по ссылке на удалённый ресурс.
- [x] Реализовать тестовый in-memory provider.
- [x] Добавить в in-memory provider искусственные асинхронные задержки.
- [x] Реализовать Storage Provider Conformance Suite.
- [x] Запустить conformance suite на in-memory provider.
- [x] Проверить, что доменный код не содержит SQL и импортов драйвера БД.
- [x] Проверить, что доменный код не зависит от синхронного выполнения.

## Владение файлами

Разрешено:

- `packages/plugin-sdk/src/storage/**`;
- `packages/kernel/src/storage/**`;
- тесты, fixtures и conformance suite в согласованном test-каталоге;
- инфраструктурные миграции ядра для in-memory provider.

Запрещено:

- `packages/kernel/src/plugins/**`;
- `packages/kernel/src/events/**`;
- `packages/kernel/src/resources/**`, кроме реализации порта внутри storage;
- `packages/kernel/src/operations/**`;
- `packages/plugin-sdk/**`, кроме `src/storage/**`;
- `apps/web/**`;
- `specs/**`;
- `tasks/**`, кроме собственного отчёта;
- `better-sqlite3` и SQLite-провайдер;
- доменные таблицы задач и заметок;
- HTTP API и UI.

Общие файлы:

- Корневой `package.json`, `.env.example` и конфигурация тестов изменяются по координации с оркестратором.
- `better-sqlite3` добавляется в KAN-001; реализация SQLite-провайдера входит в KAN-009.

## Контракты и зависимости

- Storage backend является плагином-провайдером.
- Технологии и версии берутся из `specs/technology-stack.md`; задачи не фиксируют альтернативы.
- Ядро знает только Store-контракты и реестр провайдеров.
- Доменный плагин объявляет собственный Store-контракт.
- Провайдер реализует контракты и объявляет capabilities.
- Все публичные операции Storage Provider и Store-контрактов асинхронны.
- `withTransaction` сохраняет границу до завершения async callback.
- Транзакция монополизирует соединение; операции другого вызова ждут и не попадают в чужую транзакцию.
- Rejected Promise откатывает транзакцию.
- ID генерируются приложением или плагином до записи; autoincrement не является публичным ID.
- Время передаётся в UTC; формат timestamp инкапсулирован Store-контрактом.
- Провайдер открывается и проходит health check до применения миграций остальных плагинов.
- `transactions` является обязательной capability; savepoints опциональны.
- SQL, `PRAGMA`, `MATCH`, `RETURNING` и имена таблиц не выходят за пределы провайдера.
- `PluginDocumentStore` является backend-neutral API для сторонних плагинов.
- Миграция принадлежит конкретному backend.
- Смена backend поддерживается для пустого хранилища; перенос данных не входит в эту задачу.
- Использует lifecycle hook из KAN-003.
- Использует порт link store из KAN-005.
- Не знает структуру доменных таблиц.
- Не реализует HTTP API и UI.

## Критерии приёмки

- [x] Реестр провайдеров регистрирует провайдер по `backendId`.
- [x] Повторная регистрация того же `backendId` отклоняется.
- [x] Неизвестный провайдер возвращает структурированную ошибку.
- [x] Capabilities доступны плагинам до выполнения операции.
- [x] Отсутствие capability обрабатывается документированным fallback или ошибкой.
- [x] Все публичные операции Provider и Store возвращают `Promise`.
- [x] Provider без capability `transactions` не регистрируется как пригодный для MVP.
- [x] Провайдер открывается и проходит health check до первой миграции.
- [x] Ошибка открытия провайдера не приводит к частично применённым миграциям.
- [x] Транзакция откатывается при ошибке.
- [x] Commit выполняется после завершения async callback, а не при возврате Promise.
- [x] Rejected Promise внутри callback приводит к rollback.
- [x] Параллельные write-транзакции сериализуются и не перемешиваются.
- [x] Операция другого вызова не выполняется внутри открытой транзакции.
- [x] Вложенная транзакция использует savepoint при capability или возвращает ошибку.
- [x] ID генерируются до записи и не зависят от autoincrement.
- [x] Время сохраняется в UTC без изменения часового пояса.
- [x] Savepoint используется только при наличии capability.
- [x] `PluginDocumentStore` выполняет `get`, `put`, `delete`, `query`, `list`.
- [x] Конфликт версий документа возвращает ошибку, а не перезапись.
- [x] На пустом хранилище создаются все инфраструктурные таблицы.
- [x] Миграция применяется ровно один раз.
- [x] Повторный запуск не применяет миграцию заново.
- [x] Несовпадение checksum блокирует активацию.
- [x] Ошибка миграции не оставляет частичных изменений.
- [x] Миграция одного backend не применяется к другому.
- [x] Неверный Plugin ID не создаёт опасное имя namespace.
- [x] Состояние плагина сохраняется и читается.
- [x] Связь двух существующих ссылок создаётся один раз.
- [x] Дубликат связи обрабатывается по правилам контракта.
- [x] Удаление ссылки очищает её связи.
- [x] In-memory provider проходит весь conformance suite.
- [x] In-memory provider с искусственными задержками проходит conformance suite.
- [x] Доменный код не содержит синхронных предположений.
- [x] Conformance suite не требует SQLite, Docker или внешней СУБД.
- [x] Проверка запрещает SQL и импорт драйвера БД в доменном коде.
- [x] В репозитории нет секретов.

## Проверки

- [x] Typecheck.
- [x] Линтер.
- [x] Unit-тесты реестра и capabilities.
- [x] Тесты транзакций и savepoints.
- [x] Тест async callback с задержкой и commit после `await`.
- [x] Тест rollback при rejected Promise.
- [x] Тест параллельных транзакций и сериализации.
- [x] Тест операции другого вызова во время открытой транзакции.
- [x] Тест app-generated ID и UTC-времени.
- [x] Тесты миграций, checksum и отката.
- [x] Тесты link store.
- [x] Тесты `PluginDocumentStore`.
- [x] Storage Provider Conformance Suite на in-memory provider.
- [x] Conformance suite на provider с асинхронными задержками.
- [x] Проверка отсутствия SQL в доменном коде.
- [x] Проверка отсутствия синхронных предположений.
- [x] Проверка отсутствия Docker и внешней СУБД.

## Риски

- Абстракция станет «универсальным SQL» и протечёт в домен. Держать контракты на уровне операций, а не запросов.
- Синхронный API `better-sqlite3` протечёт в Store-контракты. Оставить только асинхронный публичный API и проверять на provider с задержками.
- `better-sqlite3` закоммитит транзакцию до завершения async callback. Не использовать штатный sync transaction helper для async callback; вести границу и очередь вручную.
- Смена backend будет ошибочно воспринята как перенос данных. Явно ограничить заменяемость пустым хранилищем и вынести export/import в отдельную задачу.
- Слишком широкий `PluginDocumentStore` превратится в негибкое хранилище. Оставить простой API и разрешить собственные Store-контракты.
- Conformance suite окажется привязан к in-memory provider. Проверять его на SQLite в KAN-009.
- Миграции разных backend перепутаются. Ключ включает `backendId`, есть тест на изоляцию.
- Ядро начнёт знать доменные понятия. Store-контракты задач и заметок объявляют их плагины, а не ядро.

## Журнал

- 2026-11-07 — KAN-006 влита в `dev` merge-коммитом `19c758e5cd22969a6661c57ea9c2777ee275d8bd`; merge queue зелёный на ветке и `dev`, финальное ревью разрешило интеграцию. Feature-ветка и worktree удалены, задача переведена в done.
- 2026-11-07 — Worker коммитом `1c5c84d` разделил sealing и фактический rollback, исправил rejected savepoint и стандартную Promise-семантику; 180 focused-тестов, 423 workspace-теста и 33 Conformance case зелёные. Задача повторно в review.
- 2026-11-07 — Повторное ревью подтвердило 8 из 9 исправлений, но нашло rejected savepoint, который не откатывается после sealing родителя. Требуется различить sealed и rolledBack, добавить delayed regression в unit/conformance и уточнить обработку rejected Promise публичных операций.
- 2026-11-07 — Worker коммитом `a65d8c8` устранил все 9 findings, включая late-write sealing, registry/bootstrap races, conformance concurrency и удаление `projectRef`; 176 focused-тестов и 419 тестов workspace, strict install и полный check зелёные. Задача повторно переведена в review.
- 2026-11-07 — Пользователь возобновил работу. Решение по `projectRef` применено к `specs/architecture.md`; worker должен устранить все 9 findings, включая удаление поля из SDK в пользу `metadata`, повторное ревью и полные проверки.
- 2026-11-06 — Пользователь приостановил работу до следующего дня и выбрал решение конфликта поискового контракта: **удалить типизированное `SearchIndexDocument.projectRef`**. При возобновлении доменная ссылка на проект должна передаваться через generic `metadata`, ядро не интерпретирует её; одновременно уточнить `specs/architecture.md` (раздел поиска), не меняя инвариант отсутствия проекта в публичных типах ядра. Код и спецификация в этой паузе не изменялись.
- 2026-11-06 — Независимое ревью нашло blocker поздней записи после rollback, гонки registry.open, неполный bootstrap cleanup, пробелы conformance/checksum, дублирование LinkStore/validation, спорный projectRef и мелкие JSON/delayed-дефекты. Задача возвращена worker-у; изменение KAN-005 LinkStore на alias SDK согласовано оркестратором.
- 2026-11-06 — Worker завершил Storage коммитом `b1f1452`; структурная копия контрактов устранена, SDK/kernel exports и StorageError унифицированы. 110 focused-тестов и 396 тестов workspace, strict install и полный check зелёные. Создан отчёт, задача переведена в review.
- 2026-11-06 — Для устранения структурного дублирования оркестратор разрешил worker-у добавить `export *` для storage в корневые `packages/plugin-sdk/src/index.ts` и `packages/kernel/src/index.ts` и заменить локальную копию контрактов на публичные типы SDK. Другие корневые файлы по-прежнему запрещены.
- 2026-11-06 — Зависимости KAN-001/KAN-002/KAN-003/KAN-005 завершены. Оркестратор назначил worker-kan-006, ветку `feat/kan-006-storage-migrations` и worktree `.worktrees/kan-006-storage-migrations`; корневые exports SDK/kernel остаются за оркестратором, новые зависимости и общие configs требуют отдельной координации.
- 2026-11-06 — Задача создана.
- 2026-11-06 — PostgreSQL заменён на PGlite; добавлены Linux/Windows, single gateway и `pgDump`.
- 2026-11-06 — Задача перепрофилирована под Storage Provider Registry, Store-контракты и conformance suite; SQLite-провайдер вынесен в KAN-009.
- 2026-11-06 — Зафиксированы асинхронный контракт, обязательные транзакции, bootstrap-порядок и provider с задержками.
- 2026-11-06 — Добавлены сериализация write-транзакций, rollback по rejected Promise, app-generated ID и UTC.
- 2026-11-06 — Технологии привязаны к `specs/technology-stack.md`.

## Итог

- Коммит: merge `19c758e5cd22969a6661c57ea9c2777ee275d8bd`; feature-коммиты `447ce2d`, `3ac7062`, `a8cb78c`.
- Ветка: `feat/kan-006-storage-migrations` влита в `dev`; ветка и worktree удалены после успеха.
- Проверки: strict frozen install, полный `pnpm check`, 12 focused test files / 180 tests и 35 workspace test files / 423 tests, production build и 33 Conformance case на in-memory/delayed provider зелёные; финальное ревью разрешило интеграцию.
- Остаточные риски: SQLite должен подтвердить те же 33 case, включая sealing, savepoints, CAS и concurrent migrations; in-memory не персистентен и не имеет настоящего FTS; Windows, backup/restore и production SQLite проверяются в KAN-009.
