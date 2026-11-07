---
id: KAN-009
title: SQLite WAL Storage Provider
status: done
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

- [x] Создать пакет `packages/storage-sqlite` со сборкой через tsup 9.
- [x] Реализовать `StorageProvider` для SQLite.
- [x] Открывать базу через `better-sqlite3` 13.0.x.
- [x] Обернуть синхронные вызовы драйвера в асинхронный публичный API.
- [x] Реализовать `withTransaction` вручную, не передавая async callback в sync transaction helper.
- [x] Сериализовать операции на соединении; транзакция монополизирует соединение.
- [x] Откатывать транзакцию при rejected Promise.
- [x] Зарегистрировать провайдер в application composition root `apps/web` при bootstrap.
- [x] Проходить health check до применения миграций остальных плагинов.
- [x] Сохранять app-generated ID и UTC-время без участия SQLite autoincrement.
- [x] Устанавливать `journal_mode = WAL`.
- [x] Устанавливать `foreign_keys = ON`.
- [x] Устанавливать `busy_timeout = 5000`.
- [x] Устанавливать `synchronous = NORMAL`.
- [x] Разрешать `KANBANER_DATA_DIR` и каталоги ОС по умолчанию.
- [x] Формировать пути только через Node.js path API.
- [x] Реализовать singleton для Next.js hot reload.
- [x] Закрывать соединение и выполнять WAL checkpoint при завершении.
- [x] Реализовать транзакции и savepoints.
- [x] Реализовать bounded retry для `SQLITE_BUSY`.
- [x] Реализовать namespace-префиксы таблиц.
- [x] Реализовать `PluginDocumentStore`.
- [x] Реализовать `LinkStore`, `PluginStateStore` и `MigrationStore`.
- [x] Реализовать `SearchIndexStore` на FTS5.
- [x] Использовать токенизатор `unicode61`.
- [x] Реализовать `SearchNormalizer`.
- [x] Реализовать online backup через `.backup()` внутри процесса приложения.
- [x] Проверять backup через `integrity_check`.
- [x] Реализовать offline restore в новый каталог.
- [x] Запретить restore в каталог с существующей базой.
- [x] Не открывать второе соединение со стороны backup/restore при работающем приложении.
- [x] Запретить ручное копирование файлов базы, WAL и SHM.
- [x] Не реализовывать перенос данных между backend в этой задаче.
- [x] Запустить Storage Provider Conformance Suite.
- [ ] Проверить установку и работу на Linux и Windows. Linux проверен; Windows недоступен в текущем окружении.
- [x] Проверить загрузку нативного модуля в production build.
- [x] Проверить production smoke собранного приложения с открытием SQLite через провайдер.

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

- [x] SQLite открывается без внешней СУБД и Docker.
- [x] Используется `better-sqlite3` 13.0.x и FTS5.
- [x] Все публичные методы провайдера возвращают `Promise`.
- [x] Commit происходит после завершения async callback.
- [x] Rejected Promise приводит к rollback.
- [x] Параллельные write-транзакции сериализуются и не перемешиваются.
- [x] Операция другого вызова не выполняется внутри открытой транзакции.
- [x] Провайдер зарегистрирован в `apps/web` и открыт до первой миграции.
- [x] Ошибка открытия провайдера не приводит к частично применённым миграциям.
- [x] Публичные ID генерируются до записи и не являются SQLite rowid.
- [x] UTC-время сохраняется без изменения часового пояса.
- [x] `PRAGMA journal_mode` возвращает `wal`.
- [x] `PRAGMA foreign_keys` включён.
- [x] `busy_timeout` равен 5000 мс.
- [x] `synchronous` соответствует `NORMAL`.
- [x] `KANBANER_DATA_DIR` переопределяет каталог данных.
- [x] Каталоги по умолчанию корректны для Linux и Windows.
- [x] Пути с пробелами и не-ASCII символами работают.
- [x] Данные сохраняются после закрытия и повторного открытия.
- [x] При hot reload не создаётся лишнее соединение.
- [x] При завершении выполняется WAL checkpoint.
- [x] Транзакция откатывается при ошибке.
- [x] `SQLITE_BUSY` не приводит к бесконечному retry.
- [x] Namespace-префиксы не позволяют плагину писать в чужие таблицы через публичный API.
- [x] `PluginDocumentStore` и инфраструктурные Store-контракты проходят conformance suite.
- [x] FTS5 находит кириллицу без учёта регистра.
- [x] FTS5 поддерживает фразы и prefix-запросы.
- [x] Online `.backup()` создаёт консистентную копию при параллельной записи.
- [x] Online backup выполняется внутри процесса приложения.
- [x] `.backup()` не копирует live-файлы базы, WAL и SHM вручную.
- [x] `integrity_check` проходит на созданном backup.
- [x] Повреждённый backup обнаруживается.
- [x] Restore в новый каталог работает при остановленном приложении.
- [x] Restore отказывается работать с каталогом, где уже есть база.
- [x] Backup/restore не открывают второе соединение с работающей базой.
- [x] Storage Provider Conformance Suite проходит полностью.
- [ ] Тесты проходят на Linux и Windows. Linux проверен; Windows не проверен.
- [x] Production build загружает `better-sqlite3`.
- [x] Production smoke запускает собранное приложение и открывает SQLite через провайдер.
- [x] В репозитории нет секретов.

## Проверки

- [x] Typecheck.
- [x] Линтер.
- [x] Unit-тесты провайдера.
- [x] Проверка асинхронности публичного API.
- [x] Тест async callback с задержкой и commit после `await`.
- [x] Тест rollback при rejected Promise.
- [x] Тест параллельных транзакций и сериализации.
- [x] Тест операции другого вызова во время открытой транзакции.
- [x] Тест app-generated ID и UTC-времени.
- [x] Проверка bootstrap-порядка и health check.
- [x] Тесты WAL, транзакций и `SQLITE_BUSY`.
- [x] Тесты миграций и checksum.
- [x] Тесты Store-контрактов.
- [x] Тесты FTS5 и `SearchNormalizer`.
- [x] Тест online backup при параллельной записи.
- [x] Тест `integrity_check` и повреждённого backup.
- [x] Тест offline restore.
- [x] Storage Provider Conformance Suite.
- [x] Установка и тесты на Linux.
- [ ] Установка и тесты на Windows — окружение недоступно, проверка не выполнялась.
- [x] Production build и загрузка нативного модуля.
- [x] Production smoke собранного приложения.
- [x] Проверка отсутствия Docker и внешней СУБД.

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

- 2026-11-07 — KAN-009 влита в `dev` merge-коммитом `064b0d55764fd7a7cf671b8c1f238d6c794514af`; strict install, полный check, Playwright и deferred-write SIGTERM test зелёные на ветке и `dev`, финальное ревью разрешило интеграцию. Feature-ветка и worktree удалены, задача переведена в done; Windows-проверки явно оставлены невыполненными.
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

- Коммит: merge `064b0d55764fd7a7cf671b8c1f238d6c794514af`; feature-коммиты `fcc6351`, `2e2b9c4`, `310325b`, `68910b7`.
- Ветка: `feat/kan-009-sqlite-wal-storage` влита в `dev`; ветка и worktree удалены после успеха.
- Проверки: strict frozen install, полный `pnpm check`, 7 focused test files / 164 tests и 48 workspace test files / 664 tests, 70 Conformance-тестов normal/delayed, 3 Playwright E2E и deferred-write SIGTERM test зелёные на ветке и `dev`. Production подтвердил WAL, `kanbaner.core`, integrity_check и checkpoint; CLI restore с non-ASCII путями работает.
- Остаточные риски: установка, нативный модуль, custom shutdown, CLI и E2E не проверены на Windows из-за недоступности ОС; `synchronous=NORMAL` остаётся осознанным компромиссом; предупреждения Turbopack и отдельные E2E/SIGTERM-проверки вне `pnpm check` задокументированы.
