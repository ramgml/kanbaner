---
id: KAN-069
title: Универсальный discovery-driven MCP
status: in_progress
stage: 7
priority: high
owner: worker-kan-069
blocked_by: []
branch: feat/kan-069-universal-mcp
worktree: .worktrees/kan-069-universal-mcp
created: 2026-11-25
updated: 2026-11-25
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/roadmap.md
  - specs/technology-stack.md
---

# KAN-069 — Универсальный discovery-driven MCP

## Цель

Добавить отдельный stdio MCP-адаптер, который обнаруживает HTTP-операции с
`exposure.mcp=true` и вызывает их через Bearer HTTP без базы данных и доменной
логики.

## Результат

- `tools/list` строится из актуального discovery и автоматически видит новые
  разрешённые операции без изменения кода адаптера.
- `tools/call` передаёт JSON Schema input в существующий command/query transport,
  сохраняя validation, `expectedVersion`, idempotency и стабильные ошибки.
- MCP-клиент получает список задач и создаёт задачу и заметку; search query из
  KAN-068 обнаруживается автоматически после интеграции.
- Delete/destructive/bulk не появляются неявно; ручной OpenCode allowlist из 14
  инструментов остаётся неизменным.

## Архитектурные решения

- Новый private пакет `@kanbaner/mcp`, executable `kanbaner-mcp-universal` и
  server name `kanbaner-universal`, чтобы не конфликтовать с ручным
  `kanbaner-mcp` из `@kanbaner/opencode`.
- Использовать low-level MCP `Server` и JSON Schema напрямую; произвольные
  discovery-схемы не преобразовывать в Zod.
- Публикуются только операции с `exposure.http=true` и `exposure.mcp=true`.
  Discovery обязан содержать additive `exposure`; старый discovery без него —
  понятная compatibility error, а не молчаливый пустой каталог.
- Tool names стабильно получаются из operation ID, lowercase, invalid chars →
  `_`, максимум 128; коллизии не экспортируются. Каталог сортируется.
- `expectedVersion` никогда не подставляется. Idempotency-Key создаётся только
  для supported mutations и учитывает operation/input/request/session/process.
- `source.type=mcp` передаётся через точный `x-kanbaner-client: mcp`; это audit
  metadata, а не дополнительная авторизация. HTTP Bearer остаётся обязательным.
- Destructive descriptors не экспортируются без явного
  `KANBANER_MCP_ALLOW_DESTRUCTIVE=true` и всегда имеют явные annotations/prefix.
- Notes сохраняют уже явно заданный `exposure.mcp`; универсальный адаптер
  уважает его. Tasks получают отдельный явный allowlist ID, без автоматического
  включения всех неразрушительных операций.

## Этапы и владение

### Этап A — автономный пакет, параллельно KAN-068

Разрешено только:

- `packages/mcp/**`;
- `tasks/reports/KAN-069.md`.

Реализовать config, discovery client, low-level server, naming/catalog, HTTP
client, validation, redaction, stdio CLI и unit/fixture tests. Не менять root
package/lock/build/docs или apps. Проверки выполняются на установленном workspace;
frozen-lock обновление откладывается до этапа B и не скрывается в отчёте.

### Этап B — integration после merge KAN-068

Тот же worker и worktree после rebase оркестратором получают дополнительно:

- root `package.json`, `pnpm-lock.yaml`, `scripts/check-import-boundaries.mjs`;
- `apps/web/src/server/http-api*`, `application-composition*`,
  `plugin-service*` для exposure/source;
- `packages/plugin-tasks/**` и integration/contract tests для явного MCP set;
- общие README/specs и реальные MCP integration tests.

Явный tasks MCP set: project.list/get, column.list, task.list/get;
project.create/update, task.create/update/complete/move. Delete, deleteMany,
moveMany и остальные не перечисленные operations остаются `mcp:false`.

Запрещено на обоих этапах:

- `packages/opencode/**`, `opencode.jsonc`, ручной allowlist и его 14 tools;
- доступ к kernel/storage-sqlite/better-sqlite3/node:sqlite из `packages/mcp`;
- импорт доменных плагинов или `apps/**` в `packages/mcp`;
- wildcard allow, Code Mode, сторонние MCP servers и секреты в stdout/logs;
- новые внешние зависимости сверх существующих SDK/plugin-sdk;
- файлы задач, release-ветки и чужие worktree.

## Контракты и границы

- URL только HTTP(S), без credentials/query/hash; `redirect:error`, bounded
  timeout и caller abort. Token никогда не печатается.
- Локальная input validation до HTTP; output validation и structuredContent
  только для object output schema. Массивы/примитивы остаются text content.
- Server errors сохраняют стабильные code/message/retryable; raw body/upstream
  headers не возвращаются. Не логировать input/output/Markdown.
- Query никогда не получает Idempotency-Key; mutation `none` — тоже.
- Отключённый/unconfigured API даёт структурированную DEPENDENCY_UNAVAILABLE и
  не влияет на приложение.
- Discovery перечитывается для актуального list; тесты проверяют подмножества и
  свойства, а не общее число tools, чтобы KAN-068 не ломал snapshots.

## Критерии приёмки

- [ ] Новый synthetic descriptor с mcp/http появляется в tools/list без правок
  пакета; mcp:false, http:false и collisions отсутствуют.
- [ ] MCP list tasks, create task и create note работают через HTTP composition;
  delete/bulk отсутствуют, search query KAN-068 доступен.
- [ ] Invalid input не вызывает HTTP; expectedVersion/version conflict и
  idempotency сохраняют контракт.
- [ ] 401/503/timeout/abort/invalid JSON/redaction/disabled API покрыты.
- [ ] `source.type=mcp` проверен, ручной OpenCode MCP остаётся 14 прежних tools.
- [ ] Import boundaries, frozen strict install, полный `pnpm check` и полный
  Playwright зелёные после integration.

## Проверки

- Unit config/tools/catalog/http/errors/server и InMemoryTransport MCP Client.
- Integration с HTTP composition, task/note/create/list и search discovery.
- `pnpm --filter @kanbaner/mcp build`, shebang/CLI smoke и disabled API.
- `pnpm --filter @kanbaner/opencode test` или focused ручного MCP.
- `pnpm check:imports`, `pnpm check:composition`, `pnpm test:sqlite`.
- `pnpm --filter @kanbaner/web test:e2e`, `pnpm check`.
- Windows-проверки не выполняются по явному решению пользователя для текущего
  релиза; это фиксируется в release notes.

## Риски

- Не использовать high-level registerTool с несовместимыми JSON Schema.
- Нельзя допустить Bearer redirect, stdout JSON-RPC pollution или сырые ошибки.
- Idempotency привязана к идентичности MCP-вызова, а не только к аргументам.
- Notes exposure шире ручного OpenCode allowlist намеренно и должен быть виден в
  release notes.
- На этапе A lockfile ещё не содержит importer; до этапа B ветку не мержить.

## Журнал

- 2026-11-25 — Задача создана для закрытия MVP перед stable `0.1.0`; назначен
  `worker-kan-069`, этап A `in_progress`.
- 2026-11-25 — Автономный пакет закоммичен `8f15e4b`: 65/65 unit, typecheck,
  build, eslint и stdio/CLI smoke зелёные. Integration, frozen lock и полные
  release-проверки остаются на этап B после merge KAN-068.
- 2026-11-25 — Ревью этапа A нашло high в retryable non-idempotent mutation,
  medium в redaction/abort/schema compatibility и три low. Исправления выполняются
  до этапа B.
- 2026-11-25 — Worker закрыл замечания коммитом `6626d60`; 75/75 unit,
  typecheck/build/eslint/stdio smoke зелёные. Повторное ревью этапа A не нашло
  blocker/high/medium/low.

## Итог

Заполняется оркестратором после интеграции.
