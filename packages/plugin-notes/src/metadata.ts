import type { UiContribution } from "@kanbaner/plugin-sdk";

import { NOTE_RESOURCE_TYPE, NOTES_ROUTE } from "./constants.ts";

/** Публичный слот панели связанных заметок, опубликованный плагином проектов. */
export const NOTES_TASK_RELATED_SLOT = "kanbaner.projects.task.related" as const;

/**
 * Метаданные UI-вкладов заметок.
 *
 * Файл не импортирует kernel, React или серверные модули: его используют обе
 * точки входа — серверная (регистрация metadata) и клиентская (привязка
 * реальных рендереров). Домен заметок остаётся единственным владельцем данных.
 */
export const notesUiContributions: readonly UiContribution[] = Object.freeze([
  {
    id: "kanbaner.notes.view",
    slot: "app.main",
    kind: "view",
    priority: 80,
    title: "Заметки",
    description: "Дерево страниц и визуальный Markdown-редактор заметок",
    route: NOTES_ROUTE,
  },
  {
    id: "kanbaner.notes.sidebar",
    slot: "app.sidebar",
    kind: "panel",
    priority: 20,
    title: "Заметки",
    description: "Дерево, поиск и создание страниц в глобальной боковой панели",
  },
  {
    id: "kanbaner.notes.navigation",
    slot: "app.sidebar",
    kind: "navigation",
    priority: 50,
    title: "Заметки",
    description: "Вход в рабочее пространство заметок",
    route: NOTES_ROUTE,
    icon: "notebook-tabs",
  },
  {
    id: "kanbaner.notes.open",
    slot: "app.main",
    kind: "resource-opener",
    priority: 80,
    title: "Заметки",
    description: "Открывает страницу заметки по ResourceRef",
    route: NOTES_ROUTE,
    resourceType: NOTE_RESOURCE_TYPE,
  },
  {
    id: "kanbaner.notes.task-related",
    slot: NOTES_TASK_RELATED_SLOT,
    kind: "panel",
    priority: 30,
    title: "Заметки",
    description: "Связанные заметки текущей задачи",
  },
]);
