import type { UiContribution } from "@kanbaner/plugin-sdk";

import {
  PLUGIN_ID as TASKS_PLUGIN_ID,
  PROJECT_RESOURCE_TYPE,
  TASK_RESOURCE_TYPE,
  TASK_STATUSES,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";

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

/**
 * Опубликованный слот связанных материалов задачи.
 *
 * Плагин-проект только объявляет outlet и передаёт ResourceRef задачи; сам он
 * не знает и не импортирует плагины, которые его заполняют.
 */
export const TASK_RELATED_SLOT = "kanbaner.projects.task.related" as const;

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
  {
    // Единственный вход из shell в рабочее пространство. `entry=1` заставляет
    // обзор восстановить последнее представление проекта, не дублируя два
    // старых пункта навигации.
    id: "kanbaner.projects.navigation",
    slot: "app.sidebar",
    kind: "navigation",
    priority: 40,
    title: "Проекты",
    description: "Вход в рабочее пространство проектов",
    route: `${PROJECTS_OVERVIEW_ROUTE}?entry=1`,
    icon: "folder-kanban",
  },
  {
    // Открытие ресурса чужого домена: shell добавляет к маршруту
    // `resource=<encoded ResourceRef>`, а KanbanView переводит ссылку в
    // существующий выбор проекта.
    id: "kanbaner.projects.resource-opener.project",
    slot: "app.main",
    kind: "resource-opener",
    priority: 90,
    title: "Открыть проект",
    description: "Открывает проект задач в рабочем пространстве",
    route: KANBAN_ROUTE,
    resourcePluginId: TASKS_PLUGIN_ID,
    resourceType: PROJECT_RESOURCE_TYPE,
  },
  {
    // Задача открывается в существующем Trello-модале через query `task`.
    id: "kanbaner.projects.resource-opener.task",
    slot: "app.main",
    kind: "resource-opener",
    priority: 90,
    title: "Открыть задачу",
    description: "Открывает задачу задач в канбане проекта",
    route: KANBAN_ROUTE,
    resourcePluginId: TASKS_PLUGIN_ID,
    resourceType: TASK_RESOURCE_TYPE,
  },
]);
