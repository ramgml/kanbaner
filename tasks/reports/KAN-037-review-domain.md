# KAN-037 — review domain fixes

## Что сделано

- Разбор Markdown теперь понимает reference-style изображения:
  `![alt][label]` и `![label]` разрешаются через `definition`-узлы.
  Validation, `extractAttachmentIds`, cleanup и export работают с URL из
  definitions; export заменяет URL в самом definition и сохраняет direct
  images. Код и code block не затрагиваются, потому что позиции берутся из AST.
- Добавлен read-only query `kanbaner.notes.note.subtree`. Он возвращает
  `noteId`, `noteCount` (включая корневую страницу) и `attachmentCount`.
- `NoteDeleteInputSchema` принимает необязательный `expectedDescendants`.
  Store проверяет фактический размер поддерева в той же транзакции до удаления
  и выбрасывает `NotesSubtreeConflictError` при расхождении. Ошибка
  маппится в `VERSION_CONFLICT` с `expectedDescendants`/`actualDescendants`.
  Legacy delete без count сохранён.
- `unlink` переведён на отдельную `NoteUnlinkInputSchema`
  `{ noteId, sourceRef, targetRef }`. Activation проверяет, что заметка —
  один из участников пары, и удаляет именно переданную связь
  `kanbaner.notes.references`. Входящие и исходящие связи удаляются с обеих
  сторон; чужую пару удалить нельзя.
- Остальные схемы, output shapes, события и idempotency не менялись.
  `expectedDescendants` добавлен как optional-поле, новые query и input
  schema — аддитивные изменения.

## Regression tests

- `packages/plugin-notes/src/markdown-attachments.test.ts` — reference и
  shortcut images, общий definition, код/code block, direct images.
- `tests/integration/notes-domain.test.ts`:
  - reference-style attachment → title-only update → `ATTACHMENT_IN_USE` →
    export с data URL в definition и direct image → cleanup → delete;
  - `getSubtree` + устаревший `expectedDescendants` не удаляет данные, свежий
    count удаляет ветку.
- `tests/integration/notes-activation.test.ts`:
  - preview `note.subtree`, добавление потомка после preview, конфликт
    `VERSION_CONFLICT`, повторный delete со свежим count;
  - удаление исходящей и входящей связи, идемпотентный повтор и запрет
    удаления чужой пары.

## Проверки

- Targeted: `markdown-attachments.test.ts`, `notes-domain.test.ts`,
  `notes-activation.test.ts` — **27/27** зелёные.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` — зелёные.
- `pnpm build` (включая production Next.js build) — зелёный.
- `pnpm test` в полном параллельном запуске (115 workers) дважды упал только
  на известных 5-секундных таймаутах `fixture-activation` и
  `tasks-activation`, не связанных с notes. Оба файла изолированно —
  **50/50** зелёные. Повтор всего suite с `--maxWorkers=8` —
  **115 файлов / 1590 тестов** зелёные.
- `pnpm check` не завершился целиком из-за этих двух таймаутов на шаге
  `pnpm test`; остальные шаги check (format, lint, typecheck) прошли, build
  выполнен отдельно.
- Повторная проверка в продолженной сессии (после остановки worker):
  `vitest run tests/integration/notes-activation.test.ts
tests/integration/notes-domain.test.ts
packages/plugin-notes/src/markdown-attachments.test.ts` — **27/27** зелёные;
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck` — зелёные.

## Изменённые файлы

- `packages/plugin-notes/src/markdown-attachments.ts`
- `packages/plugin-notes/src/schemas.ts`
- `packages/plugin-notes/src/store.ts`
- `packages/plugin-notes/src/model.ts`
- `packages/plugin-notes/src/operations.ts`
- `packages/plugin-notes/src/activation.ts`
- `packages/plugin-notes/src/activation/errors.ts`
- `packages/plugin-notes/src/constants.ts`
- `packages/plugin-notes/src/markdown-attachments.test.ts`
- `tests/integration/notes-domain.test.ts`
- `tests/integration/notes-activation.test.ts`
- `tasks/reports/KAN-037-review-domain.md`

## Остаточные риски и зависимости

- UI не менялся по границам задачи. `note-links.tsx` пока вызывает `unlink`
  со старым входом `{ noteId, targetRef }`; UI-ветка должна передать
  `sourceRef` и `targetRef`. Удаление связи в UI до этого будет отклоняться
  валидацией схемы.
- UI подтверждение удаления пока считает страницы по загруженной странице
  списка; ему нужно вызывать `note.subtree` и передавать `noteCount` как
  `expectedDescendants`.
- Integration harness использует in-memory provider; SQLite и E2E проверяет
  оркестратор при интеграции.
