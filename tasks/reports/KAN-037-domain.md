# KAN-037 — домен и операции notes

## Что сделано

- Реализован независимый `kanbaner.notes` на `PluginDocumentStore`: дерево
  страниц, partial update с версиями, move/reorder, каскадное удаление,
  favorites/recent, attachments и самодостаточный Markdown export.
- Добавлены activation, commands/queries, TypeBox/JSON Schema, события после
  коммита, ResourceRef adapter и `kanbaner.notes.references` для любых ресурсов.
- Store-мутации используют транзакции и атомарный Idempotency-Key. Поисковые
  документы обновляются после коммита; activation выполняет полную переиндексацию.
- Вложения PNG/JPEG/GIF/WebP проверяются по размеру, base64 и сигнатуре. В
  canonical Markdown допускаются собственные `attachment://` и HTTP(S) images;
  export подставляет data URL только в AST image-узлы.
- UI metadata содержит `/view/notes`, navigation, resource-opener и вклад
  `kanbaner.projects.task.related` без импорта `tasks`.
- Исправлен дублирующийся AJV `$id` в source/target ResourceDescriptorSchema:
  каждая копия получает уникальный `createJsonObjectSchema()`.
- Пустая активация notes больше не вызывает `search.reindex([])`: это устранило
  блокировку существующих activation-тестов задач.
- Отладочные файлы и логирование содержимого удалены.

## Проверки

- `tests/integration/notes-domain.test.ts` и `notes-activation.test.ts`:
  **18/18** — зелёные. Покрыты дерево, версии, move/cycle/depth, delete,
  attachments/export, activation, links, search и idempotency.
- `pnpm --filter @kanbaner/plugin-notes typecheck`, общий `pnpm typecheck`,
  `pnpm lint`, `pnpm check:imports`, `pnpm build:packages` — зелёные.
- Повторные полные `pnpm check` в параллельной нагрузке дважды упирались только
  в старые 5-секундные таймауты `task-list-disabled` и `tasks-activation`;
  изолированные suites проходили. Финальная проверка ветки выполняется
  оркестратором перед merge.
- UI/E2E и production shell не входили в объём worker-а.

## Изменённые файлы

- `packages/plugin-notes/src/activation.ts`, `activation/**`, `store.ts`,
  `schemas.ts`, `operations.ts`, `markdown-attachments.ts`, `metadata.ts`.
- `tests/integration/notes-domain.test.ts`, `notes-activation.test.ts`.
- `tasks/reports/KAN-037-domain.md`.

## Ограничения

- Integration harness использует in-memory provider; SQLite production shell
  проверяется отдельно оркестратором.
- Полный E2E относится к следующему интеграционному этапу.
