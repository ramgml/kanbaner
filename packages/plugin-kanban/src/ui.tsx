"use client";

import { defineUiPlugin } from "@kanbaner/task-ui";

import { KANBAN_PLUGIN_ID, KANBAN_ROUTE } from "./metadata.ts";
import { KanbanView } from "./ui/kanban-view.tsx";
import { TaskOverlay } from "./ui/task-overlay.tsx";

export { KanbanView } from "./ui/kanban-view.tsx";
export { TaskOverlay, type TaskOverlayProps } from "./ui/task-overlay.tsx";
export {
  KANBAN_PAGE_SIZE,
  applyPlacements,
  computeMovePosition,
  createEmptyColumns,
  getColumn,
  placementForIndex,
  type KanbanColumnData,
  type KanbanColumns,
  type Placement,
} from "./ui/board-state.ts";
export {
  DEFAULT_KANBAN_QUERY,
  getKanbanQuerySnapshot,
  parseKanbanQuery,
  resetKanbanFilters,
  resetKanbanQueryForTests,
  updateKanbanQuery,
  useKanbanQuery,
  type KanbanQueryState,
} from "./ui/query-state.ts";

/**
 * UI-entrypoint плагина канбана.
 *
 * Реальные рендереры привязываются к серверным metadata только в
 * `apps/web/src/ui/builtin-ui-plugins.ts`. При отключённом плагине metadata
 * отсутствует, поэтому этот код не может сделать вклад видимым.
 */
export const kanbanUiPlugin = defineUiPlugin({
  id: KANBAN_PLUGIN_ID,
  contributions: [
    {
      metadata: {
        id: "kanbaner.kanban.view",
        slot: "app.main",
        kind: "view",
        priority: 70,
        title: "Канбан",
        description: "Доска задач с четырьмя колонками, фильтрами и перемещением",
        route: KANBAN_ROUTE,
      },
      render: (props) => <KanbanView invoke={props.invoke} />,
    },
    {
      metadata: {
        id: "kanbaner.kanban.navigation",
        slot: "app.sidebar",
        kind: "navigation",
        priority: 10,
        title: "Канбан",
        route: KANBAN_ROUTE,
      },
      render: () => null,
    },
    {
      metadata: {
        id: "kanbaner.kanban.details",
        slot: "app.overlays",
        kind: "panel",
        priority: 20,
        title: "Детали задачи",
        description: "Детали и редактор выбранной карточки на маршруте канбана",
      },
      render: (props) => <TaskOverlay invoke={props.invoke} pathname={props.pathname} />,
    },
  ],
});
