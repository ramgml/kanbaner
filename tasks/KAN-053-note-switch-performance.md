---
id: KAN-053
title: Ускорить переключение заметок с блоками и вложениями
status: in_progress
stage: 1
priority: high
owner: opencode-worker
blocked_by: []
branch: perf/kan-053-note-switch
worktree: .worktrees/kan-053-note-switch
created: 2026-11-17
updated: 2026-11-17
specs:
  - specs/technology-stack.md
---

# KAN-053 — Ускорить переключение заметок с блоками и вложениями

## Цель

Устранить ощутимую задержку около секунды при переходе на «Галерею блоков» и обратно.

## Результат

Переключение заметок ощущается быстрым; содержимое, черновики, вложения и автосохранение остаются корректными.

## Объём работ

- [ ] Измерить browser timing: note.get, attachment.get, React render, Markdown parse/serialize.
- [ ] Найти и устранить основной bottleneck без изменения persisted Markdown.
- [ ] Избежать лишних повторных рендеров/сетевых запросов и учесть быстрые переходы.
- [ ] Добавить regression/performance smoke без хрупких жёстких timing assertions.

## Владение файлами

Разрешено:

- `packages/plugin-notes/src/ui/**` и тесты;
- `apps/web/e2e/notes.spec.ts`;
- `tasks/reports/KAN-053.md`.

Запрещено:

- изменение домена, схемы вложений, Storage Provider и Markdown-контракта.

## Критерии приёмки

- [ ] Основная причина задержки измерена и устранена.
- [ ] Переключение не ждёт ненужную работу и не теряет dirty draft.
- [ ] Изображения и все блоки корректно отображаются после reload.
- [ ] Полные проверки и notes E2E зелёные.

## Журнал

- 2026-11-17 — Задача создана по сообщению пользователя о задержке переключения.

## Итог

- Коммит:
- Проверки:
