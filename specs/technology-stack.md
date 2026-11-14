# Технологический стек

- Статус: принят
- Дата: 2026-11-06

## 1. Назначение

Этот файл — единственный источник истины по технологическому стеку Kanbaner для ИИ-агентов.

Правила:

- `README.md` описывает продукт для людей и не является источником технических решений.
- Архитектурные роли и границы описаны в `architecture.md`.
- Конкретные библиотеки, инструменты и версии фиксируются здесь.
- Если код или задача противоречат этому файлу, агент останавливается и сообщает о конфликте.
- Добавление альтернативного фреймворка, ORM, UI-библиотеки или test runner требует явного решения пользователя и обновления этого файла.

## 2. Runtime и язык

| Область | Решение | Базовая версия | Правила |
|---|---|---|---|
| Runtime | Node.js LTS | 24.22.2 | Ветка 24 в Maintenance LTS до 2028-04-30; переход на Node.js 26 LTS — отдельная задача |
| Язык | TypeScript | 6.0.3 | Диапазон `6.0.x`, `strict: true`, без `any` в публичных контрактах |
| Модули | ESM | — | `module: NodeNext`, корректные `exports` в пакетах |
| Package manager | pnpm | 12.18.x | pnpm workspaces, единый `pnpm-lock.yaml` |
| ОС | Linux и Windows | — | Пути только через `node:path`, без bash-зависимых скриптов |

TypeScript закреплён на `6.0.x`, а не на актуальном 7.0.x: `typescript-eslint@8.72.1`, от которого зависит `eslint-config-next`, поддерживает `typescript <6.1.0`. Обновление до TypeScript 7 допускается только после появления совместимого lint-стека.

Типы:

| Пакет | Версия | Правила |
|---|---|---|
| `@types/node` | 24.19.x | Соответствует runtime Node.js 24 |
| `@types/semver` | 7.8.x | Типы для SemVer-диапазонов Host API |
| `@types/react` | 19.3.x | Соответствует React 19.3 |
| `@types/react-dom` | 19.3.x | Соответствует React DOM 19.3 |
| `@types/better-sqlite3` | 9.6.x | Major не совпадает с драйвером; это нормально |

## 3. Приложение и UI

| Область | Решение | Базовая версия | Правила |
|---|---|---|---|
| Web framework | Next.js, App Router | 16.4.x | Route Handlers, Node.js runtime |
| UI runtime | React | 19.3.1 | Server Components по умолчанию, клиентские компоненты только при необходимости |
| DOM runtime | React DOM | 19.3.1 | Версия React и React DOM должна совпадать |
| CSS | Tailwind CSS | 4.3.x | Конфигурация через CSS-first подход Tailwind 4 |
| PostCSS plugin | `@tailwindcss/postcss` | 4.3.x | Подключение Tailwind 4 к Next.js |
| Анимации | `tw-animate-css` | 1.4.x | Требуется актуальной инициализацией shadcn/ui |
| Компоненты | shadcn/ui | CLI 4.23.x | Компоненты копируются в репозиторий и принадлежат проекту |
| UI primitives | Radix UI | 1.8.x | CLI устанавливает нужный Radix-пакет вместе с компонентом |
| Иконки | Lucide React | 1.70.x | Единый набор иконок |
| HTTP-клиент | встроенный `fetch` | — | Без Axios и аналогичных обёрток |
| Markdown | `react-markdown` + `remark-gfm` | 10.1.x / 4.0.x | Только React-рендер без raw HTML; исходный Markdown хранится доменом, sanitization URL по умолчанию |
| Визуальный Markdown-редактор | `@blocknote/core` + `@blocknote/react` + `@blocknote/shadcn` | 0.54.x | Блоки, side menu, formatting toolbar и slash-действия в `plugin-notes`; canonical content остаётся Markdown, UI использует существующий shadcn/Tailwind-стек |
| Markdown AST | `mdast-util-from-markdown` | 2.1.x | Image-узлы для attachment ownership и экспорта; не заменяет JSON Schema и не допускает raw HTML в UI |

Правила UI-стека:

- shadcn/ui является единственной базой компонентов.
- Не добавлять вторую component library, включая Mantine и её варианты BlockNote.
  Для BlockNote используется только `@blocknote/shadcn`.
- Не создавать собственный design system поверх shadcn/ui без решения пользователя.
- Component-level зависимости shadcn/ui устанавливаются CLI; не дублировать их вручную.
- Tailwind-классы используются в приложении; публичный Plugin SDK не зависит от Tailwind и React.
- Основные действия доступны с клавиатуры; drag-and-drop не является единственным способом.

## 4. Хранение

| Область | Решение | Базовая версия | Правила |
|---|---|---|---|
| Основной backend | SQLite WAL | — | Единственный backend MVP |
| Драйвер | better-sqlite3 | 13.0.x | Синхронный API скрыт внутри асинхронного Storage Provider |
| Полнотекстовый поиск | FTS5 | — | Токенизатор `unicode61`, без обещания русского стемминга |
| Backup | SQLite `.backup()` | — | Online backup внутри приложения |
| ORM / query builder | не используется | — | Доменный код работает через Store-контракты |
| Внешняя СУБД | не используется | — | Без PostgreSQL, MySQL, Docker и TCP-порта |

Запрещены в MVP:

- Prisma, Drizzle, Kysely и другие ORM/query builders;
- PGlite и внешний PostgreSQL;
- SQL, `PRAGMA`, `MATCH` и `RETURNING` в доменном коде;
- `rowid` и `autoIncrement` как публичный ID;
- ручное копирование файлов базы, WAL и SHM работающего приложения.

## 5. Контракты и валидация

| Область | Решение | Базовая версия | Правила |
|---|---|---|---|
| Описание схем | TypeBox | 0.34.x | TypeBox — источник TypeScript-типов и JSON Schema |
| Runtime-валидация | Ajv | 8.20.x | Draft 2020-12 подключается через `ajv/dist/2020` |
| Форматы JSON Schema | `ajv-formats` | 3.0.x | Стандартные форматы Ajv, включая `date-time` |
| SemVer-диапазоны | `semver` | 7.8.x | Проверка `hostApi` и совместимости версий |
| Формат контрактов | JSON Schema | Draft 2020-12 | Совместимость проверяется контрактными тестами |
| MCP | официальный MCP SDK | 1.32.x | Только внешний адаптер поверх HTTP API |
| Peer-зависимость MCP | Zod | 4.6.x | Обязательный peer MCP SDK; не используется в доменных контрактах |

Правила:

- Не дублировать JSON Schema и TypeScript-типы вручную.
- Валидация выполняется до вызова обработчика и до записи.
- MCP не получает доступа к базе и Storage Provider.
- TypeBox и Ajv остаются единственным способом описания и валидации доменных контрактов; `ajv-formats` дополняет Ajv стандартными форматами.
- `semver` используется только для проверки и сопоставления SemVer/Host API-диапазонов, а не как замена JSON Schema.
- Zod допустим только как peer-зависимость MCP SDK.

## 6. Инструменты разработки

| Область | Решение | Базовая версия | Правила |
|---|---|---|---|
| Сборка пакетов | tsup | 9.0.x | ESM, declaration files, без отдельного bundler-фреймворка |
| Сборка приложения | `next build` | 16.4.x | Production build на Node.js runtime |
| Линтер | ESLint | 9.39.x | Flat config |
| Конфигурация Next.js | `eslint-config-next` | 16.4.5 | Синхронизируется с minor-версией Next.js |
| TypeScript lint | `typescript-eslint` | 8.72.x | Поддерживает TypeScript `<6.1.0` |
| Форматирование | Prettier | 3.9.x | Единая конфигурация |
| Логирование | Pino | 10.4.x | Структурированные логи, без содержимого заметок и секретов |
| Git hooks | не фиксируются | — | Добавляются только по отдельному решению |

ESLint закреплён на `9.39.x`, а не на `10.x`: `eslint-config-next@16.4.5` подключает `eslint-plugin-react`, `eslint-plugin-import` и `eslint-plugin-jsx-a11y`, чьи актуальные peer-диапазоны поддерживают ESLint максимум 9. Переход на ESLint 10 допускается только после появления совместимых версий всего lint-стека. Нельзя обходить это ограничение через `peerDependencyRules.allowedVersions`, `legacy-peer-deps` или force-установку.

По явному решению пользователя от 2026-11-06 `eslint@9.39.x` является единственным временным исключением из запрета deprecated-зависимостей: все стабильные версии ESLint 9 помечены npm как deprecated после выхода ESLint 10, но совместимый с ним `eslint-config-next` пока не поддерживает ESLint 10. Исключение не распространяется на другие пакеты и должно быть снято при первом возможном обновлении совместимого lint-стека.

## 7. Тестирование

| Уровень | Инструмент | Базовая версия | Правила |
|---|---|---|---|
| Unit и integration | Vitest | 5.1.x | Основной test runner |
| Bundler для тестов | Vite | 8.3.x | Обязательный peer Vitest 5 |
| React transform | `@vitejs/plugin-react` | 6.2.x | Требуется для component-тестов |
| DOM-окружение | jsdom | 31.0.x | Требует Node.js не ниже 24.15 |
| React-компоненты | Testing Library React | 16.3.x | Поведение, а не внутренняя реализация |
| Testing Library DOM | `@testing-library/dom` | 10.4.x | Обязательный peer Testing Library React и jest-dom |
| DOM-матчеры | jest-dom | 7.0.x | Подключается только в UI-тестах |
| E2E | `@playwright/test` | 1.65.x | Основные сценарии в реальном браузере |
| Storage conformance | общий suite | — | Запускается на SQLite и in-memory provider |

Правила:

- Тесты не требуют Docker, Testcontainers или внешней СУБД.
- Один Storage Provider Conformance Suite используется для всех провайдеров.
- Тесты с асинхронным provider должны выявлять синхронные предположения.
- Typecheck, lint и релевантные тесты обязательны до завершения задачи.
- Пакет E2E называется `@playwright/test`, а не `playwright`.

## 8. Версии и обновления

- Базовые версии зафиксированы на 2026-11-06 по npm registry.
- На эту дату прямые пакеты из этого файла не имеют статуса `deprecated`, кроме явно разрешённого исключения `eslint@9.39.x`.
- Точные версии пакетов определяются `pnpm-lock.yaml`.
- Patch- и minor-обновления внутри указанного major допустимы без изменения этого файла.
- Исключение: TypeScript остаётся в диапазоне `6.0.x`; обновление до `6.1` или `7.0` требует совместимого `typescript-eslint`.
- Для пакетов `0.x` minor-версия считается несовместимой: обновление требует проверки и обновления файла.
- Переход на новый major любой ключевой технологии требует обновления этого файла и проверки совместимости.
- Node.js 24 остаётся на Maintenance LTS до 2028-04-30; переход на Node.js 26 LTS выполняется отдельной задачей с проверкой `better-sqlite3` на Linux и Windows.
- Прямые и транзитивные deprecated-зависимости запрещены, кроме единственного временного исключения `eslint@9.39.x`, описанного в разделе 6.
- Предупреждения `deprecated` и `unmet peer dependency` устраняются, а не скрываются флагами установки.
- Чистая установка проверяется через `pnpm install --strict-peer-dependencies`.
- Нельзя незаметно заменять зафиксированный инструмент аналогом «по удобству».

## 9. Что не входит в стек MVP

- Docker и контейнеризация приложения;
- внешний сервер БД;
- ORM и универсальный SQL-слой;
- встроенный ИИ, embeddings и векторная БД;
- GraphQL;
- микросервисы и очередь сообщений;
- Electron, Tauri и мобильные приложения;
- альтернативная UI-библиотека;
- второй test runner или второй package manager.

## 10. Связанные документы

- [Контекст проекта](context.md)
- [Продуктовая спецификация MVP](product-mvp.md)
- [Архитектура](architecture.md)
- [Контракт плагинов v1](plugin-contract.md)
- [План реализации](roadmap.md)
