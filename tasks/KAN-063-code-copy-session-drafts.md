---
id: KAN-063
title: Копирование кода и черновики по OpenCode-сессиям
status: done
stage: 8
priority: high
owner: worker-kan-063
blocked_by: []
branch: dev
worktree: .
created: 2026-11-23
updated: 2026-11-24
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/roadmap.md
---

# KAN-063 — Копирование кода и черновики по OpenCode-сессиям

## Цель

Реализовать пункт 4 roadmap: удобную работу с code blocks и сохранение composer
отдельно для каждой OpenCode-сессии.

## Результат

- Code block можно скопировать явной доступной кнопкой с понятным результатом.
- Несохранённый текст composer восстанавливается после reload и переключения сессий.
- Черновик одной сессии не появляется в другой; отправленный текст очищается только
  в черновике своей сессии.

## Объём работ

- [x] Добавить copy action для существующего Markdown renderer без raw HTML.
- [x] Спроектировать версионированный, ограниченный по размеру draft storage.
- [x] Сохранять/восстанавливать черновики по session ID с безопасным fallback.
- [x] Обработать clipboard denial, storage errors, StrictMode и stale async state.
- [x] Добавить unit/E2E и документацию.

## Владение файлами

Разрешено:

- `packages/opencode/src/ui.tsx`, `ui.test.tsx` и отдельные модули Markdown/drafts;
- `packages/markdown-ui/src/markdown-content.tsx` и его тесты;
- `packages/markdown-ui/README.md`;
- `packages/opencode/README.md`;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/product-mvp.md`, `specs/architecture.md`;
- `tasks/reports/KAN-063.md`.

Запрещено:

- серверное хранение черновиков, SQLite, миграции и новые аккаунты;
- новые зависимости, lock-файл, raw HTML и ослабление Markdown sanitization;
- хранение base64 вложений или секретов в draft storage.

## Контракты и зависимости

- Начинается после KAN-062 и не ломает его scroll semantics.
- До KAN-064 переключение проверяется через существующее восстановление последней сессии;
  полноценный список сессий появится следующей задачей.
- `MarkdownContent` получает только additive optional `codeBlockAction`; без prop
  поведение остальных плагинов не меняется, `skipHtml` сохраняется.
- Draft ограничен 16 384 символами на запись, 20 записями и 65 536 символами
  суммарно с LRU. Сверхлимитный текст остаётся в памяти composer, но не
  сохраняется; `maxLength` в textarea не добавляется.
- Существующий last session ID получает safe storage fallback, чтобы ошибки
  localStorage не блокировали панель и composer.

## Критерии приёмки

- [x] Copy копирует именно код выбранного block и сообщает успех/ошибку.
- [x] Черновики изолированы по session ID и переживают reload.
- [x] Новая сессия получает пустой или собственный черновик, не чужой текст.
- [x] Недоступный/повреждённый storage не блокирует composer.
- [x] В localStorage не попадают base64 вложения и содержимое истории.
- [x] Unit/E2E и полный `pnpm check` зелёные.

## Проверки

- Focused UI unit, clipboard/storage failure tests и Playwright desktop/mobile.
- `pnpm --filter @kanbaner/opencode typecheck` и `pnpm check`.

## Риски

- Большие черновики требуют ограничения размера и очистки устаревших записей.
- Отправка/abort/переключение не должны очистить черновик другой сессии.

## Журнал

- 2026-11-23 — Задача создана по пункту 4 roadmap; ожидала KAN-062.
- 2026-11-23 — KAN-062 завершена. Назначен `worker-kan-063`, создана ветка и
  worktree; статус `in_progress`. Оркестратор согласовал additive
  `codeBlockAction` в `markdown-ui`, bounded draft limits и safe fallback для
  существующего last session ID.
- 2026-11-23 — Worker реализовал copy action и per-session drafts. Коммит
  `0ab7b14`; focused unit 36/36 + UI 76/76, E2E 21/21, полный `pnpm check` —
  143 files / 2003 tests.
- 2026-11-23 — Ревью не нашло blocker/high, но выявило удаление нормативного
  абзаца разрешений из `architecture.md`, trim-признак изменённого composer и
  отсутствие 404 regression. Задача возвращена в `in_progress`.
- 2026-11-24 — Worker закрыл замечания коммитом `fa64b919`; focused unit
  114/114, E2E 21/21, полный `pnpm check` — 143 files / 2005 tests. Статус
  `review` перед финальным независимым ревью.
- 2026-11-24 — Финальное ревью не нашло blocker/high/medium/low. После rebase
  коммиты `caaecff` и `e9fe71e` интегрированы merge-коммитом `c8b13bb`.
  `pnpm check` на ветке и `dev` зелёный; OpenCode E2E на `dev` — 21/21,
  imports и SQLite smoke зелёные. Статус `done`.

## Итог

Пункт 4 roadmap реализован и смержен в `dev`. Code blocks получили доступное
копирование точного plain text с clipboard fallback. Composer сохраняет
ограниченные версионированные черновики отдельно для каждой OpenCode-сессии,
восстанавливает их после reload и не переносит текст между сессиями. Base64,
вложения и история в draft storage не записываются.

Merge: `c8b13bb`. Feature-ветка и worktree удалены. Push не выполнялся.
