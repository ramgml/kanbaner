# Kanbaner

Локальная веб-система управления задачами и заметками, построенная как минимальное plugin-ядро.

Канбан, список задач, заметки, поиск и интеграция с внешними агентами являются плагинами. Ядро
отвечает только за загрузку расширений, команды, события, хранение, UI-слоты и HTTP API.

## Статус

Реализован каркас репозитория (KAN-001): pnpm workspace, Next.js-приложение, заглушки
`@kanbaner/kernel` и `@kanbaner/plugin-sdk`, строгий TypeScript, ESLint, Prettier, Vitest и
smoke-проверка `better-sqlite3`.

Storage Provider Registry, Store-контракты, миграции, доменные плагины, HTTP API и MCP в каркас
не входят. Они добавляются следующими задачами.

## Требования

| Инструмент | Версия                                     |
| ---------- | ------------------------------------------ |
| Node.js    | `24.22.2` (точная версия, Maintenance LTS) |
| pnpm       | `12.18.x` через Corepack                   |
| ОС         | Linux или Windows                          |

Node.js и pnpm зафиксированы в `package.json` (`engines`, `packageManager`), а `.npmrc` включает
`engine-strict=true` и `strict-peer-dependencies=true`. Другая версия Node.js не подходит.

Docker, внешняя СУБД и TCP-порт для базы данных не используются. Для `better-sqlite3` достаточно
prebuilt-бинарника; если для вашей платформы его нет, потребуется toolchain для сборки из исходников
(см. раздел «SQLite»).

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

Если Node.js установлен в защищённый каталог, `corepack enable` может потребовать терминал с
правами администратора. Альтернатива без глобальных shim-файлов:

```powershell
corepack pnpm install --frozen-lockfile --strict-peer-dependencies
```

Пути к Node.js и pnpm не должны содержать несовместимых символов; сам проект корректно работает с
пробелами и не-ASCII символами в пути.

## Запуск

```bash
pnpm dev
```

Приложение открывается на [http://127.0.0.1:3000](http://127.0.0.1:3000) и показывает
страницу-заглушку каркаса. Сервер слушает только localhost.

Production-сборка и запуск:

```bash
pnpm build
pnpm start
```

`pnpm build` сначала собирает пакеты `@kanbaner/plugin-sdk` и `@kanbaner/kernel`, затем выполняет
`next build` на Node.js runtime. Edge runtime для серверной части не используется.

Проверка server composition root без запуска браузера:

```bash
pnpm check:composition
```

Команда выполняет `apps/web/src/server/composition-root.ts` и убеждается, что Storage Provider и
доменные плагины не зарегистрированы.

## Команды

| Команда                                                     | Назначение                                            |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `pnpm install --frozen-lockfile --strict-peer-dependencies` | Воспроизводимая установка зависимостей                |
| `pnpm dev`                                                  | Сборка пакетов и запуск Next.js в режиме разработки   |
| `pnpm build`                                                | Сборка пакетов и production-сборка приложения         |
| `pnpm start`                                                | Запуск production-сервера                             |
| `pnpm typecheck`                                            | Строгая проверка TypeScript во всех пакетах           |
| `pnpm lint`                                                 | ESLint 9 с `eslint-config-next` и `typescript-eslint` |
| `pnpm lint:fix`                                             | ESLint с автоматическим исправлением                  |
| `pnpm format`                                               | Форматирование Prettier                               |
| `pnpm format:check`                                         | Проверка форматирования                               |
| `pnpm test`                                                 | Сборка пакетов и все unit/integration-тесты Vitest    |
| `pnpm test:watch`                                           | Vitest в watch-режиме                                 |
| `pnpm test:sqlite`                                          | Smoke-тест in-memory SQLite (`SELECT 1`)              |
| `pnpm check:composition`                                    | Запуск server composition root                        |
| `pnpm check`                                                | Полный локальный набор проверок                       |

E2E-тесты и миграции появятся в следующих этапах; команд для них пока нет.

## Структура

```text
apps/web/            Next.js App Router, UI shell и server composition root
packages/kernel/     Заглушка ядра без Storage Provider и доменной логики
packages/plugin-sdk/ Заглушка публичного SDK плагинов
specs/               Продуктовые, архитектурные и процессные спецификации
tasks/               Локальный трекер задач и отчёты
```

Границы импортов: `kernel` может зависеть от `plugin-sdk`, плагины зависят только от
`plugin-sdk` и публичных контрактов. Доменной логики в каркасе нет.

## Каталог данных

Каталог задаётся переменной окружения `KANBANER_DATA_DIR`. Если переменная пуста, используются
каталоги ОС:

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

Пути формируются средствами Node.js (`node:path`), поэтому работают с пробелами и не-ASCII
символами. Базу нельзя размещать на сетевой файловой системе. Один экземпляр приложения владеет
одним каталогом данных.

Пример переменных окружения находится в `.env.example`. Секреты в репозиторий не коммитятся.

## SQLite

Драйвер `better-sqlite3` установлен как нативный модуль и проверяется smoke-тестом:

```bash
pnpm test:sqlite
```

Тест открывает in-memory базу и выполняет `SELECT 1`. На Linux и Windows pnpm сначала использует
prebuilt-бинарник. Если его нет:

- Linux: нужны Python 3, `make` и C++ toolchain (`build-essential` или аналог);
- Windows: нужны Python 3 и Visual Studio Build Tools с workload «Desktop development with C++».

Docker и установленный сервер базы данных не требуются.

## Документы

- [Контекст проекта](specs/context.md)
- [Продуктовая спецификация MVP](specs/product-mvp.md)
- [Технологический стек](specs/technology-stack.md)
- [Архитектура](specs/architecture.md)
- [Контракт плагинов v1](specs/plugin-contract.md)
- [Процесс разработки и релизов](specs/development-workflow.md)
- [План реализации](specs/roadmap.md)
- [Задачи разработки](tasks/README.md)
