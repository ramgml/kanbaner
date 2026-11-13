/**
 * `@kanbaner/task-ui` — общая библиотека представления задач.
 *
 * Пакет не является плагином и не имеет собственного Plugin ID. Он содержит
 * React-компоненты на Tailwind и семантическом HTML, React-free контракт
 * вызова операций и чистые помощники форматирования. Типы предметной области
 * берутся только из client-safe `@kanbaner/plugin-tasks/contract`.
 */
export {
  defineUiPlugin,
  type RegisteredUiContributionLike,
  type UiContributionDescriptor,
  type UiOperationError,
  type UiOperationInvokeOptions,
  type UiOperationInvoker,
  type UiOperationResult,
  type UiPluginContribution,
  type UiPluginDefinition,
  type UiRenderer,
  type UiRendererProps,
  type UiResourceOpener,
  type UiResourceOpenResult,
  type UiSlotRenderer,
} from "./runtime.ts";

export {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  dateInputToDueAt,
  dueAtToDateInput,
  formatDueAt,
  parseTagsInput,
  tagsToInput,
  taskPriorities,
  taskPriorityLabel,
  taskStatuses,
  taskStatusLabel,
} from "./format.ts";

export { TaskCard, type TaskCardProps } from "./components/task-card.tsx";
export { TaskTable, type TaskTableProps } from "./components/task-table.tsx";
export { TaskDetails, type TaskDetailsProps } from "./components/task-details.tsx";
export {
  EMPTY_TASK_FILTERS,
  TaskFilters,
  type TaskFilterValues,
  type TaskFiltersProps,
} from "./components/task-filters.tsx";
export {
  ProjectForm,
  TaskForm,
  createProjectFormValues,
  createTaskFormValues,
  taskToFormValues,
  type ProjectFormProps,
  type ProjectFormValues,
  type TaskFormProps,
  type TaskFormValues,
} from "./components/task-form.tsx";
export {
  EmptyState,
  ErrorState,
  LoadingState,
  type EmptyStateProps,
  type ErrorStateProps,
  type LoadingStateProps,
} from "./components/states.tsx";
export { ModalDialog, type ModalDialogProps } from "./components/modal-dialog.tsx";
export { useMediaQuery } from "./hooks/use-media-query.ts";
