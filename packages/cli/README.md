# Kanbaner CLI

`@kanbaner/cli` — локальный Node.js-клиент HTTP API Kanbaner, предназначенный прежде всего для внешних агентов и скриптов. CLI не подключается к SQLite и не содержит отдельной доменной реализации: универсальные и доменные команды вызывают один Operation Bus через HTTP.

## Запуск

Соберите workspace-пакеты из корня репозитория:

```bash
pnpm build:packages
```

Запуск через root-script:

```bash
pnpm --silent cli --help
pnpm --silent cli health
```

`--silent` отключает служебные строки pnpm в stdout. При прямом вызове бинарного entrypoint этот флаг не нужен.

Также можно напрямую вызвать собранный entrypoint:

```bash
node packages/cli/dist/cli.js health
```

## Конфигурация

| Настройка            | Флаг           | Назначение                                                   |
| -------------------- | -------------- | ------------------------------------------------------------ |
| `KANBANER_API_URL`   | `--url`        | Базовый URL приложения; по умолчанию `http://127.0.0.1:3000` |
| `KANBANER_API_TOKEN` | —              | Bearer token; обязателен для всех операций, кроме `health`   |
| —                    | `--timeout-ms` | Таймаут HTTP-запроса; по умолчанию `15000`                   |
| —                    | `--request-id` | Значение `X-Request-Id` для трассировки                      |
| —                    | `--pretty`     | Многострочный JSON вместо компактного                        |

CLI читает переменные из окружения процесса и не загружает `.env` самостоятельно. Токен принимается только через окружение, чтобы не оставлять его в истории shell и списке аргументов процесса.

Linux/macOS-подобный shell:

```bash
export KANBANER_API_URL="http://127.0.0.1:3000"
export KANBANER_API_TOKEN="local-secret"
```

Windows PowerShell:

```powershell
$env:KANBANER_API_URL = "http://127.0.0.1:3000"
$env:KANBANER_API_TOKEN = "local-secret"
```

Сервер использует ту же переменную `KANBANER_API_TOKEN` для проверки Bearer token. Не передавайте токен в логи, аргументы CLI или содержимое заметок.

## Машинный формат

Каждый API-вызов выводит в stdout ровно один JSON-конверт Plugin Contract:

```json
{ "ok": true, "data": { "items": [], "total": 0, "nextOffset": null } }
```

Ошибка сохраняет стабильный код и детали:

```json
{
  "ok": false,
  "error": { "code": "VERSION_CONFLICT", "message": "Конфликт версий", "retryable": false }
}
```

Коды выхода:

| Код | Значение                                                         |
| --- | ---------------------------------------------------------------- |
| `0` | `ok: true`                                                       |
| `1` | HTTP API вернул `ok: false`                                      |
| `2` | Ошибка аргументов, JSON input или конфигурации                   |
| `3` | Таймаут, недоступность API или нарушение транспортного контракта |

Ошибки CLI также выводятся как ErrorResult JSON. Текстовый вывод предназначен только для `--help`.

## Универсальные операции

### Health и discovery

```bash
pnpm --silent cli health
pnpm --silent cli discovery
```

`health` не требует токена. `discovery` возвращает `apiVersion`, `contractVersion` и отсортированный список HTTP-операций с `risk`, `idempotency`, `inputSchema` и `outputSchema`.

### Команда или запрос по ID

```bash
pnpm --silent cli query kanbaner.tasks.project.list --input '{"limit":20,"offset":0}'
pnpm --silent cli command kanbaner.tasks.project.create \
  --input '{"title":"Новый проект"}' \
  --idempotency-key 'agent-request-42'
```

По умолчанию input равен `{}`. Источники JSON нельзя комбинировать:

```bash
pnpm --silent cli query kanbaner.tasks.task.list --input-file ./request.json
cat ./request.json | pnpm --silent cli query kanbaner.tasks.task.list --input-file -
```

`--input -` также читает stdin. Без явного `-` CLI не ждёт stdin.

### ResourceRef

```bash
pnpm --silent cli resource 'kanbaner.tasks:project:project-id'
```

CLI кодирует ResourceRef как path parameter и возвращает стандартный результат адаптера ресурса.

## Доменные сокращения

Для версионируемых изменений передавайте актуальный `--expected-version`. Значение `null` у `--parent` и `--due-at` означает JSON `null`, а не отсутствие поля.

### Проекты и колонки

```bash
pnpm --silent cli project list [--limit N] [--offset N]
pnpm --silent cli project get <id>
pnpm --silent cli project create --title <title> [--description <markdown>] [--color <color>]
pnpm --silent cli project update <id> --expected-version N \
  [--title <title>] [--description <markdown>] [--color <color>]
pnpm --silent cli project delete <id> --expected-version N --confirm
pnpm --silent cli column list --project <id> [--limit N] [--offset N]
```

### Задачи

```bash
pnpm --silent cli task list [--project ID] [--column ID] [--status STATUS]
  [--priority PRIORITY] [--tag TAG] [--parent ID|null] [--text TEXT]
  [--due-before TIMESTAMP] [--due-after TIMESTAMP] [--sort SORT]
  [--limit N] [--offset N]

pnpm --silent cli task get <id>
pnpm --silent cli task create --project ID --title TITLE
  [--parent ID|null] [--column ID] [--description MARKDOWN]
  [--status STATUS] [--priority PRIORITY] [--due-at TIMESTAMP|null]
  [--position N] [--tag TAG ...]

pnpm --silent cli task update <id> --expected-version N
  [--title TITLE] [--description MARKDOWN] [--priority PRIORITY]
  [--due-at TIMESTAMP|null] [--tag TAG ...]

pnpm --silent cli task move <id> --expected-version N --position N (--column ID | --status STATUS)
pnpm --silent cli task complete <id> --expected-version N
pnpm --silent cli task delete <id> --expected-version N --confirm
```

В `task list` допустим один `--tag`; в `task create/update` флаг можно повторять. В `task move` обязателен хотя бы один из `--column` и `--status`; при совместном использовании они должны быть согласованы.

### Заметки

```bash
pnpm --silent cli note list [--parent ID|null] [--favorite true|false]
  [--recent true|false] [--limit N] [--offset N]
pnpm --silent cli note get <id>
pnpm --silent cli note search <text> [--limit N] [--offset N]
pnpm --silent cli note create [--parent ID|null] [--title TITLE] [--content MARKDOWN]
pnpm --silent cli note update <id> --expected-version N [--title TITLE] [--content MARKDOWN]
pnpm --silent cli note move <id> --expected-version N --parent ID|null [--position N]
pnpm --silent cli note favorite <id> --favorite true|false
pnpm --silent cli note delete <id> --expected-version N [--expected-descendants N] --confirm
pnpm --silent cli note link <noteId> <targetRef>
pnpm --silent cli note unlink <noteId> <sourceRef> <targetRef>
pnpm --silent cli note links <ref>
pnpm --silent cli note export <id>
```

`note export` возвращает JSON с `fileName`, `mediaType` и `content`; CLI не создаёт файлов самостоятельно. Для большого Markdown или операций без доменного сокращения используйте универсальную `command --input-file`.

## Идемпотентность и удаление

- `--idempotency-key <key>` доступен для доменных и универсальных команд-мутаций.
- CLI не выполняет автоматических retry: после таймаута неизвестно, была ли mutation зафиксирована.
- Доменные `delete` требуют `--confirm`; универсальные destructive-команды принимают `confirm: true` в JSON input.
- Подтверждение неинтерактивное, чтобы поведение агента было воспроизводимым.
