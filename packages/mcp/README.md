# `@kanbaner/mcp` — универсальный discovery-driven MCP

Необязательный stdio MCP-сервер Kanbaner. Он не подключается к базе данных и не
содержит доменной логики: при каждом `tools/list` и `tools/call` адаптер читает
`/api/v1/discovery` и вызывает разрешённые операции через Bearer-защищённый HTTP
API.

```text
MCP client
    │ stdio JSON-RPC
kanbaner-mcp-universal
    │ HTTP + Bearer token
Kanbaner /api/v1
```

## Сборка и запуск

```bash
pnpm build:packages
node packages/mcp/dist/cli.js
```

`@kanbaner/mcp` собирается в корневом `build:packages` сразу после
`@kanbaner/plugin-sdk` и до web-зависимого tooling. В web runtime пакет не
подключается.

Bin-имя: `kanbaner-mcp-universal`. Оно отличается от ручного ограниченного
`kanbaner-mcp` из `@kanbaner/opencode`, чтобы два адаптера можно было запускать
независимо.

## Конфигурация

| Переменная                       | Обязательна | Значение по умолчанию   | Описание                                                    |
| -------------------------------- | ----------- | ----------------------- | ----------------------------------------------------------- |
| `KANBANER_API_TOKEN`             | да          | —                       | Bearer token сервера; пустое значение считается отсутствием |
| `KANBANER_API_URL`               | нет         | `http://127.0.0.1:3000` | Абсолютный HTTP(S) URL без credentials, query и hash        |
| `KANBANER_MCP_TIMEOUT_MS`        | нет         | `15000`                 | Таймаут одного HTTP-запроса, от 1 до 120000 мс              |
| `KANBANER_MCP_ALLOW_DESTRUCTIVE` | нет         | `false`                 | `true` публикует destructive-операции с `mcp = true`        |

Случайный префикс `KANBANER_API_TOKEN=` в значении срезается: это совместимо с
file substitution в `opencode.jsonc`. Токен не печатается в stdout/stderr, не
попадает в JSON-RPC ошибки и не передаётся в аргументах CLI. При ошибке
конфигурации процесс завершается с кодом `2` и безопасным сообщением.

Пример подключения MCP-клиента:

```json
{
  "mcpServers": {
    "kanbaner-universal": {
      "command": "node",
      "args": ["/absolute/path/to/kanbaner/packages/mcp/dist/cli.js"],
      "env": {
        "KANBANER_API_URL": "http://127.0.0.1:3000",
        "KANBANER_API_TOKEN": "<local-secret>"
      }
    }
  }
}
```

## Discovery и экспорт

Discovery-конверт:

```json
{
  "ok": true,
  "data": {
    "apiVersion": 1,
    "contractVersion": 1,
    "operations": [
      {
        "id": "kanbaner.tasks.task.list",
        "kind": "query",
        "risk": "read",
        "exposure": { "ui": true, "http": true, "mcp": true },
        "inputSchema": { "type": "object" },
        "outputSchema": { "type": "object" }
      }
    ]
  }
}
```

Правила:

- Поддерживаются `apiVersion = 1` и `contractVersion = 1`.
- `exposure` обязателен и содержит точные boolean `ui`, `http`, `mcp`. Старый
  discovery без `exposure` отклоняется как `DISCOVERY_INCOMPATIBLE`.
- Публикуется операция только при `exposure.http === true && exposure.mcp === true`.
  `mcp = true` без HTTP нарушает контракт и также не публикуется.
- Destructive-операции (`risk = "destructive"`) публикуются только при
  `KANBANER_MCP_ALLOW_DESTRUCTIVE=true` и помечаются в описании и annotations.
- Discovery перечитывается на каждый `tools/list` и `tools/call`; статического
  кэша нет, поэтому новая разрешённая операция появляется без правок адаптера.
- Каталог строится детерминированно и сортируется по имени. Имя — command ID в
  нижнем регистре, недопустимые символы заменяются на `_`. Пустое или слишком
  длинное имя (больше 128 символов) не публикуется, коллизия исключает всех
  участников.
- JSON Schema входа и выхода должна компилироваться; иначе операция
  пропускается целиком. Input валидируется до HTTP-вызова, output — после.
- `structuredContent` и `outputSchema` объявляются только для object-схем.
  Non-object output не публикует `outputSchema` и возвращается текстовым JSON.
- Ошибка загрузки discovery возвращает структурированную MCP-ошибку, а не
  выдуманный пустой каталог.

## Вызов, source и ошибки

- Query вызывается через `POST /api/v1/queries/{id}`, mutation — через
  `POST /api/v1/commands/{id}`.
- Адаптер отправляет точный заголовок `x-kanbaner-client: mcp`. Сервер помечает
  такой вызов audit-source `{ "type": "mcp", "id": "mcp" }`; остальные
  HTTP-клиенты получают `{ "type": "http", "id": "api" }`. Bearer token остаётся
  обязательным.
- Ответ сервера должен быть валидным `OperationResult`. Серверный envelope
  authoritative: его `code`, `retryable` и `details` передаются клиенту после
  redaction.
- Для mutation с `idempotency = "supported"` отправляется `Idempotency-Key` —
  SHA-256 от operation ID, стабильного JSON input, JSON-RPC request ID, session
  ID (если есть), instance ID и process ID. Повтор с новым JSON-RPC ID намеренно
  создаёт новый ключ.
- Mutation без поддержки идемпотентности не повторяется после неопределённого
  post-dispatch сбоя: rejected fetch, ошибка чтения тела, non-JSON fallback и
  timeout получают `retryable: false`.
- Все сообщения проходят redaction: сначала вырезается токен из полного текста,
  затем сообщение ограничивается 500 символами. `details` санитизируются
  рекурсивно с ограничением глубины и количества узлов; `params` и опасные ключи
  удаляются.

Основные стабильные коды: `DISCOVERY_INCOMPATIBLE`, `UNKNOWN_TOOL`,
`VALIDATION_ERROR`, `VERSION_CONFLICT`, `NOT_FOUND`, `DEPENDENCY_UNAVAILABLE`,
`TIMEOUT`, `CANCELLED`, `INTERNAL_ERROR`. Код `VERSION_CONFLICT` и
`requiresExpectedVersion` требуют явного `expectedVersion` в input.

## Текущий allowlist доменов

Универсальный адаптер следует метаданным, а не собственному списку. В текущем
срезе:

- `kanbaner.tasks`: `project.list/get`, `column.list`, `task.list/get`,
  `project.create/update`, `task.create/update/complete/move`.
  `project.summary`, `column.create/update/move/delete`, `project.delete`,
  `task.delete/deleteMany/moveMany` остаются `mcp = false`.
- `kanbaner.notes`: существующий явный `exposure.mcp` не сужается. Через metadata
  публикуются `note.create/update/move/favorite.set/link/unlink`,
  `note.attachment.create`, `note.get/list/search/subtree/links`.
  `note.delete`, `note.attachment.delete`, `note.export`,
  `note.attachment.get` и `note.visit` остаются закрытыми.
- `kanbaner.search`: `kanbaner.search.query` публикуется, `kanbaner.search.filters`
  остаётся `mcp = false`.

Ручной OpenCode allowlist из `@kanbaner/opencode` не строится из
`exposure.mcp`, не расширяется автоматически и по-прежнему содержит ровно 14
инструментов. Универсальный адаптер не влияет на него.

## Проверки

```bash
pnpm --filter @kanbaner/mcp test
pnpm vitest run tests/integration/mcp-universal.test.ts
pnpm check:imports
```

Unit-тесты покрывают discovery, имена, JSON Schema, redaction, retry-политику и
HTTP-клиент. MCP server проверяется низкоуровневым `Client` через
`InMemoryTransport`; integration-тест поднимает реальную composition задач,
заметок и поиска и HTTP transport без подмены доменной логики. Реальный stdio
smoke процесса `kanbaner-mcp-universal` против локального HTTP server пока не
выполнен и остаётся оркестратору.

## Вне границ

Пакет не читает базу, не импортирует ядро, Storage Provider, доменные плагины
или `apps/web`, не включает сторонние MCP servers, Code Mode и wildcard allow.
Он также не является песочницей: агент с доступом к HTTP API действует в
пределах прав локального пользователя Kanbaner.
