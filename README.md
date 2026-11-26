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
- дерево заметок в глобальной боковой панели и изменение её ширины мышью или
  клавиатурой с сохранением между перезагрузками;
- Lucide-иконки, сохраняемые цвета доски/колонок и акценты приоритетов;
- тонкие скроллбары с цветом для light/dark темы и системным forced-colors режимом;
- безопасный CommonMark/GFM в описании карточки и его hover/focus-подсказке;
- Notion-подобные заметки `kanbaner.notes`: визуальный Markdown, дерево страниц,
  автосохранение, избранное/недавние, полнотекстовый поиск, связи ResourceRef,
  локальные изображения и экспорт `.md`;
- глобальный поиск `kanbaner.search` по задачам, заметкам и провайдерам
  активных плагинов с фильтрами по типу, проекту, статусу и тегам, переходом по
  ResourceRef, клавиатурным открытием результата и постраничной догрузкой
  («Показать ещё»);
- production Playwright-сценарии в Chromium;
- HTTP API v1 с Bearer token, discovery, command/query transport и ResourceRef;
- агентный CLI с универсальными операциями и доменными сокращениями;
- необязательную правую панель OpenCode с выбором модели, streaming-ответами,
  вложениями prompt, полным built-in toolset и ограниченными MCP-операциями
  над проектами, задачами и заметками;
- универсальный discovery-driven MCP `@kanbaner/mcp` (`kanbaner-mcp-universal`)
  поверх `/api/v1` с генерацией инструментов из `exposure.mcp` и без доступа к
  базе данных.

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

Composition root регистрирует SQLite Storage Provider, домены `kanbaner.tasks` и `kanbaner.notes`, UI `kanbaner.projects`/`kanbaner.notes`/`kanbaner.opencode` и fixture-плагин для проверки plugin-механизма.

## HTTP API и CLI

Сервер предоставляет:

```text
GET  /api/v1/health
GET  /api/v1/discovery
POST /api/v1/commands/{commandId}
POST /api/v1/queries/{queryId}
GET  /api/v1/resources/{encodedResourceRef}
```

Все маршруты `/api/v1`, кроме `health`, требуют `Authorization: Bearer <token>`. Задайте токен локально в `KANBANER_API_TOKEN`; при пустом значении защищённые маршруты отключены. HTTP API выполняет те же операции, что UI, и не открывает отдельного доступа к базе. Внутренние `/api/opencode/*` используют отдельный same-origin UI transport и не принимают Bearer token из браузера.

CLI ориентирован на агентов и выводит единый JSON-конверт:

```bash
export KANBANER_API_TOKEN="local-secret"
pnpm build:packages
pnpm --silent cli discovery
pnpm --silent cli project create --title "Проект от агента" --idempotency-key "create-1"
pnpm --silent cli task list --project <project-id>
pnpm --silent cli query kanbaner.tasks.task.list --input '{"status":"todo"}'
```

Универсальный input можно передать файлом или через stdin: `--input-file ./request.json` или `--input-file -`. Разрушительные доменные команды требуют `--confirm`. Подробный интерфейс, коды выхода и все флаги описаны в [`packages/cli/README.md`](packages/cli/README.md).

## OpenCode

Панель OpenCode закрыта по умолчанию и открывается кнопкой со звездой. На desktop она расположена справа, на мобильном — на весь экран. Плагин использует текущий OpenCode Service через `Service.ensure()` и показывает только активные chat-модели его конфигурации; embedded SDK не используется.

Для MCP задайте один и тот же локальный токен в двух игнорируемых Git файлах:

- `apps/web/.env.local`: `KANBANER_API_TOKEN=<local-secret>` — для HTTP API;
- `apps/web/.env.api-token`: `KANBANER_API_TOKEN=<local-secret>` — для file substitution в `opencode.jsonc`.

Запустите приложение на `127.0.0.1:3000`, выполните `pnpm build:packages` и проверьте `opencode mcp list`: сервер `kanbaner` должен быть `connected`. Секрет не записывается в `opencode.jsonc` и не передаётся в браузер. Если приложение слушает другой адрес, измените `KANBANER_API_URL` в локальном OpenCode environment, не добавляя токен в конфигурацию.

Chat-агент `kanbaner` по явному решению пользователя от 2026-11-20 имеет полный доступ к стандартным built-in tools OpenCode: `question`, `websearch`, `webfetch`, `read`, `glob`, `grep`, `edit`, `shell`, `subagent`, `skill` и `external_directory`. `edit` покрывает `edit`/`write`/`patch`. Это не песочница: агент может читать и изменять локальные файлы, включая секреты и `.env`, выполнять команды с правами пользователя и обращаться к сети. Не давайте агенту доступ к репозиторию или машине, если такие права нежелательны.

Ручной MCP allowlist Kanbaner остаётся ограниченным: list/get/create/update/complete/move для проектов, задач и заметок. Delete MCP tools, сторонние MCP servers и Code Mode `execute` не включены. Раскрываемый список в панели показывает built-in tools и Kanbaner MCP отдельными группами с `risk` read/write и предупреждением «Полный доступ: интернет, файлы и shell»; для MCP также виден обязательный `expectedVersion`. Подробности transport, сессий и тестирования — в [`packages/opencode/README.md`](packages/opencode/README.md).

## Универсальный MCP

`@kanbaner/mcp` — отдельный stdio-процесс `kanbaner-mcp-universal`. Он не читает базу и не содержит доменной логики: при каждом `tools/list` и `tools/call` адаптер перечитывает `/api/v1/discovery` и публикует только операции с `exposure.http = true` и `exposure.mcp = true`.

```bash
pnpm build:packages
KANBANER_API_TOKEN="local-secret" node packages/mcp/dist/cli.js
```

Переменные окружения: обязательный `KANBANER_API_TOKEN`, необязательные `KANBANER_API_URL` (по умолчанию `http://127.0.0.1:3000`), `KANBANER_MCP_TIMEOUT_MS` и `KANBANER_MCP_ALLOW_DESTRUCTIVE=true` для явного включения destructive-инструментов. Вызовы идут через `/api/v1` с `x-kanbaner-client: mcp`; аудит помечает их `source.type = mcp`. Вход и выход валидируются по JSON Schema, mutation с поддержкой идемпотентности получает `Idempotency-Key`, сообщения и `details` проходят redaction, а bearer token не попадает в ответы.

Универсальный адаптер не меняет ручной allowlist из 14 инструментов в `@kanbaner/opencode`. Текущий доменный срез: list/get для проектов и задач, `column.list`, create/update проектов и задач, task complete/move; delete, bulk и summary закрыты. Заметки сохраняют свой существующий `exposure.mcp`, `kanbaner.search.query` опубликован, а `kanbaner.search.filters` — нет. Полная конфигурация, discovery-контракт и ограничения — в [`packages/mcp/README.md`](packages/mcp/README.md).

К prompt можно прикрепить до 5 файлов общим размером до 8 MiB: UTF-8 текст или код до 1 MiB, PNG/JPEG/GIF/WebP/PDF до 5 MiB каждый. Браузер читает файл через `FileReader`, сервер проверяет Base64, UTF-8 и сигнатуру формата и передаёт выбранной модели только inline `data:` URL; `file:` URL, путь на сервере и чтение файлов с диска не используются. Если выбранная модель не поддерживает image/PDF-вход, панель предупреждает, но не блокирует отправку: OpenCode/provider может заменить вложение служебной заметкой или отклонить его. В истории остаются имя и MIME-тип без base64. Изображения показывают preview в composer и сообщениях; после перезагрузки canonical preview отдельно загружается через guarded same-origin binary endpoint, без Base64 в history JSON.

## Команды

| Команда                                                     | Назначение                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm install --frozen-lockfile --strict-peer-dependencies` | Воспроизводимая установка зависимостей                       |
| `pnpm dev`                                                  | Сборка пакетов и запуск Next.js в режиме разработки          |
| `pnpm build:packages`                                       | Сборка SDK, ядра, Storage Provider, плагинов и MCP/CLI       |
| `pnpm build`                                                | Сборка пакетов и production-сборка приложения                |
| `pnpm start`                                                | Запуск production-сервера                                    |
| `pnpm --silent cli --help`                                  | Справка агентного CLI HTTP API                               |
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
packages/opencode/           Панель OpenCode, Service gateway, built-in tools и ограниченный MCP
packages/mcp/                Универсальный discovery-driven stdio MCP-адаптер
packages/cli/                Универсальный и доменный CLI для HTTP API
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
pnpm storage:restore --backup <backup-file> --data-dir <new-data-directory>
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
- [Универсальный MCP](packages/mcp/README.md)
- [Задачи разработки](tasks/README.md)
