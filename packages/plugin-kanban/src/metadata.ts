import type { UiContribution } from "@kanbaner/plugin-sdk";

import { TASK_STATUSES, type TaskStatus } from "@kanbaner/plugin-tasks/contract";

/** Глобально уникальный Plugin ID канбана. */
export const KANBAN_PLUGIN_ID = "kanbaner.kanban" as const;

/** Контракт UI-вкладов канбана. */
export const KANBAN_UI_CONTRACT = "kanbaner.kanban.ui.v1" as const;

/** Маршрут представления канбана. */
export const KANBAN_ROUTE = "/view/kanban" as const;

/** Фиксированный порядок колонок доски. */
export const KANBAN_COLUMN_ORDER: readonly TaskStatus[] = TASK_STATUSES;

/**
 * Метаданные UI-вкладов канбана.
 *
 * Файл не импортирует kernel, React или server-модули: его используют обе
 * точки входа — серверная (регистрация metadata) и клиентская (привязка
 * реальных рендереров). Домен задач остаётся единственным владельцем данных.
 */
export const kanbanUiContributions: readonly UiContribution[] = Object.freeze([
  {
    id: "kanbaner.kanban.view",
    slot: "app.main",
    kind: "view",
    priority: 70,
    title: "Канбан",
    description: "Доска задач с четырьмя колонками, фильтрами и перемещением",
    route: KANBAN_ROUTE,
  },
  {
    id: "kanbaner.kanban.navigation",
    slot: "app.sidebar",
    kind: "navigation",
    priority: 10,
    title: "Канбан",
    route: KANBAN_ROUTE,
  },
  {
    id: "kanbaner.kanban.details",
    slot: "app.overlays",
    kind: "panel",
    priority: 20,
    title: "Детали задачи",
    description: "Детали и редактор выбранной карточки на маршруте канбана",
  },
]);
