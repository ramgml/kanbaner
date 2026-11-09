import type { UiContribution } from "@kanbaner/plugin-sdk";

import { TASK_STATUSES, type TaskStatus } from "@kanbaner/plugin-tasks/contract";

/** Глобально уникальный Plugin ID рабочего пространства проектов. */
export const PROJECTS_PLUGIN_ID = "kanbaner.projects" as const;

/** Контракт UI-вкладов рабочего пространства проектов. */
export const PROJECTS_UI_CONTRACT = "kanbaner.projects.ui.v1" as const;

/** Маршрут канбана одного проекта. */
export const KANBAN_ROUTE = "/view/kanban" as const;

/** Маршрут списка задач. */
export const TASK_LIST_ROUTE = "/view/tasks" as const;

/** Необязательный обзор проектов. Не является путём переключения. */
export const PROJECTS_OVERVIEW_ROUTE = "/view/projects" as const;

/** Маршруты, на которых показывается секция «Проекты». */
export const PROJECT_ROUTES = [KANBAN_ROUTE, TASK_LIST_ROUTE, PROJECTS_OVERVIEW_ROUTE] as const;

export type ProjectRoute = (typeof PROJECT_ROUTES)[number];

/** Фиксированный порядок колонок доски. */
export const KANBAN_COLUMN_ORDER: readonly TaskStatus[] = TASK_STATUSES;

/**
 * Метаданные UI-вкладов рабочего пространства.
 *
 * Файл не импортирует kernel, React или server-модули: его используют обе
 * точки входа — серверная (регистрация metadata) и клиентская (привязка
 * реальных рендереров). Домен задач остаётся единственным владельцем данных.
 */
export const projectsUiContributions: readonly UiContribution[] = Object.freeze([
  {
    id: "kanbaner.projects.view.kanban",
    slot: "app.main",
    kind: "view",
    priority: 70,
    title: "Канбан",
    description: "Доска одного проекта с четырьмя колонками и перемещением",
    route: KANBAN_ROUTE,
  },
  {
    id: "kanbaner.projects.view.tasks",
    slot: "app.main",
    kind: "view",
    priority: 60,
    title: "Задачи",
    description: "Адаптивный список задач выбранного проекта",
    route: TASK_LIST_ROUTE,
  },
  {
    id: "kanbaner.projects.view.overview",
    slot: "app.main",
    kind: "view",
    priority: 65,
    title: "Проекты",
    description: "Необязательный обзор проектов со сводками",
    route: PROJECTS_OVERVIEW_ROUTE,
  },
  {
    id: "kanbaner.projects.sidebar",
    slot: "app.sidebar",
    kind: "panel",
    priority: 10,
    title: "Проекты",
    description: "Переключение и создание проектов",
  },
  {
    id: "kanbaner.projects.details",
    slot: "app.details",
    kind: "panel",
    priority: 20,
    title: "Детали задачи",
    description: "Панель выбранной задачи списка на десктопе",
    route: TASK_LIST_ROUTE,
  },
  {
    id: "kanbaner.projects.details-mobile",
    slot: "app.overlays",
    kind: "panel",
    priority: 20,
    title: "Детали задачи",
    description: "Полноэкранная панель выбранной задачи списка на мобильном",
  },
  {
    id: "kanbaner.projects.kanban-overlay",
    slot: "app.overlays",
    kind: "panel",
    priority: 20,
    title: "Детали задачи",
    description: "Детали и редактор выбранной карточки на маршруте канбана",
  },
  {
    id: "kanbaner.projects.mobile-sheet",
    slot: "app.overlays",
    kind: "panel",
    priority: 30,
    title: "Проекты",
    description: "Мобильный bottom sheet со списком проектов",
  },
]);
