---
id: KAN-063
title: Копирование кода и черновики по OpenCode-сессиям
status: backlog
stage: 8
priority: high
owner: unassigned
blocked_by: [KAN-062]
branch: null
worktree: null
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

- 2026-11-23 — Задача создана по пункту 4 roadmap; ожидает KAN-062.

## Итог

Заполняется оркестратором после интеграции.
