# KAN-037 — устранение findings независимого ревью

Статус: все findings закрыты; выполняются финальные проверки интеграции.

## Findings и владельцы исправления

1. **Blocker: attachment cleanup по устаревшему Markdown** — UI worker.
   Cleanup запрещён при смене документа или черновика во время update; добавляются
   deferred delete+Undo/upload/switch-note tests.
2. **Blocker: loadNote затирает ввод** — UI worker. Title блокируется при
   loading/busy, добавляется draft revision guard; move обновляет details без
   лишнего полного reload.
3. **High: reference-style images** — domain worker. Общий AST-механизм для
   `imageReference` + `definition`: validation, cleanup, export и regression test.
4. **High: неподтверждённое поддерево при delete** — domain + UI workers.
   Fresh `note.subtree` preview + `expectedDescendants`, атомарно проверяемые Store.
5. **Medium: reorder соседа вызывает ложный VERSION_CONFLICT** — UI worker.
   Открытая заметка синхронизируется из `affectedNotes` без потери черновика.
6. **Medium: UI не передаёт Idempotency-Key** — transport worker. Additive
   `options.idempotencyKey` от invoker до OperationBus; snapshot-stable keys в UI.
7. **Medium: частичный related-note workflow** — UI worker. Pending note ID,
   повтор только link, refresh error отделён от результата создания.
8. **Medium: входящая связь не удаляется** — domain + UI workers. Передаются
   фактические sourceRef/targetRef выбранной связи с проверкой участника.
9. **Low: landmarks и tabs** — UI worker. Нет вложенного main; фильтры — обычная
   группа кнопок вместо неполного tabs pattern.
10. **Low: recent сортируется деревом** — UI worker. Плоский список по
    `lastOpenedAt`, без position reorder.

## Гейты повторного закрытия

- Все перечисленные regression tests добавлены и зелёные.
- Полный `pnpm check` и все Playwright проходят после интеграции.
- Повторное независимое ревью не содержит blocker/high без исправления.
- Отчёты содержат коммиты и фактические проверки; известные ограничения явны.

## Результат повторного ревью

- Autosave больше не удаляет вложения: очистка возможна только явным действием
  после сохранения и `ATTACHMENT_IN_USE` проверки. Это исключает гонку и с Undo,
  и с deferred delete.
- Upload сериализован через `uploadChainRef`; retry после ошибки сохраняет ключ,
  следующий успешный upload получает новый. Deferred parallel test подтверждает
  `maxActive = 1` и корректные ключи.
- UI передаёт `expectedDescendants = preview.noteCount` (включая корень) и
  синхронизирует версию открытой страницы из `affectedNotes` после любого move.
- Независимое повторное ревью подтвердило закрытие всех исходных blocker/high/
  medium и последующего medium для параллельных upload.
