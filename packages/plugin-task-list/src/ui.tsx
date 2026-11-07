"use client";

import { defineUiPlugin } from "@kanbaner/task-ui";

import { TASK_LIST_PLUGIN_ID, TASK_LIST_ROUTE } from "./metadata.ts";
import { TaskDetailsPanel } from "./ui/task-details-panel.tsx";
import { TaskListView } from "./ui/task-list-view.tsx";

export { TaskDetailsPanel } from "./ui/task-details-panel.tsx";
export { TaskListView } from "./ui/task-list-view.tsx";
export {
  DEFAULT_TASK_LIST_QUERY,
  TASK_LIST_PAGE_SIZE,
  bumpTaskListRevision,
  getTaskListQuerySnapshot,
  parseTaskListQuery,
  resetTaskListFilters,
  resetTaskListQueryForTests,
  updateTaskListQuery,
  useTaskListQuery,
  type TaskListQueryState,
  type TaskListSortField,
} from "./ui/query-state.ts";

/**
 * UI-entrypoint плагина списка.
 *
 * Реальные рендереры привязываются к серверным metadata только в
 * `apps/web/src/ui/builtin-ui-plugins.ts`. При отключённом плагине metadata
 * отсутствует, поэтому этот код не может сделать вклад видимым.
 */
export const taskListUiPlugin = defineUiPlugin({
  id: TASK_LIST_PLUGIN_ID,
  contributions: [
    {
      metadata: {
        id: "kanbaner.task-list.view",
        slot: "app.main",
        kind: "view",
        priority: 60,
        title: "Задачи",
        description: "Адаптивный список задач с фильтрами, сортировкой и пагинацией",
        route: TASK_LIST_ROUTE,
      },
      render: TaskListView,
    },
    {
      metadata: {
        id: "kanbaner.task-list.navigation",
        slot: "app.sidebar",
        kind: "navigation",
        priority: 20,
        title: "Задачи",
        route: TASK_LIST_ROUTE,
      },
      render: () => null,
    },
    {
      metadata: {
        id: "kanbaner.task-list.details",
        slot: "app.details",
        kind: "panel",
        priority: 20,
        title: "Детали задачи",
      },
      render: (props) => <TaskDetailsPanel {...props} variant="desktop" />,
    },
    {
      metadata: {
        id: "kanbaner.task-list.details-mobile",
        slot: "app.overlays",
        kind: "panel",
        priority: 20,
        title: "Детали задачи",
      },
      render: (props) => <TaskDetailsPanel {...props} variant="mobile" />,
    },
  ],
});
