# @kanbaner/opencode

Необязательная интеграция с внешним OpenCode Service: глобальная панель чата,
catalog активных chat-моделей, streaming, полный built-in toolset агента и
ограниченный MCP для Kanbaner. Пакет не содержит моделей, provider credentials
или доменной логики и не подключается к SQLite.

## Панель и Service

- `app.assistant` добавляет правую desktop-панель и mobile fullscreen.
- Панель закрыта по умолчанию; Service подключается только после явного
  открытия. Состояние хранится в `localStorage["kanbaner.opencode.panelOpen"]`,
  последняя session ID — в `localStorage["kanbaner.opencode.sessionId"]`, а
  черновики composer — в `localStorage["kanbaner.opencode.drafts.v1"]`.
- `Service.ensure({ version })` принимает только strict SemVer major 2.x
  (`2.minor.patch` с optional prerelease/build, например `2.2.5` или
  `2.3.1-beta.1`), но не `2.`, `2.foo`, `1.x` или `3.x`. Используется
  `@opencode/client`, закреплённый на 2.2.5, не embedded SDK.
- Catalog использует один project location и возвращает whitelist: ID, имена,
  activation, model type и variants. `settings`, `headers`, `body`, credentials
  и Service authentication остаются на сервере.
- Создаются только сессии агента `kanbaner` с `metadata.source=kanbaner`.
  Тот же ownership проверяется для history, списка, переименования, model switch
  и prompt. Список дополнительно требует root-сессию (`parentID: null`), тот же
  нормализованный project directory и отсутствие `time.archived`.
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
- Tool calls объединяются по `assistantMessageID + tool call ID`. History
  загружается через paginated `message.list` и сохраняет running/error states.
  v2 identity использует `id`/`name`; для v1 `ToolPart` tool call ID берётся из
  `callID` (приоритетнее PartID `id`), имя — из `tool`; text parts по-прежнему
  используют PartID. v1 строковый `state.error`, `state.output`/`state.time`
  нормализуются без изменения v2 identity.
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
- Stream event без `event.id` не использует `Date.now()`: per-turn монотонный
  anonymous ID исключает collision. События без ID до terminal коррелируются в
  один вызов, terminal закрывает его. Без ID нельзя отличить параллельные
  вызовы, поэтому такой поток трактуется последовательно; идентифицированный
  SDK path `event.id` не меняется и никогда не смешивается с anonymous ID.

Внутренние маршруты `/api/opencode/*` предназначены только для browser panel.
Они требуют `x-kanbaner-client: ui` и same-origin Fetch Metadata/Origin
проверки. Это отдельный UI transport, а не публичный command/query API:
Bearer token в браузер не передаётся. Ответы имеют `Cache-Control: no-store`,
а публичные ошибки не содержат сырые upstream messages.

## История и переименование сессий

- В шапке панели показывается заголовок текущей сессии и доступная кнопка
  «Переименовать сессию». История — нативный `<details>` под шапкой: она
  загружается лениво только при раскрытии и кэшируется на 30 секунд. Кэш
  сбрасывается после создания сессии, завершённого prompt, переименования и
  ручного terminal outcome (`done`/`error`/`cancelled`) из «Проверить статус»,
  в том числе после EOF-unconfirmed; если история раскрыта, она перезагружается
  сразу.
- `GET /api/opencode/session` не принимает query-параметры. Gateway читает не
  больше 4 страниц по `limit: 50`, останавливается по `next`/повторному cursor,
  дедуплицирует ID, сортирует по `time.updated` desc с устойчивым tie-break по
  ID и отдаёт максимум 30 записей. Наружу передаётся только whitelist
  `{ id, title, updatedAt }`: `metadata`, `location`, `projectID`, стоимость,
  токены, permissions, model, agent, outcome, `archived` и `subpath` не
  попадают в JSON. Невалидные записи и чужие/архивные/child-сессии
  отбрасываются.
- `PATCH /api/opencode/session/{sessionID}` принимает строгий JSON-объект
  ровно с одним строковым полем `title` (до 4 KiB). Gateway нормализует
  пробелы, запрещает NUL/C0/C1 и принимает 1–100 code points. В upstream
  уходит только `{ sessionID, title }`; `metadata` не заменяется. Ответ —
  `{ id, title }` после проверки ownership.
- Выбор записи выполняет guarded `GET` точной сессии. `404` удаляет только
  недоступную запись из списка и не меняет текущую сессию или сохранённый ID;
  `503` показывает «Не удалось открыть сессию» и кнопку повтора. Неуспешный
  switch не меняет generation текущей сессии: видимый ход, unconfirmed и
  ручная проверка статуса сохраняются, а начатый canonical refresh не
  отменяется. Generation меняется только после успешного GET и проверки, что
  switch всё ещё последний. Во время prompt/rename/model switch записи истории
  заблокированы. Ошибки не раскрывают upstream-текст.
- Model switch — отдельная операция со своим request token: ни успех, ни ошибка
  не меняют generation, поэтому unconfirmed turn, «Проверить статус» и начатый
  canonical refresh сохраняются. Ответ применяется только к той же
  generation/sessionID и пока token последний; failed switch оставляет прежнюю
  модель. Подтверждённая model действует только на canonical GET, уже летевшие
  на момент switch: такой delayed refresh применяет canonical messages, но
  сохраняет новую модель, после чего overlay гасится. GET, начатый после
  switch, доверяет canonical model (в том числе более новой из другой вкладки),
  а switch/newChat/prompt generation очищают overlay. `newChat` применяет ответ
  и меняет generation только после успешного `POST /api/opencode/session` и
  проверки актуальности token; ошибка не скрывает unconfirmed, не сбрасывает
  черновик, вложения, rename и canonical refresh, а успех очищает вложения и
  attached context. Stale create response не применяется.
- Переименование применяется к захваченным generation и sessionID, не меняя
  generation и не отменяя canonical refresh. Подтверждённый title действует
  только на GET, уже летевшие на момент rename: такой delayed refresh
  применяет canonical messages и новый title, после чего overlay гасится.
  GET, начатый после rename, доверяет canonical, поэтому более новый title из
  другой вкладки больше не перекрывается старым; switch/newChat очищают
  overlay. `404` переводит панель в empty state через новую generation, чтобы
  старый refresh не воскресил удалённую сессию, и переводит фокус на «Новая
  сессия». При удалении записи в истории фокус переходит на
  следующую/предыдущую запись, иначе на summary.
- Если сохранённая сессия исчезла после reload (`404`), очищается только
  `localStorage` ID и показывается пустое состояние с кнопкой «Новая сессия»
  без автоматического `POST`. Временный `503` сохраняет ID и текущую сессию.
  Черновики других сессий при этом не изменяются.
- `Enter` в поле переименования сохраняет, `Escape` закрывает форму и
  возвращает фокус кнопке; `Escape` в раскрытой истории закрывает её и
  возвращает фокус на summary. Обработчик не всплывает до закрытия всей панели.
  Клиент нормализует заголовок по тем же правилам, что gateway (trim,
  схлопывание пробелов, 1–100 code points), поэтому 100 emoji допустимы, а
  `maxLength` в UTF-16 units не используется как основная проверка.

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

## Копирование кода и черновики composer

Assistant/system Markdown использует тот же `MarkdownContent`, что и остальные
плагины, с additive `codeBlockAction={CodeBlockCopyAction}`.

- Action — native `<button type="button">` только у fenced/indented code block.
  Inline code и пустой fence action не получают. Кнопка подписана
  `Копировать код`, после успеха — `Код скопирован`, после ошибки —
  `Не удалось скопировать код`; `aria-label` и `title` совпадают, есть
  `focus-visible`, мобильная цель не меньше 36 px. Состояние сбрасывается через
  2 секунды; таймер очищается при unmount и StrictMode-remount. Второй
  live-region не добавляется, layout, панель и scroll position не меняются.
- Копируется точный plain text блока без renderer-added trailing newline.
  Сначала вызывается `navigator.clipboard.writeText`; при отсутствии API, отказе
  или rejected Promise — legacy `document.execCommand("copy")` через временную
  readonly offscreen textarea. `activeElement` и Selection ranges
  восстанавливаются в `finally`, пустая строка не копируется, ошибка не покидает
  функцию rejected Promise-ом.

Composer хранит черновик отдельно для каждой OpenCode-сессии:

- Один ключ `localStorage["kanbaner.opencode.drafts.v1"]` формата
  `{ "v": 1, "drafts": { "<sessionID>": { "text": string, "updatedAt": number } } }`.
- Не больше 16 384 символов на запись, 20 записей и 65 536 символов суммарно.
  При превышении удаляются самые старые по `updatedAt` записи (при равенстве —
  лексикографически меньший session ID), текущая запись защищена. Сверхлимитный
  ввод остаётся в памяти composer, но не сохраняется; `maxLength` в textarea не
  добавляется.
- Пустой текст удаляет запись, последняя запись удаляет ключ. Невалидный JSON,
  другая версия, неверная форма, `NaN`/отрицательное время и oversize entry
  игнорируются по отдельности.
- Все чтения/записи/удаления обёрнуты в try/catch; заблокированный или
  переполненный `localStorage` не блокирует initialize панели и composer. Ошибки
  storage не маскируются под сбой OpenCode Service. Последняя session ID
  (`kanbaner.opencode.sessionId`) использует те же safe wrappers.
- После reload и переключения сессий восстанавливается черновик именно этой
  сессии. Новая сессия получает пустой или собственный черновик и не переносит
  чужой текст. `send()` очищает черновик только своей сессии и только после
  optimistic append; retry не очищает composer, если пользователь его изменил, а
  unconfirmed/error до optimistic append черновик сохраняет.
- В storage попадает только текст composer: вложения, base64, preview URL,
  сообщения, история, turn/model, attached refs и ошибки не сохраняются.

## Прокрутка чата

Лента использует реальный scroll container и внутренний content wrapper; логика
вынесена в `packages/opencode/src/chat-scroll.ts` и не использует виртуализацию,
IntersectionObserver или `scrollIntoView`.

- Follow включается только у нижней границы: расстояние
  `scrollHeight - scrollTop - clientHeight` не больше 48 px. Порог проверяется по
  фактическому контейнеру, а не по последнему сообщению.
- При чтении выше `scrollTop` не меняется от streaming deltas, upsert tool call,
  canonical refresh той же сессии и tool status. Unread считается по identity:
  новые ID и сообщения с изменённым текстом; чистое удаление истории счётчик не
  увеличивает. Собственный `role:"user"` (optimistic prompt и canonical
  `user:<turnID>`) badge не увеличивает: identity одного сообщения меняется при
  canonical refresh, а assistant/tool/system по-прежнему считаются. Если после
  изменения сообщений или resize геометрия сама привела к нижней границе, follow
  и badge восстанавливаются без scroll event.
- Перед любой автоматической записью `scrollTop` текущий offset сверяется с
  сохранённой предыдущей нижней границей. Если пользователь уже ушёл выше, но
  scroll event ещё не доставлен, запись пропускается: follow выключается, кнопка
  и unread появляются сразу. Явные `followNow`, возврат кнопкой и отправка
  prompt остаются override.
- Кнопка находится вне scroll content и является native `<button>`: работает
  pointer/touch, Enter/Space и `focus-visible`. После возврата фокус переносится
  на контейнер с `preventScroll`, чтобы исчезновение кнопки не прокручивало ленту.
- Отправка prompt и retry явно включают follow. Смена `session.id` сбрасывает
  unread и открывает конец новой истории; canonical refresh той же сессии follow
  не сбрасывает.
- Native scroll anchoring не отключается. Контракт — стабильность видимого
  фрагмента при reflow выше viewport, а не неизменный числовой `scrollTop`:
  браузер сам компенсирует рост раннего сообщения, hook не делает собственный
  jump. Для deltas без reflow выше viewport `scrollTop` остаётся прежним.
- `ResizeObserver` наблюдает container и content, window resize и capture
  `load`/`error` (image preview) удерживают низ только в режиме follow. Без
  `ResizeObserver` дополнительно работают capture `toggle` для tool `<details>`
  и window `pointerup`/`keyup` после resize мышью или клавиатурой; polling и
  новые зависимости не используются.
- `overscroll-contain` не отдаёт прокрутку чата внешней странице. Позиция между
  перезагрузками не сохраняется; generation/abort в scroll-логику не входят.

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
  timings/input/output, v1 `callID`/`tool` identity, aborted→cancelled, inline
  files, bounded list/whitelist/cursor/dedupe/sort/cap, ownership и rename
  validation/exact update.
- `packages/opencode/src/gateway-service-version.test.ts` — Service version
  predicate: accept 2.x (2.2/2.3), reject 1.x/3.x и malformed.
- `packages/opencode/src/tool-metadata.test.ts` — ordered deny/allow против
  `opencode.jsonc`, отсутствие wildcard/`execute`/сторонних MCP, соответствие
  catalog 11 built-ins + 14 MCP tools.
- `apps/web/src/server/opencode-http.test.ts` — guard, validation вложений
  (Base64/UTF-8/сигнатуры/лимиты), публичные ошибки, finalizing passthrough,
  единственный terminal, pre-admission nonAdmission/retryable, invalid turnID,
  `?turnID` status, NDJSON EOF, cancel, guards/query rejection для списка и
  strict JSON/ошибки `PATCH` переименования.
- `packages/opencode/src/ui.test.tsx` — StrictMode, streaming, model/session
  races, attachments, turn-статусы, rejected stream без retry, stable ID
  второго prompt, delta→error без потери текста, cancelled/empty/tool-only,
  все четыре фазы, retry/status check, две группы tool catalog с
  предупреждением, stop, compact tool disclosure, детерминированная duration,
  merge/finish helpers, keyboard, stale generation, unconfirmed/error/cancelled
  tools, turn-scoped finish без чужого unconfirmed tool, nonAdmission без
  завершения и ручной status check в том же scope, drafts restore/send/retry,
  отсутствие base64 и истории в storage, заблокированный localStorage, copy
  action и его failure, lazy history/switch/draft, reload-404 empty state без
  POST, 404/503 switch, busy, rename/Enter/Escape, stale-кэш после newChat,
  сохранение unconfirmed при model switch и failed newChat с файлом/контекстом,
  delayed canonical refresh со старой model и свежий canonical model после
  model switch, очистку вложений успешным create, stale create и инвалидацию
  истории ручным terminal outcome.
- `packages/opencode/src/session-history.test.tsx` — lazy load, 30-секундный
  кэш и version invalidation, empty/error/retry, not-found removal, switch
  unavailable/retry, busy, Escape-фокус и pending «Открываем…».
- `packages/opencode/src/drafts.test.tsx` — valid/corrupt JSON, версия, формы
  записей, LRU по `updatedAt` и размеру, oversize, storage throw/blocked,
  необычные session ID, StrictMode и изоляция сессий.
- `packages/opencode/src/clipboard.test.ts` — Clipboard API, legacy fallback,
  denial/false/throw, пустая строка, восстановление фокуса и Selection.
- `packages/opencode/src/code-block.test.tsx` — success/failure labels,
  keyboard, reset timer, StrictMode и unmount cleanup.
- `packages/opencode/src/chat-scroll.test.tsx` — геометрия near-bottom,
  threshold 48 px, follow/чтение выше, unread (включая user-turn и стабильный
  tool в canonical), возврат, canonical refresh,
  сброс при смене сессии, `ResizeObserver`/window resize/`load`/`error`,
  StrictMode cleanup, passive listener и native keyboard/focus.
- `packages/opencode/src/mcp-server.test.ts` — tool allowlist из 14, risk,
  expectedVersion, Bearer и idempotency.
- `apps/web/e2e/opencode.spec.ts` — desktop/mobile панель, вложения prompt,
  группы built-in/MCP tools, success с `finalizing`, unconfirmed без
  авто-GET, ручные done/error/pending без нового prompt, compact tool call с
  duration, keyboard disclosure, длинным output без overflow и canonical
  timings после reload, streaming с mock OpenCode transport в production
  Chromium. Scroll-сценарии проверяют чтение выше во время streaming и
  canonical, tool disclosure, отложенную загрузку картинки, resize viewport,
  Enter/Space-возврат, повторный follow, смену сессии на desktop и mobile 360 и
  ровно один unread при canonical user-message.
  Copy/drafts-сценарии проверяют точный clipboard desktop/mobile, Enter/Space,
  понятную ошибку при отказе clipboard, изоляцию и reload черновиков, пустую
  новую сессию, очистку только своей сессии, повреждённый storage и отсутствие
  base64/истории в `localStorage`. History-сценарии проверяют lazy desktop
  list/switch/per-session draft, mobile reload-404 CTA без POST, rename
  PATCH/Enter/Escape, blocked items во время prompt и 404/503 switch.
