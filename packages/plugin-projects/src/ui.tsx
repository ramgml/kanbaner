"use client";

import { defineUiPlugin } from "@kanbaner/task-ui";

import { PROJECTS_PLUGIN_ID } from "./metadata.ts";
import { projectsUiContributions } from "./metadata.ts";
import { KanbanView } from "./ui/kanban-view.tsx";
import { ProjectsOverview } from "./ui/projects-overview.tsx";
import { ProjectsMobileSheet } from "./ui/projects-mobile-sheet.tsx";
import { ProjectSidebar } from "./ui/project-sidebar.tsx";
import { TaskOverlay } from "./ui/task-overlay.tsx";
import { TaskDetailsPanel } from "./task-list/task-details-panel.tsx";
import { TaskListView } from "./task-list/task-list-view.tsx";

export { KanbanView } from "./ui/kanban-view.tsx";
export { ProjectsOverview } from "./ui/projects-overview.tsx";
export { ProjectsMobileSheet } from "./ui/projects-mobile-sheet.tsx";
export { ProjectSidebar } from "./ui/project-sidebar.tsx";
export { TaskOverlay, type TaskOverlayProps } from "./ui/task-overlay.tsx";
export { TaskListView } from "./task-list/task-list-view.tsx";
export { TaskDetailsPanel } from "./task-list/task-details-panel.tsx";
export {
  PROJECT_ROUTES,
  KANBAN_ROUTE,
  PROJECTS_OVERVIEW_ROUTE,
  PROJECTS_PLUGIN_ID,
  PROJECTS_UI_CONTRACT,
  TASK_LIST_ROUTE,
  projectsUiContributions,
  type ProjectRoute,
} from "./metadata.ts";
export {
  KANBAN_PAGE_SIZE,
  applyPlacements,
  createEmptyColumns,
  getColumn,
  placementForIndex,
  resolveMovePosition,
  type KanbanColumnData,
  type KanbanColumns,
  type MoveIntent,
  type Placement,
} from "./ui/board-state.ts";
export {
  DEFAULT_KANBAN_QUERY,
  getKanbanQuerySnapshot,
  parseKanbanQuery,
  registerKanbanSearchWriter,
  resetKanbanFilters,
  resetKanbanQueryForTests,
  updateKanbanQuery,
  useKanbanQuery,
  type KanbanQueryState,
} from "./ui/query-state.ts";
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
} from "./task-list/query-state.ts";

/**
 * UI-entrypoint единого плагина проектов.
 *
 * Реальные рендереры привязываются к серверным metadata только в
 * `apps/web/src/ui/builtin-ui-plugins.ts`. При отключённом плагине metadata
 * отсутствует, поэтому этот код не может сделать вклад видимым.
 */
function contributionAt(index: number) {
  const contribution = projectsUiContributions[index];

  if (contribution === undefined) {
    throw new Error(`Отсутствует UI-вклад kanbaner.projects с индексом ${String(index)}`);
  }

  return contribution;
}

export const projectsUiPlugin = defineUiPlugin({
  id: PROJECTS_PLUGIN_ID,
  contributions: [
    {
      metadata: contributionAt(0),
      render: (props) => (
        <KanbanView
          invoke={props.invoke}
          pathname={props.pathname}
          search={props.search}
          replaceSearch={props.replaceSearch}
        />
      ),
    },
    {
      metadata: contributionAt(1),
      render: (props) => (
        <TaskListView
          invoke={props.invoke}
          pathname={props.pathname}
          search={props.search}
          replaceSearch={props.replaceSearch}
        />
      ),
    },
    {
      metadata: contributionAt(2),
      render: (props) => (
        <ProjectsOverview
          invoke={props.invoke}
          pathname={props.pathname}
          search={props.search}
          replaceSearch={props.replaceSearch}
        />
      ),
    },
    {
      metadata: contributionAt(3),
      render: (props) => <ProjectSidebar invoke={props.invoke} />,
    },
    {
      metadata: contributionAt(4),
      render: (props) => <TaskDetailsPanel {...props} variant="desktop" />,
    },
    {
      metadata: contributionAt(5),
      render: (props) => <TaskDetailsPanel {...props} variant="mobile" />,
    },
    {
      metadata: contributionAt(6),
      render: (props) => (
        <TaskOverlay
          invoke={props.invoke}
          pathname={props.pathname}
          search={props.search}
          replaceSearch={props.replaceSearch}
        />
      ),
    },
    {
      metadata: contributionAt(7),
      render: (props) => <ProjectsMobileSheet invoke={props.invoke} />,
    },
  ],
});
