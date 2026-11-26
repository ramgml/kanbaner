# KAN-037 — устранение deferred-гонок UI заметок

Ветка: `feat/kan-037-review-ui` (worktree `feat-kan-037-review-ui`).
Область: только `packages/plugin-notes/src/ui/**`. Домен, `apps/web`,
манифесты и composition не изменялись.

## Что исправлено

1. **Deferred autosave применялся к другой заметке.** Ответ `notes.update`
   обрабатывался по живым refs: если пользователь успевал открыть другую
   страницу, её версия, `details` и индикатор сохранения перезаписывались
   результатом прошлого запроса. Теперь решения после `await` принимаются по
   снимку операции (`id`, `title`, `content`, `expectedVersion`, вложения), а
   запись в состояние выполняется только при совпадении
   `selectedIdRef.current === snapshot.id`.
2. **Очистка вложений удаляла только что загруженный файл.** Список «лишних»
   вложений строился по `attachmentsRef.current` после сохранения, поэтому
   upload, завершившийся во время `update`, попадал в удаление. Теперь набор
   кандидатов берётся из снимка и дополнительно фильтруется по актуальному
   списку вложений заметки.
3. **Очистка вложений ломала undo.** Если после сохранения черновик снова
   изменился (изображение вернули), очистка не запускается: удаление шло бы по
   устаревшему Markdown.
4. **Загрузка заметки затирала ввод.** `notes.get` + `attachmentGet` могли
   завершиться после начала правки и сбрасывали `title`/`content`/`dirty`/
   `saveState`. Добавлен `draftRevisionRef`: черновик, начатый после старта
   загрузки той же заметки, сохраняется.
5. **`move` перезагружал открытую заметку.** Полный `loadNote` стирал черновик.
   Вместо него версия и позиция синхронизируются из ответа `move` (включая
   `affectedNotes` соседа), а `ancestors` пересчитываются из свежего списка.
6. **Отсутствовали ключи идемпотентности.** В `runtime.ts` добавлены
   `UiInvokeOptions`, `snapshotIdempotencyKey` (FNV-1a по стабильному JSON) и
   `newIdempotencyKey`. Ключ `update`/`attachmentCreate` стабилен по снимку,
   ключ `create` живёт до успеха и меняется после него, поэтому retry не даёт
   дублей.
7. **Ошибка связи теряла созданную заметку.** `RelatedNotesPanel` запоминает
   созданный `noteId`: при сбое `link` показываются «Открыть заметку» и
   «Повторить связь» (повторяет только `link`), ошибка обновления списка больше
   не выдаётся за ошибку создания.
8. **`NoteLinks` удалял связь с перевёрнутыми refs.** В команду передаются
   фактические `sourceRef`/`targetRef` записи связи, а не только «другая»
   сторона.
9. **Семантика разметки.** `/view/notes` больше не вкладывает `<main>` в
   shell, фильтр списка переведён с `role="tablist"/tab` на
   `role="group"` + `aria-pressed`, поле заголовка блокируется на время загрузки
   и занятости.
10. **«Недавние» шли в порядке дерева.** `NoteTree` получил режим `flat`:
    сохраняет переданный порядок (`lastOpenedAt`), не показывает иерархию,
    DnD и кнопки reorder, `aria-label` меняется на «Список заметок».

## Изменённые файлы

- `packages/plugin-notes/src/ui/runtime.ts`, `runtime.test.ts`;
- `packages/plugin-notes/src/ui/notes-view.tsx`, `notes-view.test.tsx`;
- `packages/plugin-notes/src/ui/note-tree.tsx`, `note-tree.test.tsx`;
- `packages/plugin-notes/src/ui/related-notes-panel.tsx`,
  `related-notes-panel.test.tsx` (новый);
- `packages/plugin-notes/src/ui/note-links.tsx`, `note-links.test.tsx` (новый).

Дополнительно в тестах устранены два typecheck-дефекта предыдущей итерации
(`TS2532` на `created[0]` и `TS6133` на неиспользуемом параметре) и применён
Prettier к трём файлам.

## Проверки

- `vitest run packages/plugin-notes/src/ui` — **9 файлов / 88 тестов зелёные**.
- `pnpm typecheck` — зелёный по всем пакетам и `apps/web`.
- `eslint packages/plugin-notes/src/ui` — без ошибок.
- `prettier --check packages/plugin-notes/src/ui` — чисто.

Не выполнялись (вне объёма брифа): полный `pnpm test`, `pnpm build`,
Playwright E2E, проверка на Windows.

## Остаточные риски

- `snapshotIdempotencyKey` использует FNV-1a: теоретически возможна коллизия
  для разных payload; ключ только снижает вероятность дубля при retry и не
  заменяет серверную проверку версии.
- В режиме `flat` «Недавние» не показывают иерархию и не поддерживают
  reorder — это осознанное поведение, а не регрессия.
- Ключ создания в `RelatedNotesPanel` живёт на уровне компонента: перезагрузка
  вкладки между `create` и `link` оставит несвязанную заметку.
