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
- Prompt ждёт `server.connected`, затем вызывает `session.prompt({ id })` с
  client-generated stable turn ID (`^msg_[A-Za-z0-9_-]{8,64}$`). ID не зависит
  от ordinal и переживает несколько prompt в одной сессии. Если Service вернул
  другой admitted ID, gateway выпускает служебное `kanbaner.turn.admitted` и
  запоминает alias client→admitted, не подменяя исходный ID. До
  `session.inbox.delivered` события предыдущего выполнения игнорируются.
  Terminal execution не принимается по типу события: outcome проверяется по
  canonical history точного turn (`type=user && id===turnID`, последний
  assistant до следующего user), поэтому stale failed/interrupted старого
  execution не перекрывает canonical success. Если canonical outcome не
  подтверждён за ограниченное число коротких проверок, NDJSON завершается
  безопасной ошибкой без upstream-текста.
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
  `GET /api/opencode/session/{sessionID}?turnID={turnID}` и возвращает
  `{ session, outcome }`, где `outcome` — `done`, `error`, `cancelled`,
  `pending` или `missing`, вычисленный по точному turn ID на сервере. UI не
  угадывает исход по собственному тексту или ordinal. Проверка не создаёт
  prompt и не теряет уже streamed-сообщения; canonical history заменяет их
  только при `done`. Автоматический refresh или retry в этом состоянии
  запрещён.
- После возможного admission NDJSON никогда не помечает ошибку retryable:
  rejected `fetch`, null body, EOF без `finalizing` и неизвестный сбой дают
  `reason: "unconfirmed"` и только ручную проверку. Это же правило действует
  для rejected `client.session.prompt()`: сам вызов мог дойти до Service,
  поэтому `promptAttempted` фиксируется до вызова, затем выполняется bounded
  canonical lookup по stable turn ID; terminal выдаётся только при exact
  canonical outcome, иначе unconfirmed, без retry/interrupt. Retryable и
  `nonAdmission: true` выставляются только для сбоя до вызова prompt
  (`OpenCodeGatewayError` до первого streamed-события, 408/429/5xx); повтор
  отправляет тот же текст и файлы. Terminal error после `finalizing` не
  дублируется.
- Status query принимает как client-generated `msg_...` ID (через alias-map),
  так и фактический admitted `SessionMessageID` Service. Для admitted ID
  используется отдельный bounded validator (длина и безопасный charset без
  требования `msg_`), поэтому прямой ID работает и после eviction alias-map
  или restart. В prompt body по-прежнему допускается только strict
  client-generated ID.
- System error в history показывается только для последнего assistant последнего
  user-turn, поэтому ошибка прошлого turn не воскресает после нового ответа.
- Tool calls объединяются по `assistantMessageID + tool call ID`; history
  загружается через paginated `message.list` и сохраняет running/error states.
  Поддерживаются v2 identity (`id`/`name`) и v1 `ToolPart` (`callID`/`tool`,
  строковый `state.error`, `state.output`/`state.time`) без изменения v2 ID.
- Tool call показывается компактным disclosure: status, имя, длительность и
  свёрнутые input/output. Детали раскрываются pointer/touch, Enter или Space;
  running duration тикает раз в секунду и фиксируется terminal/Stop/error.
  Таймер помечен `role="timer" aria-live="off"`, чтобы screen reader не
  объявлял каждую секунду; статусы остаются доступными. Невалидные,
  отсутствующие и обратные timestamps не дают фиктивную длительность. Для
  stream timings берутся из top-level `event.created` как приблизительные;
  canonical `time.ran`/`time.completed` приходят со следующим history reload.
  В публичный payload попадают только `input`, `output` и timings:
  `state.metadata`, `part.native` и upstream `error.message` не передаются.
  `cancelled` — UI-only terminal для Stop, подтверждённой отмены, canonical и
  streaming `error.type=aborted`; обычная ошибка инструмента остаётся `error`.
  Unconfirmed результат оставляет tool в running.
- Terminal `done`/`cancelled`/`error` завершает только tools текущего prompt:
  UI хранит набор identity, добавленных `appendTool` этого generation. Running
  tool предыдущего unconfirmed turn не меняется, а explicit `nonAdmission`
  вообще не запускает завершение. Ручная проверка статуса применяет тот же
  turn-scoped набор, поэтому canonical outcome не затрагивает чужой ход.

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
  stable turnID/admitted alias, transient lookup retry, tool event mapping,
  timings/input/output, v1 `callID`/`tool` identity, aborted→cancelled и inline
  files.
- `packages/opencode/src/gateway-service-version.test.ts` — Service version
  predicate: accept 2.x (2.2/2.3), reject 1.x/3.x и malformed.
- `packages/opencode/src/tool-metadata.test.ts` — ordered deny/allow против
  `opencode.jsonc`, отсутствие wildcard/`execute`/сторонних MCP, соответствие
  catalog 11 built-ins + 14 MCP tools.
- `apps/web/src/server/opencode-http.test.ts` — guard, validation вложений
  (Base64/UTF-8/сигнатуры/лимиты), публичные ошибки, finalizing passthrough,
  единственный terminal, pre-admission nonAdmission/retryable, invalid turnID,
  `?turnID` status, NDJSON EOF и cancel.
- `packages/opencode/src/ui.test.tsx` — StrictMode, streaming, model/session
  races, attachments, turn-статусы, rejected stream без retry, stable ID
  второго prompt, delta→error без потери текста, cancelled/empty/tool-only,
  все четыре фазы, retry/status check, две группы tool catalog с
  предупреждением, stop, compact tool disclosure, детерминированная duration,
  merge/finish helpers, keyboard, stale generation, unconfirmed/error/cancelled
  tools, turn-scoped finish без чужого unconfirmed tool, nonAdmission без
  завершения и ручной status check в том же scope.
- `packages/opencode/src/mcp-server.test.ts` — tool allowlist из 14, risk,
  expectedVersion, Bearer и idempotency.
- `apps/web/e2e/opencode.spec.ts` — desktop/mobile панель, вложения prompt,
  группы built-in/MCP tools, success с `finalizing`, unconfirmed без
  авто-GET, ручные done/error/pending без нового prompt, compact tool call с
  duration, keyboard disclosure, длинным output без overflow и canonical
  timings после reload, streaming с mock OpenCode transport в production
  Chromium.
