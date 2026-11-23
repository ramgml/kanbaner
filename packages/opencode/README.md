# @kanbaner/opencode

Необязательная интеграция с внешним OpenCode Service: глобальная панель чата,
catalog активных chat-моделей, streaming, полный built-in toolset агента и
ограниченный MCP для Kanbaner. Пакет не содержит моделей, provider credentials
или доменной логики и не подключается к SQLite.

## Панель и Service

- `app.assistant` добавляет правую desktop-панель и mobile fullscreen.
- Панель закрыта по умолчанию; Service подключается только после явного
  открытия. Состояние хранится в `localStorage["kanbaner.opencode.panelOpen"]`,
  последняя session ID — в `localStorage["kanbaner.opencode.sessionId"]`.
- `Service.ensure({ version })` принимает только strict SemVer major 2.x
  (`2.minor.patch` с optional prerelease/build, например `2.2.5` или
  `2.3.1-beta.1`), но не `2.`, `2.foo`, `1.x` или `3.x`. Используется
  `@opencode/client`, закреплённый на 2.2.5, не embedded SDK.
- Catalog использует один project location и возвращает whitelist: ID, имена,
  activation, model type и variants. `settings`, `headers`, `body`, credentials
  и Service authentication остаются на сервере.
- Создаются только сессии агента `kanbaner` с `metadata.source=kanbaner`.
  Тот же ownership проверяется для history, model switch и prompt.
- Prompt ждёт `server.connected`, затем вызывает `session.prompt` с заранее
  созданным inbox ID. До `session.inbox.delivered` с этим ID события предыдущего
  выполнения игнорируются. Terminal execution не принимается по типу события:
  outcome проверяется по canonical history текущего prompt (exact
  `type=user && id===inboxID`, последний assistant до следующего user), поэтому
  stale failed/interrupted старого execution не перекрывает canonical success.
  Если canonical outcome не подтверждён за ограниченное число коротких проверок,
  NDJSON завершается безопасной ошибкой без upstream-текста.
- Чужой `session.inbox.cancelled` игнорируется даже после delivered; собственная
  отмена завершает поток. После admission `session.inbox.cancel` и
  `session.interrupt` вызываются только при abort сигнала; сбой SSE/iterator не
  прерывает execution, а сначала пытается canonical resolve.
- Перед canonical lookup gateway выпускает служебный `finalizing`, который
  NDJSON transport передаёт клиенту без terminal-семантики. UI показывает
  стадии `connecting/running/finalizing/done/cancelled/error`; terminal-статус
  не исчезает после завершения запроса.
- Если canonical outcome не подтверждён, UI показывает «Результат не подтверждён»
  и кнопку «Проверить статус». Проверка использует существующий
  `GET /api/opencode/session/{sessionID}`, не создаёт prompt и не теряет уже
  streamed-сообщения. Автоматический refresh или retry в этом состоянии
  запрещён; повтор доступен только для точно не принятого 408/429/5xx запроса
  и отправляет тот же текст и файлы.
- System error в history показывается только для последнего assistant последнего
  user-turn, поэтому ошибка прошлого turn не воскресает после нового ответа.
- Tool calls объединяются по `assistantMessageID + tool call ID`; history
  загружается через paginated `message.list` и сохраняет running/error states.

Внутренние маршруты `/api/opencode/*` предназначены только для browser panel.
Они требуют `x-kanbaner-client: ui` и same-origin Fetch Metadata/Origin
проверки. Это отдельный UI transport, а не публичный command/query API:
Bearer token в браузер не передаётся. Ответы имеют `Cache-Control: no-store`,
а публичные ошибки не содержат сырые upstream messages.

## Вложения prompt

- File picker принимает UTF-8 text/code (до 1 MiB), PNG/JPEG/GIF/WebP и PDF
  (до 5 MiB каждый). Ограничения: не больше 5 файлов и 8 MiB суммарно.
- Клиент читает файл через browser `FileReader`, санитизирует имя до basename
  и отправляет `files: [{ name, mime, base64 }]` в prompt. Отдельного upload
  endpoint и хранения файлов на сервере нет.
- Сервер проверяет канонический Base64, размер, UTF-8 через fatal
  `TextDecoder`, сигнатуры PNG/JPEG/GIF/WebP и `%PDF-`, затем передаёт
  выбранной модели только inline `data:<mime>;base64,...` со
  `source: { type: "inline" }`. `file:` URL и чтение server paths запрещены.
- Если выбранная модель не объявляет поддержку image/PDF-входа, панель
  показывает предупреждение и всё равно отправляет prompt: OpenCode/provider
  может заменить вложение служебной заметкой или отклонить его. Блокировки
  отправки в UI нет. Browser history получает только `name` и `mime`, без base64
  и содержимого.
- Изображения имеют previews в composer и сообщениях. Для canonical history
  отдельный guarded GET возвращает binary image по exact session/message/index;
  gateway читает только canonical inline `file.data`/`file.mime` с
  `source.type === "inline"` и повторно проверяет Base64, размер и сигнатуру.
  Browser превращает ответ в blob URL; при недоступности preview остаётся chip.
- Публичные ошибки валидации не раскрывают base64 и file contents. Новых
  runtime-зависимостей нет: используются browser `FileReader`, `Buffer` и
  `TextDecoder`.

## MCP и built-in tools

`opencode.jsonc` в корне репозитория регистрирует локальный stdio server с
`codemode: false`, поэтому агент получает непосредственно только разрешённые
`kanbaner_*` tools. Сторонние MCP servers, Code Mode `execute` и wildcard allow
для чужих tools не включены.

Permissions агента `kanbaner` построены как ordered allowlist: сначала
`deny *`, затем явные allow. По явному решению пользователя от 2026-11-20
разрешены стандартные built-in tools OpenCode:

- `question`, `websearch`, `webfetch`;
- `read`, `glob`, `grep`;
- `edit` (в OpenCode также покрывает `write` и `patch`);
- `shell`, `subagent`, `skill`, `external_directory`.

Это полный доступ, а не песочница. Shell выполняется с правами пользователя,
`read`/`edit` могут читать и изменять локальные файлы, включая секреты и
`.env`, а `websearch`/`webfetch`/`shell` имеют доступ к сети. Не запускайте
этого агента на машине или в каталоге, где такие права нежелательны.

Набор инструментов MCP остаётся ограниченным:

- `project_list`, `project_get`, `project_create`, `project_update`;
- `task_list`, `task_get`, `task_create`, `task_update`, `task_complete`, `task_move`;
- `note_list`, `note_get`, `note_create`, `note_update`.

Этот же список из 14 MCP tools приходит в `/api/opencode/catalog` с
`operationId`, `risk` (`read`/`write`), `source: "mcp"` и
`requiresExpectedVersion`; built-in tools приходят с `source: "builtin"` без
доменного `operationId`. Панель показывает две группы и предупреждение
«Полный доступ: интернет, файлы и shell». Delete MCP tools не регистрируются.
Каждый MCP-вызов идёт через `/api/v1` с Bearer token. Updates требуют
`expectedVersion`; mutations получают `Idempotency-Key` из операции,
канонического input, идентичности MCP request/session и UUID экземпляра
server. Поэтому повтор того же request внутри одного процесса дедуплицируется,
а новое намеренное создание после перезапуска или с другим request ID не
склеивается со старым.

## Настройка

1. Выполните `pnpm build:packages`.
2. Задайте одинаковый локальный токен в `apps/web/.env.local` и
   `apps/web/.env.api-token` как `KANBANER_API_TOKEN=<local-secret>`.
   Оба файла игнорируются Git. File substitution в `opencode.jsonc` читает
   второй файл; адаптер принимает значение как в raw, так и в `KEY=value` форме.
3. Запустите Kanbaner на `http://127.0.0.1:3000` или задайте другой
   `KANBANER_API_URL` в environment MCP.
4. Проверьте `opencode mcp list`: `kanbaner` должен быть `connected`.
5. Откройте панель, выберите модель и отправьте запрос.

Секреты не добавляйте в `opencode.jsonc`. При нестандартном каталоге запуска
корень project location можно задать через `KANBANER_PROJECT_DIR`.

## Проверки

- `packages/opencode/src/gateway.test.ts` — catalog whitelist/tools, ownership,
  pagination, stream readiness/finalizing/terminal/abort, canonical outcome,
  transient lookup retry, tool event mapping и inline files.
- `packages/opencode/src/gateway-service-version.test.ts` — Service version
  predicate: accept 2.x (2.2/2.3), reject 1.x/3.x и malformed.
- `packages/opencode/src/tool-metadata.test.ts` — ordered deny/allow против
  `opencode.jsonc`, отсутствие wildcard/`execute`/сторонних MCP, соответствие
  catalog 11 built-ins + 14 MCP tools.
- `apps/web/src/server/opencode-http.test.ts` — guard, validation вложений
  (Base64/UTF-8/сигнатуры/лимиты), публичные ошибки, finalizing passthrough,
  единственный terminal, NDJSON EOF и cancel.
- `packages/opencode/src/ui.test.tsx` — StrictMode, streaming, model/session
  races, attachments, turn-статусы, retry/status check, две группы tool catalog
  с предупреждением и stop.
- `packages/opencode/src/mcp-server.test.ts` — tool allowlist из 14, risk,
  expectedVersion, Bearer и idempotency.
- `apps/web/e2e/opencode.spec.ts` — desktop/mobile панель, вложения prompt,
  группы built-in/MCP tools, success/unconfirmed статусы, ручная проверка без
  нового prompt и streaming с mock OpenCode transport в production Chromium.
