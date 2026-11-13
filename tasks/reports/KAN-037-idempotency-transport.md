# KAN-037 — Idempotency-Key в UI transport

## Что сделано

- Единая additive-сигнатура UI-вызова во всех слоях:
  `invoke(operationId, input, options?: { idempotencyKey?: string })`.
  Вызовы с двумя аргументами не изменились.
- `UiOperationInvokeOptions` добавлен в `@kanbaner/task-ui` и в контракт
  `apps/web/src/ui/operation-types.ts`; тип экспортируется из `index.ts`.
- `executePluginOperation` (server action) санитизирует клиентские опции:
  пустой, нестроковый или отсутствующий ключ считается отсутствующим.
- `PluginService.executeUiOperation`, `executeUiPluginOperation` и
  `composition.executeUiOperation` передают ключ в `executionOptions` той же
  команды.
- `source` остаётся `ui`/`web`. Query ключ не получает даже при явной передаче.
- Идемпотентность по-прежнему реализуется плагином; транспорт только
  пробрасывает ключ в `OperationBus`.

## Тесты

- `apps/web/src/ui/operation-types.test.ts` — санитизация опций: непустой
  ключ сохраняется, пустой/нестроковый/не-объект отбрасывается.
- `apps/web/src/server/plugin-service.test.ts` — сервис передаёт ключ
  исполнителю, отбрасывает пустой ключ и сохраняет прежний вызов без опций.
- `apps/web/src/server/application-composition.test.ts` — сквозной regression
  через `executeUiOperation` с реальным `kanbaner.notes`:
  - mutation с ключом доходит до `OperationBus`; повтор с тем же ключом
    возвращает тот же результат, не создаёт второе событие и вторую заметку;
  - query не получает ключ в `ExecutionContext`;
  - пустой и нестроковый ключ не приводят к `VALIDATION_ERROR`;
  - без ключа два вызова создают две заметки, как раньше.

## Проверки

- Targeted: `operation-types`, `plugin-service`, `application-composition`,
  `notes-activation`, `fixture-activation` — **56/56** тестов.
- `pnpm check` (format, lint, typecheck, unit/integration, production build) —
  зелёный: **116 файлов / 1592 теста**.
- `pnpm check:imports` — без нарушений.
- `git diff --check` — чисто.

## Ограничения и риски

- Playwright E2E не запускались: UI-плагин заметок пока не передаёт
  `idempotencyKey` в `invoke`, поэтому изменение транспорта проверено
  integration-тестами на уровне composition.
- Windows, Firefox и WebKit отдельно не запускались.
- Ключ пробрасывается как есть после проверки на непустую строку; значение не
  нормализуется и не обрезается.
