---
id: KAN-063
title: Копирование кода и черновики по OpenCode-сессиям
status: in_progress
stage: 8
priority: high
owner: worker-kan-063
blocked_by: []
branch: feat/kan-063-code-copy-session-drafts
worktree: .worktrees/kan-063-code-copy-session-drafts
created: 2026-11-23
updated: 2026-11-23
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

- [ ] Добавить copy action для существующего Markdown renderer без raw HTML.
- [ ] Спроектировать версионированный, ограниченный по размеру draft storage.
- [ ] Сохранять/восстанавливать черновики по session ID с безопасным fallback.
- [ ] Обработать clipboard denial, storage errors, StrictMode и stale async state.
- [ ] Добавить unit/E2E и документацию.

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

- [ ] Copy копирует именно код выбранного block и сообщает успех/ошибку.
- [ ] Черновики изолированы по session ID и переживают reload.
- [ ] Новая сессия получает пустой или собственный черновик, не чужой текст.
- [ ] Недоступный/повреждённый storage не блокирует composer.
- [ ] В localStorage не попадают base64 вложения и содержимое истории.
- [ ] Unit/E2E и полный `pnpm check` зелёные.

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

## Итог

Заполняется оркестратором после интеграции.
