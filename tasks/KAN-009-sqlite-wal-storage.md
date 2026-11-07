---
id: KAN-009
title: SQLite WAL Storage Provider
status: review
stage: 1
priority: high
owner: worker-kan-009
blocked_by: []
branch: feat/kan-009-sqlite-wal-storage
worktree: .worktrees/kan-009-sqlite-wal-storage
created: 2026-11-06
updated: 2026-11-07
specs:
  - specs/product-mvp.md
  - specs/technology-stack.md
  - specs/architecture.md
  - specs/plugin-contract.md
---

# KAN-009 — SQLite WAL Storage Provider

## Цель

Реализовать первый реальный Storage Provider на SQLite в режиме WAL и доказать, что доменные плагины не зависят от SQLite.

## Результат

Провайдер открывает локальную базу через `better-sqlite3`, включает WAL и FTS5, реализует Store-контракты, выполняет миграции, делает online backup через `.backup()` и проходит общий Storage Provider Conformance Suite на Linux и Windows.

## Объём работ

- [ ] Создать пакет `packages/storage-sqlite` со сборкой через tsup 9.
- [ ] Реализовать `StorageProvider` для SQLite.
- [ ] Открывать базу через `better-sqlite3` 13.0.x.
- [ ] Обернуть синхронные вызовы драйвера в асинхронный публичный API.
- [ ] Реализовать `withTransaction` вручную, не передавая async callback в sync transaction helper.
- [ ] Сериализовать операции на соединении; транзакция монополизирует соединение.
- [ ] Откатывать транзакцию при rejected Promise.
- [ ] Зарегистрировать провайдер в application composition root `apps/web` при bootstrap.
- [ ] Проходить health check до применения миграций остальных плагинов.
- [ ] Сохранять app-generated ID и UTC-время без участия SQLite autoincrement.
- [ ] Устанавливать `journal_mode = WAL`.
- [ ] Устанавливать `foreign_keys = ON`.
- [ ] Устанавливать `busy_timeout = 5000`.
- [ ] Устанавливать `synchronous = NORMAL`.
- [ ] Разрешать `KANBANER_DATA_DIR` и каталоги ОС по умолчанию.
- [ ] Формировать пути только через Node.js path API.
- [ ] Реализовать singleton для Next.js hot reload.
- [ ] Закрывать соединение и выполнять WAL checkpoint при завершении.
- [ ] Реализовать транзакции и savepoints.
- [ ] Реализовать bounded retry для `SQLITE_BUSY`.
- [ ] Реализовать namespace-префиксы таблиц.
- [ ] Реализовать `PluginDocumentStore`.
- [ ] Реализовать `LinkStore`, `PluginStateStore` и `MigrationStore`.
- [ ] Реализовать `SearchIndexStore` на FTS5.
- [ ] Использовать токенизатор `unicode61`.
- [ ] Реализовать `SearchNormalizer`.
- [ ] Реализовать online backup через `.backup()` внутри процесса приложения.
- [ ] Проверять backup через `integrity_check`.
- [ ] Реализовать offline restore в новый каталог.
- [ ] Запретить restore в каталог с существующей базой.
- [ ] Не открывать второе соединение со стороны backup/restore при работающем приложении.
- [ ] Запретить ручное копирование файлов базы, WAL и SHM.
- [ ] Не реализовывать перенос данных между backend в этой задаче.
- [ ] Запустить Storage Provider Conformance Suite.
- [ ] Проверить установку и работу на Linux и Windows.
- [ ] Проверить загрузку нативного модуля в production build.
- [ ] Проверить production smoke собранного приложения с открытием SQLite через провайдер.

## Владение файлами

Разрешено:

- `packages/storage-sqlite/**`;
- bootstrap-файл `apps/web` для регистрации провайдера — по координации с оркестратором;
- `scripts/restore.*` для offline restore через код провайдера;
- тесты и fixtures внутри `packages/storage-sqlite/**`;
- SQLite-миграции инфраструктурных таблиц;
- конфигурация server externals для `better-sqlite3` по координации.

Запрещено:

- `packages/plugin-sdk/**`;
- `packages/kernel/**`, кроме согласованной регистрации провайдера;
- доменные плагины задач, заметок, поиска и канбана;
- доменные таблицы и миграции;
- `apps/web/**`, кроме bootstrap-файла регистрации провайдера;
- `specs/**`;
- `tasks/**`, кроме собственного отчёта;
- сетевая файловая система и внешняя СУБД.

Общие файлы:

- Корневой `package.json` и конфигурация сборки изменяются по координации с оркестратором.
- `better-sqlite3` добавляется в KAN-001; дополнительные зависимости согласуются.

## Контракты и зависимости

- Реализует контракт `StorageProvider` из KAN-006.
- Использует версии `better-sqlite3` и tsup из `specs/technology-stack.md`.
- Все публичные методы провайдера асинхронны; синхронный `better-sqlite3` остаётся внутри реализации.
- `withTransaction` удерживает границу до завершения async callback; транзакция монополизирует соединение.
- Rejected Promise откатывает транзакцию.
- ID генерируются до записи; SQLite rowid и autoincrement не используются как публичный ID.
- Время сохраняется в UTC без преобразования часового пояса.
- Провайдер регистрируется и открывается при bootstrap до миграций остальных плагинов.
- Application composition root находится в `apps/web`, а не в ядре.
- Не меняет публичные Store-контракты ради удобства SQLite.
- Не добавляет доменные понятия в ядро.
- SQL, `PRAGMA`, `MATCH`, `RETURNING` и имена таблиц остаются внутри провайдера.
- Online backup выполняется внутри процесса приложения через активный провайдер.
- Offline restore CLI работает только с новым каталогом при остановленном приложении.
- Миграции используют ключ `(backendId, pluginId, version, checksum)`.
- `backendId` имеет стабильное значение `sqlite`.
- `SearchIndexStore` не обещает русский стемминг.
- Перенос существующих данных в другой backend не входит в задачу.
- MCP, HTTP API и UI не получают прямого доступа к файлу базы.

## Критерии приёмки

- [ ] SQLite открывается без внешней СУБД и Docker.
- [ ] Используется `better-sqlite3` 13.0.x и FTS5.
- [ ] Все публичные методы провайдера возвращают `Promise`.
- [ ] Commit происходит после завершения async callback.
- [ ] Rejected Promise приводит к rollback.
- [ ] Параллельные write-транзакции сериализуются и не перемешиваются.
- [ ] Операция другого вызова не выполняется внутри открытой транзакции.
- [ ] Провайдер зарегистрирован в `apps/web` и открыт до первой миграции.
- [ ] Ошибка открытия провайдера не приводит к частично применённым миграциям.
- [ ] Публичные ID генерируются до записи и не являются SQLite rowid.
- [ ] UTC-время сохраняется без изменения часового пояса.
- [ ] `PRAGMA journal_mode` возвращает `wal`.
- [ ] `PRAGMA foreign_keys` включён.
- [ ] `busy_timeout` равен 5000 мс.
- [ ] `synchronous` соответствует `NORMAL`.
- [ ] `KANBANER_DATA_DIR` переопределяет каталог данных.
- [ ] Каталоги по умолчанию корректны для Linux и Windows.
- [ ] Пути с пробелами и не-ASCII символами работают.
- [ ] Данные сохраняются после закрытия и повторного открытия.
- [ ] При hot reload не создаётся лишнее соединение.
- [ ] При завершении выполняется WAL checkpoint.
- [ ] Транзакция откатывается при ошибке.
- [ ] `SQLITE_BUSY` не приводит к бесконечному retry.
- [ ] Namespace-префиксы не позволяют плагину писать в чужие таблицы через публичный API.
- [ ] `PluginDocumentStore` и инфраструктурные Store-контракты проходят conformance suite.
- [ ] FTS5 находит кириллицу без учёта регистра.
- [ ] FTS5 поддерживает фразы и prefix-запросы.
- [ ] Online `.backup()` создаёт консистентную копию при параллельной записи.
- [ ] Online backup выполняется внутри процесса приложения.
- [ ] `.backup()` не копирует live-файлы базы, WAL и SHM вручную.
- [ ] `integrity_check` проходит на созданном backup.
- [ ] Повреждённый backup обнаруживается.
- [ ] Restore в новый каталог работает при остановленном приложении.
- [ ] Restore отказывается работать с каталогом, где уже есть база.
- [ ] Backup/restore не открывают второе соединение с работающей базой.
- [ ] Storage Provider Conformance Suite проходит полностью.
- [ ] Тесты проходят на Linux и Windows.
- [ ] Production build загружает `better-sqlite3`.
- [ ] Production smoke запускает собранное приложение и открывает SQLite через провайдер.
- [ ] В репозитории нет секретов.

## Проверки

- [ ] Typecheck.
- [ ] Линтер.
- [ ] Unit-тесты провайдера.
- [ ] Проверка асинхронности публичного API.
- [ ] Тест async callback с задержкой и commit после `await`.
- [ ] Тест rollback при rejected Promise.
- [ ] Тест параллельных транзакций и сериализации.
- [ ] Тест операции другого вызова во время открытой транзакции.
- [ ] Тест app-generated ID и UTC-времени.
- [ ] Проверка bootstrap-порядка и health check.
- [ ] Тесты WAL, транзакций и `SQLITE_BUSY`.
- [ ] Тесты миграций и checksum.
- [ ] Тесты Store-контрактов.
- [ ] Тесты FTS5 и `SearchNormalizer`.
- [ ] Тест online backup при параллельной записи.
- [ ] Тест `integrity_check` и повреждённого backup.
- [ ] Тест offline restore.
- [ ] Storage Provider Conformance Suite.
- [ ] Установка и тесты на Linux.
- [ ] Установка и тесты на Windows.
- [ ] Production build и загрузка нативного модуля.
- [ ] Production smoke собранного приложения.
- [ ] Проверка отсутствия Docker и внешней СУБД.

## Риски

- Нативный модуль `better-sqlite3` может требовать сборки из исходников. Проверить prebuilt binaries и toolchain на обеих ОС.
- Синхронный API драйвера может протечь в доменный код. Обернуть его в асинхронный контракт и проверить на provider с задержками.
- Штатный `better-sqlite3.transaction()` закоммитит раньше async callback. Реализовать `withTransaction` вручную и монополизировать соединение на время транзакции.
- Autoincrement может стать публичным ID и сломать переносимость. Генерировать ID до записи.
- Backup/restore может открыть второе соединение с работающей базой. Online backup выполнять в приложении, restore — только офлайн в новый каталог.
- Смену backend могут спутать с переносом данных. Явно указать, что перенос выполняется отдельным export/import.
- Нативный модуль может не попасть в production bundle Next.js. Настроить server externals и проверить production build.
- Долгая write-транзакция блокирует других писателей. Держать транзакции короткими и не вызывать чужие плагины внутри.
- `synchronous = NORMAL` допускает потерю последних коммитов при аварийном отключении питания. Задокументировать компромисс.
- FTS5 не даёт русской морфологии. Не обещать стемминг; при необходимости добавить отдельный слой.
- WAL не работает на сетевой файловой системе. Запретить размещение базы на share и указать это в документации.
- Ручное копирование live-базы повредит данные. Разрешить только `.backup()` и offline restore.

## Журнал

- 2026-11-07 — После разрешённого повтора worker коммитом `36cfe6d` устранил scheduling deadlock и изолировал Playwright на custom server; 164 focused-теста, 664 workspace-теста, 70 Conformance, 3 E2E и deferred SIGTERM test зелёные. Пользовательский data dir не изменился, задача повторно в review.
- 2026-11-07 — При запуске исправления scheduler deadlock и E2E worker завершился инфраструктурной ошибкой `Internal Server Error` (`request_id: ce86f91b-1564-410f-97aa-03522badfc9f`). Worktree чистый на `ae7da96`, новых изменений и результатов исправления нет; требуется решение о повторном запуске.
- 2026-11-07 — Ревью подтвердило SQL scanner, backup и custom shutdown, но нашло deadlock при await parent/sibling из активного savepoint и запуск Playwright через старый `next start` без изолированной БД. Требуется обнаружение scheduling conflict вместо ожидания и единый custom server для E2E.
- 2026-11-07 — Worker коммитом `ae7da96` реализовал stack-aware AsyncLocalStorage scheduler, SQL transaction-control scanner и custom await-able production server; 160 focused-тестов, 660 workspace-тестов, 70 Conformance и отдельный deferred-write SIGTERM test зелёные. Задача повторно в review.
- 2026-11-07 — Повторное ревью подтвердило backup/schema/checkpoint/paths, но нашло пересечение savepoint с parent/sibling-операциями, возможность COMMIT/ROLLBACK внутри SQL-файла миграции и отсутствие ожидания deferred операций при завершении Next.js. Требуется stack-aware scheduler, SQL transaction-control guard и await-able production server lifecycle.
- 2026-11-07 — Worker коммитом `67c0153` устранил все 9 направлений ревью; 150 focused-тестов, 650 workspace-тестов и 70 Conformance-тестов зелёные. Production `/plugins` 200, `kanbaner.core` v1 и integrity_check подтверждены, SIGTERM очищает WAL/SHM, CLI restore с non-ASCII путями работает. Задача повторно в review.
- 2026-11-07 — Независимое ревью нашло blocker удаления существующего backup/чужих sidecar, DDL в open до checksum и вне миграции, нарушение LIFO savepoint, непроверенный checkpoint, shutdown race, неподключённые plugin migrations, обходы path validation, непустой restore dir и Windows import в CLI. Задача возвращена worker-у для исправления всех findings.
- 2026-11-07 — Worker завершил SQLite provider коммитом `3be5367`; 166 focused-тестов, 627 workspace-тестов и 70 Conformance-тестов (33 базовых + no-savepoints, normal/delayed) зелёные. Production smoke `/plugins` 200, WAL и одна запись `kanbaner.core` подтверждены. Создан отчёт, задача переведена в review.
- 2026-11-07 — KAN-001/KAN-006 завершены. Оркестратор назначил worker-kan-009, ветку `feat/kan-009-sqlite-wal-storage` и worktree `.worktrees/kan-009-sqlite-wal-storage`. Согласованы изменения `packages/storage-sqlite/**`, bootstrap-файлов `apps/web/src/server/**`, `apps/web/package.json`, `next.config.ts` только для native externals, `scripts/restore.*`, корневого `package.json` для build/restore scripts и `pnpm-lock.yaml`; kernel/SDK/UI/specs менять запрещено.
- 2026-11-06 — Задача создана при переходе с PGlite на SQLite WAL.
- 2026-11-06 — Добавлены асинхронный публичный API, bootstrap-порядок и границы backup/restore.
- 2026-11-06 — Добавлены composition root в `apps/web`, production smoke, ID/UTC и ручной async `withTransaction`.
- 2026-11-06 — Версии `better-sqlite3` и tsup привязаны к `specs/technology-stack.md`.

## Итог

Заполняется оркестратором после интеграции:

- Коммит:
- Ветка:
- Проверки:
- Остаточные риски:
