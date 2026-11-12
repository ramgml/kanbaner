# Kanbaner

Kanbaner — локальная однопользовательская система управления задачами и заметками с адаптивным веб-интерфейсом и минимальным plugin-ядром.

Ядро предоставляет инфраструктуру плагинов, команды, запросы, события, хранение, UI-слоты и миграции. Домен задач и интерфейс рабочего пространства реализованы отдельными плагинами.

## Текущее состояние

Реализованы и покрыты тестами:

- plugin runtime, публичный SDK, манифесты, зависимости, UI-вклады и safe mode;
- SQLite Storage Provider в WAL-режиме, namespaced document storage и миграции;
- проекты, задачи, один уровень подзадач, пользовательские колонки, приоритеты, сроки и теги;
- список и канбан в едином UI-плагине `kanbaner.projects`;
- создание и inline-редактирование карточек, drag-and-drop и доступные альтернативы через меню;
- массовый перенос и удаление карточек атомарными доменными командами;
- настройки проекта и колонок, мобильный интерфейс от 360 px;
- production Playwright-сценарии в Chromium.

Заметки, отдельный поиск, HTTP API и MCP относятся к следующим этапам `specs/roadmap.md` и ещё не входят в текущий рабочий срез.

## Требования

| Инструмент | Версия                                     |
| ---------- | ------------------------------------------ |
| Node.js    | `24.22.2` (точная версия, Maintenance LTS) |
| pnpm       | `12.18.x` через Corepack                   |
| ОС         | Linux или Windows                          |

Версии зафиксированы в `package.json` (`engines`, `packageManager`), а `.npmrc` включает `engine-strict=true` и `strict-peer-dependencies=true`.

Docker, внешняя СУБД и TCP-порт для базы данных не используются. Для `better-sqlite3` используется prebuilt-бинарник; если для платформы его нет, потребуется toolchain для сборки из исходников.

## Установка

### Linux

```bash
corepack enable
corepack prepare pnpm@12.18.0 --activate
pnpm install --frozen-lockfile --strict-peer-dependencies
```

### Windows (PowerShell)

```powershell
corepack enable
corepack prepare pnpm@12.18.0 --activate
pnpm install --frozen-lockfile --strict-peer-dependencies
```

Если Node.js установлен в защищённый каталог, `corepack enable` может потребовать терминал с правами администратора. Альтернатива без глобальных shim-файлов:

```powershell
corepack pnpm install --frozen-lockfile --strict-peer-dependencies
```

## Запуск

```bash
pnpm dev
```

Приложение открывается на [http://127.0.0.1:3000](http://127.0.0.1:3000). Сервер по умолчанию слушает только localhost.

`pnpm dev` сначала собирает пакеты плагинов. Dev-сервер использует их собранный `dist`, поэтому после изменения исходников пакета без перезапуска сервера нужно выполнить:

```bash
pnpm build:packages
```

Production-сборка и запуск:

```bash
pnpm build
pnpm start
```

Проверка server composition root без запуска браузера:

```bash
pnpm check:composition
```

Composition root регистрирует SQLite Storage Provider, домен `kanbaner.tasks`, UI `kanbaner.projects` и fixture-плагин для проверки plugin-механизма.

## Команды

| Команда                                                     | Назначение                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm install --frozen-lockfile --strict-peer-dependencies` | Воспроизводимая установка зависимостей                       |
| `pnpm dev`                                                  | Сборка пакетов и запуск Next.js в режиме разработки          |
| `pnpm build:packages`                                       | Сборка SDK, ядра, Storage Provider и встроенных плагинов     |
| `pnpm build`                                                | Сборка пакетов и production-сборка приложения                |
| `pnpm start`                                                | Запуск production-сервера                                    |
| `pnpm typecheck`                                            | Строгая проверка TypeScript во всех пакетах                  |
| `pnpm lint`                                                 | ESLint                                                       |
| `pnpm lint:fix`                                             | ESLint с автоматическим исправлением                         |
| `pnpm format`                                               | Форматирование Prettier                                      |
| `pnpm format:check`                                         | Проверка форматирования                                      |
| `pnpm test`                                                 | Сборка пакетов и все unit/integration-тесты Vitest           |
| `pnpm test:watch`                                           | Vitest в watch-режиме                                        |
| `pnpm test:sqlite`                                          | Smoke-тест in-memory SQLite                                  |
| `pnpm --filter @kanbaner/web test:e2e`                      | Production E2E в Playwright Chromium                         |
| `pnpm check:composition`                                    | Запуск и проверка server composition root                    |
| `pnpm check:imports`                                        | Проверка архитектурных границ импортов                       |
| `pnpm storage:restore`                                      | Offline restore в новый каталог при остановленном приложении |
| `pnpm check`                                                | Форматирование, lint, typecheck, тесты и production build    |

Миграции Storage Provider применяются автоматически при bootstrap до активации плагинов. Доменные проекты, колонки и задачи хранятся как JSON-документы через Store-контракты; доменный код не содержит SQL.

## Основные каталоги

```text
apps/web/                    Next.js App Router, UI shell и composition root
packages/kernel/             Plugin runtime и инфраструктурные сервисы
packages/plugin-sdk/         Публичный Plugin Contract и SDK
packages/storage-sqlite/     SQLite Storage Provider и миграции
packages/plugin-tasks/       Headless-домен проектов, колонок и задач
packages/plugin-projects/    Sidebar, список, канбан и настройки проекта
packages/task-ui/            Общие клиентские UI-компоненты и форматирование
packages/plugin-fixture/     Тестовый плагин plugin-механизма
specs/                       Продуктовые, архитектурные и процессные решения
tasks/                       Локальный трекер задач и отчёты
```

Границы импортов: `kernel` зависит от `plugin-sdk`, но не от плагинов. Плагины используют SDK и публичные контракты, не импортируя внутренние модули друг друга.

## Каталог данных

Каталог задаётся переменной окружения `KANBANER_DATA_DIR`. Если переменная пуста, используются каталоги ОС:

- Linux: `~/.local/share/kanbaner/data`;
- Windows: `%APPDATA%\Kanbaner\data`.

Linux:

```bash
export KANBANER_DATA_DIR="$HOME/kanbaner-data"
```

Windows (PowerShell):

```powershell
$env:KANBANER_DATA_DIR = "$env:USERPROFILE\kanbaner-data"
```

Пути формируются через `node:path`. Базу нельзя размещать на сетевой файловой системе. Один экземпляр приложения владеет одним каталогом данных.

Пример переменных окружения находится в `.env.example`. Секреты в репозиторий не коммитятся.

## SQLite и восстановление

Драйвер `better-sqlite3` проверяется smoke-тестом:

```bash
pnpm test:sqlite
```

На Linux и Windows pnpm сначала использует prebuilt-бинарник. Если его нет:

- Linux: нужны Python 3, `make` и C++ toolchain (`build-essential` или аналог);
- Windows: нужны Python 3 и Visual Studio Build Tools с workload «Desktop development with C++».

Резервное копирование работающего приложения выполняется только online через Storage Provider. Восстановление выполняется при остановленном приложении в новый каталог данных:

```bash
pnpm storage:restore -- --backup <backup-file> --data-dir <new-data-directory>
```

Не копируйте файлы базы, WAL и SHM работающего приложения вручную.

## Документы

- [Контекст проекта](specs/context.md)
- [Продуктовая спецификация MVP](specs/product-mvp.md)
- [Технологический стек](specs/technology-stack.md)
- [Архитектура](specs/architecture.md)
- [Контракт плагинов v1](specs/plugin-contract.md)
- [Процесс разработки и релизов](specs/development-workflow.md)
- [План реализации](specs/roadmap.md)
- [UI-плагин проектов](packages/plugin-projects/README.md)
- [Домен задач](packages/plugin-tasks/README.md)
- [Задачи разработки](tasks/README.md)
