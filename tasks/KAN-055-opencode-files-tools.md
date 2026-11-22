---
id: KAN-055
title: Файлы и список инструментов в OpenCode-панели
status: in_progress
stage: 7
priority: high
owner: opencode-orchestrator
blocked_by: []
branch: dev
worktree: .
created: 2026-11-19
updated: 2026-11-21
specs:
  - specs/product-mvp.md
  - specs/architecture.md
  - specs/plugin-contract.md
  - specs/technology-stack.md
---

# KAN-055 — Файлы и список инструментов в OpenCode-панели

## Цель

Позволить пользователю прикреплять файлы к prompt и заранее видеть, какие операции доступны агенту.

## Результат

- Browser file picker принимает UTF-8 текст, PNG/JPEG/GIF/WebP и PDF с клиентской и серверной валидацией.
- Файлы передаются только через inline `data:` URL текущему OpenCode prompt; server paths не используются как attachments.
- Панель показывает имена вложений, позволяет удалить их до отправки и отображает их в истории.
- Изображения имеют previews в composer и сообщениях, включая восстановленную history через отдельный guarded binary endpoint; history JSON остаётся без Base64.
- Раскрываемый catalog показывает фактический MCP allowlist, read/write и `expectedVersion`.

## Объём работ

- [x] Добавить единый metadata allowlist инструментов в catalog и UI.
- [x] Добавить выбор, валидацию, отправку и отображение файлов.
- [x] Сохранить session ownership, streaming/abort и generation handling.
- [x] Добавить unit/integration/E2E и live smoke с текстовым файлом.
- [x] Обновить спецификации, README и отчёт.

## Владение файлами

Разрешено:

- `packages/opencode/**`;
- `apps/web/src/server/opencode-http*`;
- `apps/web/e2e/opencode.spec.ts`;
- `specs/**`, `README.md`, `AGENTS.md`;
- `tasks/KAN-055-opencode-files-tools.md`, `tasks/reports/KAN-055.md`.

Запрещено:

- filesystem/shell/delete tools;
- чтение произвольных server paths;
- секреты и file contents в логах;
- изменение доменных плагинов и чужих незакоммиченных изменений;
- commit/push без явной просьбы пользователя.

## Критерии приёмки

- [x] До 5 файлов, суммарно до 8 MiB; текст до 1 MiB, image/PDF до 5 MiB каждый.
- [x] Проверяются Base64, UTF-8 и signatures image/PDF; ошибки публичные и без file contents.
- [x] Данные передаются только выбранной модели; несовместимость media объяснена в UI.
- [x] Список инструментов совпадает с фактическим MCP list.
- [x] Проверки зелёные либо ограничения явно перечислены.

## Журнал

- 2026-11-19 — Задача создана по запросу пользователя. OpenCode V2 attachments docs подтверждают inline data URL, UTF-8 text, PNG/JPEG/GIF/WebP и PDF.
- 2026-11-19 — Пользователь явно выбрал warning без блокировки prompt для image/PDF при неподдержке моделью.
- 2026-11-20 — Coding и follow-up завершены: FileReader abort/generation и очистка selection только на `done`. Независимый reviewer не нашёл оставшихся blocker/high/medium.
- 2026-11-20 — `pnpm check` 1812/1812, OpenCode E2E 4/4, integration checks и live smoke с реальным текстовым файлом успешны. Подробности: `tasks/reports/KAN-055.md`.
- 2026-11-20 — Добавлены локальные image previews с сохранением при canonical refresh. Reviewer не нашёл дефектов; UI unit 24/24, OpenCode E2E 8/8, shell E2E 8/8.
- 2026-11-21 — Preview после reload переведено на guarded binary endpoint с canonical `file.data`/`source=inline`. Reviewer закрыл найденный blocker и low; focused 58/58, OpenCode/shell E2E 8/8 каждый, `pnpm check` 1841/1841. Live smoke реального OpenCode подтвердил точные PNG bytes, metadata-only history и wrong-session 404.

## Итог

Реализация и проверки завершены; существующие изменения сохраняются без коммита. Статус остаётся `in_progress` до интеграционного коммита/merge в `dev`.
