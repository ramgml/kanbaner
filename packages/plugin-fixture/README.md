# @kanbaner/plugin-fixture

Контрактный плагин, который доказывает расширяемость Kanbaner только через
публичный `@kanbaner/plugin-sdk`.

## Что регистрирует

- команду `kanbaner.fixture.item.create` (`mutation`, `risk = write`);
- запрос `kanbaner.fixture.item.list`;
- тип ресурса `item` и адаптер `resolve`;
- событие `kanbaner.fixture.item.created` после успешной записи;
- подписку на собственное событие с идемпотентной audit-записью;
- UI-вклады в слот `app.main`;
- SQLite-миграцию `migrations/001_fixture-audit.sql`.

Плагин использует только `PluginDocumentStore` активного Storage Provider.
В исходниках нет импортов `@kanbaner/kernel`, SQL, драйвера БД, React и
синхронных вызовов хранилища.

## Запуск

```bash
pnpm --filter @kanbaner/plugin-fixture build
pnpm typecheck
pnpm test
```

## Как новый плагин использует контрактные тесты

1. Соберите пакет с manifest-ом и server entrypoint-ом.
2. Добавьте каталог пакета в `KANBANER_PLUGIN_DIRS` или передайте его runtime-у
   в integration-тесте.
3. Активируйте runtime с общим `PluginHostServices` из composition root:
   commands, queries, resources, events, storage, UI metadata.
4. Проверьте через `tests/contract` и `tests/integration`:
   - активацию только через публичный lifecycle;
   - выполнение операции через общий `OperationBus`;
   - публикацию события после коммита;
   - разрешение `ResourceRef`;
   - появление UI-метаданных в согласованном слоте;
   - однократное применение миграции на чистой базе;
   - идемпотентность обработки события и очистку связей удалённого ресурса.
5. Прогоните `pnpm check:imports`: проверка границ должна подтвердить, что
   плагин не импортирует внутренности ядра, доменные плагины, SQL и драйвер.

Контрактные проверки намеренно работают только с публичным поведением и не
зависят от внутренних классов ядра.
