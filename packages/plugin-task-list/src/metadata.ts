import type { UiContribution } from "@kanbaner/plugin-sdk";

/** Глобально уникальный Plugin ID списка задач. */
export const TASK_LIST_PLUGIN_ID = "kanbaner.task-list" as const;

/** Контракт UI-вкладов списка задач. */
export const TASK_LIST_UI_CONTRACT = "kanbaner.task-list.ui.v1" as const;

/** Маршрут представления списка. */
export const TASK_LIST_ROUTE = "/view/tasks" as const;

/**
 * Метаданные UI-вкладов списка.
 *
 * Файл не импортирует kernel, React или server-модули: его используют обе
 * точки входа — серверная (регистрация metadata) и клиентская (привязка
 * реальных рендереров).
 */
export const taskListUiContributions: readonly UiContribution[] = Object.freeze([
  {
    id: "kanbaner.task-list.view",
    slot: "app.main",
    kind: "view",
    priority: 60,
    title: "Задачи",
    description: "Адаптивный список задач с фильтрами, сортировкой и пагинацией",
    route: TASK_LIST_ROUTE,
  },
  {
    id: "kanbaner.task-list.navigation",
    slot: "app.sidebar",
    kind: "navigation",
    priority: 20,
    title: "Задачи",
    route: TASK_LIST_ROUTE,
  },
  {
    id: "kanbaner.task-list.details",
    slot: "app.details",
    kind: "panel",
    priority: 20,
    title: "Детали задачи",
    description: "Панель выбранной задачи на десктопе",
    route: TASK_LIST_ROUTE,
  },
  {
    id: "kanbaner.task-list.details-mobile",
    slot: "app.overlays",
    kind: "panel",
    priority: 20,
    title: "Детали задачи",
    description: "Полноэкранная панель выбранной задачи на мобильном",
  },
]);
