/**
 * Публичные константы домена задач.
 *
 * Здесь фиксируются только стабильные идентификаторы контракта, имена
 * коллекций документов и доменные лимиты. Конкретная физическая схема
 * хранения остаётся деталью Storage Provider.
 */

/** Глобально уникальный Plugin ID домена задач. */
export const PLUGIN_ID = "kanbaner.tasks" as const;

/** Тип ресурса проекта в формате ResourceRef. */
export const PROJECT_RESOURCE_TYPE = "project" as const;

/** Тип ресурса задачи в формате ResourceRef. */
export const TASK_RESOURCE_TYPE = "task" as const;

/** Коллекция документов проектов в namespace плагина. */
export const PROJECT_COLLECTION = "projects" as const;

/** Коллекция документов задач в namespace плагина. */
export const TASK_COLLECTION = "tasks" as const;

/** Контракт команд задач. */
export const TASKS_COMMANDS_CONTRACT = "kanbaner.tasks.commands.v1" as const;

/** Контракт запросов задач. */
export const TASKS_QUERIES_CONTRACT = "kanbaner.tasks.queries.v1" as const;

/** Контракт событий задач. */
export const TASKS_EVENTS_CONTRACT = "kanbaner.tasks.events.v1" as const;

/** Контракт доменного Store задач. */
export const TASKS_STORE_CONTRACT = "kanbaner.tasks.store.v1" as const;

/** Версия контракта команд, запросов, событий и Store. */
export const TASKS_CONTRACT_VERSION = 1 as const;

/** ID команд домена задач. */
export const TASKS_COMMAND_IDS = Object.freeze({
  projectCreate: "kanbaner.tasks.project.create",
  projectUpdate: "kanbaner.tasks.project.update",
  projectDelete: "kanbaner.tasks.project.delete",
  taskCreate: "kanbaner.tasks.task.create",
  taskUpdate: "kanbaner.tasks.task.update",
  taskMove: "kanbaner.tasks.task.move",
  taskComplete: "kanbaner.tasks.task.complete",
  taskDelete: "kanbaner.tasks.task.delete",
} as const);

export type TasksCommandName = keyof typeof TASKS_COMMAND_IDS;

/** ID запросов домена задач. */
export const TASKS_QUERY_IDS = Object.freeze({
  projectList: "kanbaner.tasks.project.list",
  projectGet: "kanbaner.tasks.project.get",
  taskGet: "kanbaner.tasks.task.get",
  taskList: "kanbaner.tasks.task.list",
} as const);

export type TasksQueryName = keyof typeof TASKS_QUERY_IDS;

/** Типы событий проектов. */
export const PROJECT_EVENT_TYPES = Object.freeze({
  created: "kanbaner.tasks.project.created",
  updated: "kanbaner.tasks.project.updated",
  deleted: "kanbaner.tasks.project.deleted",
} as const);

/** Типы событий задач. */
export const TASK_EVENT_TYPES = Object.freeze({
  created: "kanbaner.tasks.task.created",
  updated: "kanbaner.tasks.task.updated",
  moved: "kanbaner.tasks.task.moved",
  completed: "kanbaner.tasks.task.completed",
  deleted: "kanbaner.tasks.task.deleted",
} as const);

/** Все типы событий домена задач. */
export const TASKS_EVENT_TYPES = Object.freeze([
  ...Object.values(PROJECT_EVENT_TYPES),
  ...Object.values(TASK_EVENT_TYPES),
] as const);

export type TasksEventType = (typeof TASKS_EVENT_TYPES)[number];

/** Лимит страницы по умолчанию для запросов списков. */
export const DEFAULT_LIST_LIMIT = 50;

/** Максимальный лимит страницы. */
export const MAX_LIST_LIMIT = 200;

/** Максимальная длина заголовка проекта или задачи. */
export const MAX_TITLE_LENGTH = 200;

/** Максимальная длина Markdown-описания. */
export const MAX_DESCRIPTION_LENGTH = 100_000;

/** Максимальное количество тегов на задачу. */
export const MAX_TAGS = 10;

/** Максимальная длина одного нормализованного тега. */
export const MAX_TAG_LENGTH = 32;

/** Максимальная длина поискового фильтра `text`. */
export const MAX_SEARCH_TEXT_LENGTH = 200;

/**
 * Максимально допустимая позиция задачи.
 *
 * Позиция уникальна и упорядочена в области `(projectId, status)`; вложенность
 * через `parentTaskId` на область не влияет, непрерывность не требуется.
 */
export const MAX_POSITION = 2_147_483_647;
