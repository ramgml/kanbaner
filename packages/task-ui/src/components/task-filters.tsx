import type { Project } from "@kanbaner/plugin-tasks/contract";

import { taskPriorities, taskPriorityLabel, taskStatuses, taskStatusLabel } from "../format.ts";

export interface TaskFilterValues {
  readonly projectId: string;
  readonly status: string;
  readonly priority: string;
  readonly tag: string;
  readonly dueAfter: string;
  readonly dueBefore: string;
}

export const EMPTY_TASK_FILTERS: TaskFilterValues = Object.freeze({
  projectId: "",
  status: "",
  priority: "",
  tag: "",
  dueAfter: "",
  dueBefore: "",
});

export interface TaskFiltersProps {
  readonly projects: readonly Project[];
  readonly values: TaskFilterValues;
  readonly onChange: (patch: Partial<TaskFilterValues>) => void;
  readonly onReset: () => void;
  readonly disabled?: boolean;
}

const inputClass =
  "h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

const labelClass = "flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground";

/** Панель фильтров списка задач. Все поля доступны с клавиатуры. */
export function TaskFilters({
  projects,
  values,
  onChange,
  onReset,
  disabled = false,
}: TaskFiltersProps) {
  return (
    <form
      aria-label="Фильтры задач"
      data-testid="task-filters"
      className="flex flex-col gap-3 rounded-lg border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <label className={labelClass}>
          Проект
          <select
            name="projectId"
            value={values.projectId}
            disabled={disabled}
            onChange={(event) => {
              onChange({ projectId: event.target.value });
            }}
            className={inputClass}
          >
            <option value="">Все проекты</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Статус
          <select
            name="status"
            value={values.status}
            disabled={disabled}
            onChange={(event) => {
              onChange({ status: event.target.value });
            }}
            className={inputClass}
          >
            <option value="">Все статусы</option>
            {taskStatuses().map((status) => (
              <option key={status} value={status}>
                {taskStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Приоритет
          <select
            name="priority"
            value={values.priority}
            disabled={disabled}
            onChange={(event) => {
              onChange({ priority: event.target.value });
            }}
            className={inputClass}
          >
            <option value="">Все приоритеты</option>
            {taskPriorities().map((priority) => (
              <option key={priority} value={priority}>
                {taskPriorityLabel(priority)}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Тег
          <input
            name="tag"
            type="search"
            value={values.tag}
            disabled={disabled}
            onChange={(event) => {
              onChange({ tag: event.target.value });
            }}
            className={inputClass}
            placeholder="например, release"
          />
        </label>

        <label className={labelClass}>
          Срок с
          <input
            name="dueAfter"
            type="date"
            value={values.dueAfter}
            disabled={disabled}
            onChange={(event) => {
              onChange({ dueAfter: event.target.value });
            }}
            className={inputClass}
          />
        </label>

        <label className={labelClass}>
          Срок по
          <input
            name="dueBefore"
            type="date"
            value={values.dueBefore}
            disabled={disabled}
            onChange={(event) => {
              onChange({ dueBefore: event.target.value });
            }}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          Сбросить фильтры
        </button>
      </div>
    </form>
  );
}
