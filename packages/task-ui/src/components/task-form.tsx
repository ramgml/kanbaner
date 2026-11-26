import { useId, useState } from "react";

import type { Project, Task, TaskPriority, TaskStatus } from "@kanbaner/plugin-tasks/contract";

import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  dueAtToDateInput,
  tagsToInput,
  taskPriorities,
  taskStatuses,
} from "../format.ts";

export interface TaskFormValues {
  readonly projectId: string;
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueAt: string;
  readonly tags: string;
  readonly parentTaskId: string;
}

export interface TaskFormProps {
  readonly mode: "create" | "edit";
  readonly projects: readonly Project[];
  /** Только корневые задачи; форма дополнительно фильтрует по проекту. */
  readonly rootTasks: readonly Task[];
  readonly initial?: Partial<TaskFormValues>;
  /**
   * Controlled-значения формы. Если заданы, состояние хранится у вызывающей
   * стороны и переживает размонтирование формы (например, смену layout).
   * Без этого prop форма работает как раньше — с внутренним state.
   */
  readonly values?: TaskFormValues;
  readonly onValuesChange?: (values: TaskFormValues) => void;
  readonly excludeTaskId?: string | null;
  /**
   * Публичная команда `task.update` не меняет родителя. В режиме edit форма
   * показывает родителя только для чтения, чтобы не обещать недоступную
   * операцию; выбор родителя доступен при создании.
   */
  readonly lockParent?: boolean;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly onSubmit: (values: TaskFormValues) => void;
  readonly onCancel: () => void;
}

const inputClass =
  "h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

const labelClass = "flex flex-col gap-1 text-xs font-medium text-muted-foreground";

const textareaClass =
  "min-h-24 w-full rounded-md border bg-background px-2 py-1.5 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

/** Полные начальные значения формы; additive helper для controlled-режима. */
export function createTaskFormValues(
  projects: readonly Project[],
  initial?: Partial<TaskFormValues>,
): TaskFormValues {
  return {
    projectId: initial?.projectId ?? projects[0]?.id ?? "",
    title: initial?.title ?? "",
    descriptionMarkdown: initial?.descriptionMarkdown ?? "",
    status: initial?.status ?? "todo",
    priority: initial?.priority ?? "medium",
    dueAt: initial?.dueAt ?? "",
    tags: initial?.tags ?? "",
    parentTaskId: initial?.parentTaskId ?? "",
  };
}

/** Форма создания и редактирования задачи. */
export function TaskForm({
  mode,
  projects,
  rootTasks,
  initial,
  values: controlledValues,
  onValuesChange,
  excludeTaskId = null,
  lockParent = false,
  submitting = false,
  error = null,
  onSubmit,
  onCancel,
}: TaskFormProps) {
  const uid = useId();
  const [internalValues, setInternalValues] = useState<TaskFormValues>(() =>
    createTaskFormValues(projects, initial),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const values = controlledValues ?? internalValues;

  const parentOptions = rootTasks.filter(
    (task) => task.projectId === values.projectId && task.id !== excludeTaskId,
  );

  const update = (patch: Partial<TaskFormValues>): void => {
    const next = { ...values, ...patch };

    if (controlledValues === undefined) {
      setInternalValues(next);
    }

    onValuesChange?.(next);
  };

  const submit = (): void => {
    if (values.title.trim().length === 0) {
      setValidationError("Укажите название задачи");
      return;
    }

    if (values.projectId.length === 0) {
      setValidationError("Выберите проект");
      return;
    }

    setValidationError(null);
    onSubmit({
      ...values,
      title: values.title.trim(),
      tags: values.tags.trim(),
    });
  };

  const shownError = validationError ?? error;

  return (
    <form
      aria-label={mode === "create" ? "Создание задачи" : "Редактирование задачи"}
      data-testid={`task-form-${mode}`}
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelClass} htmlFor={`${uid}-project`}>
          Проект
          <select
            id={`${uid}-project`}
            name="projectId"
            value={values.projectId}
            disabled={submitting || mode === "edit"}
            onChange={(event) => {
              update({ projectId: event.target.value, parentTaskId: "" });
            }}
            className={inputClass}
            required
          >
            <option value="">Выберите проект</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass} htmlFor={`${uid}-title`}>
          Название
          <input
            id={`${uid}-title`}
            name="title"
            value={values.title}
            maxLength={200}
            required
            disabled={submitting}
            onChange={(event) => {
              update({ title: event.target.value });
            }}
            className={inputClass}
          />
        </label>

        <label className={labelClass} htmlFor={`${uid}-priority`}>
          Приоритет
          <select
            id={`${uid}-priority`}
            name="priority"
            value={values.priority}
            disabled={submitting}
            onChange={(event) => {
              update({ priority: event.target.value as TaskPriority });
            }}
            className={inputClass}
          >
            {taskPriorities().map((priority) => (
              <option key={priority} value={priority}>
                {TASK_PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>

        {mode === "create" ? (
          <label className={labelClass} htmlFor={`${uid}-status`}>
            Статус
            <select
              id={`${uid}-status`}
              name="status"
              value={values.status}
              disabled={submitting}
              onChange={(event) => {
                update({ status: event.target.value as TaskStatus });
              }}
              className={inputClass}
            >
              {taskStatuses().map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className={labelClass} htmlFor={`${uid}-due`}>
          Срок
          <input
            id={`${uid}-due`}
            name="dueAt"
            type="date"
            value={values.dueAt}
            disabled={submitting}
            onChange={(event) => {
              update({ dueAt: event.target.value });
            }}
            className={inputClass}
          />
        </label>

        <label className={labelClass} htmlFor={`${uid}-tags`}>
          Теги через запятую
          <input
            id={`${uid}-tags`}
            name="tags"
            value={values.tags}
            disabled={submitting}
            onChange={(event) => {
              update({ tags: event.target.value });
            }}
            className={inputClass}
            placeholder="release, backend"
          />
        </label>

        {lockParent ? (
          <div className={labelClass}>
            Родительская задача
            <p className="h-9 rounded-md border bg-muted/40 px-2 py-2 text-sm text-muted-foreground">
              {rootTasks.find((task) => task.id === values.parentTaskId)?.title ??
                "Без родителя (корневая)"}
            </p>
          </div>
        ) : (
          <label className={labelClass} htmlFor={`${uid}-parent`}>
            Родительская задача
            <select
              id={`${uid}-parent`}
              name="parentTaskId"
              value={values.parentTaskId}
              disabled={submitting}
              onChange={(event) => {
                update({ parentTaskId: event.target.value });
              }}
              className={inputClass}
            >
              <option value="">Без родителя (корневая)</option>
              {parentOptions.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <label className={labelClass} htmlFor={`${uid}-description`}>
        Описание (Markdown)
        <textarea
          id={`${uid}-description`}
          name="descriptionMarkdown"
          value={values.descriptionMarkdown}
          disabled={submitting}
          onChange={(event) => {
            update({ descriptionMarkdown: event.target.value });
          }}
          className={textareaClass}
        />
      </label>

      {shownError === null ? null : (
        <p role="alert" data-testid="task-form-error" className="text-sm text-destructive">
          {shownError}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {mode === "create" ? "Создать задачу" : "Сохранить задачу"}
        </button>
      </div>
    </form>
  );
}

export interface ProjectFormValues {
  readonly title: string;
  readonly descriptionMarkdown: string;
}

export interface ProjectFormProps {
  readonly submitting?: boolean;
  readonly error?: string | null;
  /** Controlled-значения; без prop используется внутреннее состояние. */
  readonly values?: ProjectFormValues;
  readonly onValuesChange?: (values: ProjectFormValues) => void;
  readonly onSubmit: (values: ProjectFormValues) => void;
  readonly onCancel: () => void;
}

/** Пустые значения формы проекта; additive helper для controlled-режима. */
export function createProjectFormValues(): ProjectFormValues {
  return { title: "", descriptionMarkdown: "" };
}

/** Форма создания проекта. */
export function ProjectForm({
  submitting = false,
  error = null,
  values: controlledValues,
  onValuesChange,
  onSubmit,
  onCancel,
}: ProjectFormProps) {
  const uid = useId();
  const [internalValues, setInternalValues] = useState<ProjectFormValues>(createProjectFormValues);
  const [validationError, setValidationError] = useState<string | null>(null);
  const values = controlledValues ?? internalValues;
  const shownError = validationError ?? error;

  const update = (patch: Partial<ProjectFormValues>): void => {
    const next = { ...values, ...patch };

    if (controlledValues === undefined) {
      setInternalValues(next);
    }

    onValuesChange?.(next);
  };

  return (
    <form
      aria-label="Создание проекта"
      data-testid="project-form"
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();

        if (values.title.trim().length === 0) {
          setValidationError("Укажите название проекта");
          return;
        }

        setValidationError(null);
        onSubmit({ title: values.title.trim(), descriptionMarkdown: values.descriptionMarkdown });
      }}
    >
      <label className={labelClass} htmlFor={`${uid}-project-title`}>
        Название проекта
        <input
          id={`${uid}-project-title`}
          name="title"
          value={values.title}
          maxLength={200}
          required
          disabled={submitting}
          onChange={(event) => {
            update({ title: event.target.value });
          }}
          className={inputClass}
        />
      </label>

      <label className={labelClass} htmlFor={`${uid}-project-description`}>
        Описание (Markdown)
        <textarea
          id={`${uid}-project-description`}
          name="descriptionMarkdown"
          value={values.descriptionMarkdown}
          disabled={submitting}
          onChange={(event) => {
            update({ descriptionMarkdown: event.target.value });
          }}
          className={textareaClass}
        />
      </label>

      {shownError === null ? null : (
        <p role="alert" data-testid="project-form-error" className="text-sm text-destructive">
          {shownError}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          Создать проект
        </button>
      </div>
    </form>
  );
}

/** Начальные значения формы редактирования из сохранённой задачи. */
export function taskToFormValues(task: Task): Partial<TaskFormValues> {
  return {
    projectId: task.projectId,
    title: task.title,
    descriptionMarkdown: task.descriptionMarkdown,
    status: task.status,
    priority: task.priority,
    dueAt: dueAtToDateInput(task.dueAt),
    tags: tagsToInput(task.tags),
    parentTaskId: task.parentTaskId ?? "",
  };
}
