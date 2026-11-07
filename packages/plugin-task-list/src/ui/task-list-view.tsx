"use client";

import { useEffect, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type Project,
  type ProjectListOutput,
  type Task,
  type TaskCreateInput,
  type TaskListInput,
  type TaskListOutput,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ProjectForm,
  TaskFilters,
  TaskForm,
  TaskTable,
  dateInputToDueAt,
  parseTagsInput,
  taskStatuses,
  type ProjectFormValues,
  type TaskFilterValues,
  type TaskFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { invokeJson } from "./operations.ts";
import {
  TASK_LIST_PAGE_SIZE,
  bumpTaskListRevision,
  resetTaskListFilters,
  updateTaskListQuery,
  useTaskListQuery,
  type TaskListSortField,
} from "./query-state.ts";

const SORT_OPTIONS: ReadonlyArray<{ readonly value: TaskListSortField; readonly label: string }> = [
  { value: "position", label: "Позиция" },
  { value: "dueAt", label: "Срок" },
  { value: "updatedAt", label: "Дата изменения" },
  { value: "title", label: "Название" },
];

const primaryButton =
  "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

const secondaryButton =
  "rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

function buildTaskListInput(query: ReturnType<typeof useTaskListQuery>): TaskListInput {
  const dueAfter = dateInputToDueAt(query.dueAfter, "start");
  const dueBefore = dateInputToDueAt(query.dueBefore, "end");

  return {
    ...(query.projectId.length === 0 ? {} : { projectId: query.projectId }),
    ...(query.status.length === 0 ? {} : { status: query.status as TaskStatus }),
    ...(query.priority.length === 0 ? {} : { priority: query.priority as Task["priority"] }),
    ...(query.tag.length === 0 ? {} : { tag: query.tag }),
    ...(dueAfter === null ? {} : { dueAfter }),
    ...(dueBefore === null ? {} : { dueBefore }),
    sort: { field: query.sortField, direction: query.sortDirection },
    limit: TASK_LIST_PAGE_SIZE,
    offset: (query.page - 1) * TASK_LIST_PAGE_SIZE,
  };
}

/** Основное представление `/view/tasks`. */
export function TaskListView({ invoke }: { readonly invoke: UiOperationInvoker }) {
  const query = useTaskListQuery();
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [taskPage, setTaskPage] = useState<TaskListOutput | null>(null);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<"project" | "task" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rootTasks, setRootTasks] = useState<readonly Task[]>([]);

  useEffect(() => {
    let cancelled = false;

    // Загрузка запускается из эффекта синхронизации с внешним API; сброс
    // флага перед запросом — часть этого сценария.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjectsLoading(true);

    void (async () => {
      try {
        const data = await invokeJson<ProjectListOutput>(invoke, TASKS_QUERY_IDS.projectList, {
          limit: 200,
          offset: 0,
        });

        if (!cancelled) {
          setProjects(data.items);
          setProjectError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setProjectError(error instanceof Error ? error.message : "Не удалось загрузить проекты");
        }
      } finally {
        if (!cancelled) {
          setProjectsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, query.revision]);

  useEffect(() => {
    let cancelled = false;

    // См. комментарий выше: эффект является точкой запуска запроса.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTasksLoading(true);

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(
          invoke,
          TASKS_QUERY_IDS.taskList,
          buildTaskListInput(query) as unknown as JsonValue,
        );

        if (!cancelled) {
          setTaskPage(data);
          setTaskError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setTaskError(error instanceof Error ? error.message : "Не удалось загрузить задачи");
        }
      } finally {
        if (!cancelled) {
          setTasksLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Поля query перечислены по отдельности: выбор задачи (query.taskId)
    // не должен перезапрашивать список.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    invoke,
    query.revision,
    query.projectId,
    query.status,
    query.priority,
    query.tag,
    query.dueAfter,
    query.dueBefore,
    query.sortField,
    query.sortDirection,
    query.page,
  ]);

  useEffect(() => {
    if (formMode !== "task") {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
          parentTaskId: null,
          limit: 200,
          offset: 0,
          sort: { field: "title", direction: "asc" },
        });

        if (!cancelled) {
          setRootTasks(data.items);
        }
      } catch {
        // Список родителей необязателен: задачу можно создать корневой.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, formMode, query.revision]);

  const filterValues: TaskFilterValues = {
    projectId: query.projectId,
    status: query.status,
    priority: query.priority,
    tag: query.tag,
    dueAfter: query.dueAfter,
    dueBefore: query.dueBefore,
  };

  const tasks = taskPage?.items ?? [];
  const total = taskPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / TASK_LIST_PAGE_SIZE));

  const createProject = async (values: ProjectFormValues): Promise<void> => {
    setSubmitting(true);
    setFormError(null);

    try {
      await invokeJson(invoke, TASKS_COMMAND_IDS.projectCreate, {
        title: values.title,
        descriptionMarkdown: values.descriptionMarkdown,
      });
      setFormMode(null);
      bumpTaskListRevision();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Не удалось создать проект");
    } finally {
      setSubmitting(false);
    }
  };

  const createTask = async (values: TaskFormValues): Promise<void> => {
    setSubmitting(true);
    setFormError(null);

    const dueAt = dateInputToDueAt(values.dueAt, "start");
    const input: TaskCreateInput = {
      projectId: values.projectId,
      title: values.title,
      descriptionMarkdown: values.descriptionMarkdown,
      status: values.status,
      priority: values.priority,
      dueAt,
      tags: parseTagsInput(values.tags),
      ...(values.parentTaskId.length === 0 ? {} : { parentTaskId: values.parentTaskId }),
    };

    try {
      const data = await invokeJson<{ readonly task: Task }>(
        invoke,
        TASKS_COMMAND_IDS.taskCreate,
        input as unknown as JsonValue,
      );

      setFormMode(null);
      updateTaskListQuery({ taskId: data.task.id });
      bumpTaskListRevision();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Не удалось создать задачу");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="task-list-view" className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Задачи</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Список работает только через публичные команды и запросы домена задач. Фильтры,
            сортировка, страница и выбранная задача сохраняются в адресе.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={secondaryButton}
            data-testid="create-project-button"
            onClick={() => {
              setFormError(null);
              setFormMode(formMode === "project" ? null : "project");
            }}
          >
            Новый проект
          </button>
          <button
            type="button"
            className={primaryButton}
            data-testid="create-task-button"
            disabled={projects.length === 0}
            onClick={() => {
              setFormError(null);
              setFormMode(formMode === "task" ? null : "task");
            }}
          >
            Новая задача
          </button>
        </div>
      </header>

      {formMode === "project" ? (
        <ProjectForm
          submitting={submitting}
          error={formError}
          onSubmit={(values) => {
            void createProject(values);
          }}
          onCancel={() => {
            setFormMode(null);
            setFormError(null);
          }}
        />
      ) : null}

      {formMode === "task" ? (
        <TaskForm
          mode="create"
          projects={projects}
          rootTasks={rootTasks}
          submitting={submitting}
          error={formError}
          onSubmit={(values) => {
            void createTask(values);
          }}
          onCancel={() => {
            setFormMode(null);
            setFormError(null);
          }}
        />
      ) : null}

      <TaskFilters
        projects={projects}
        values={filterValues}
        onChange={(patch) => {
          updateTaskListQuery({ ...patch, page: 1 });
        }}
        onReset={resetTaskListFilters}
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Сортировка
          <select
            value={query.sortField}
            onChange={(event) => {
              updateTaskListQuery({ sortField: event.target.value as TaskListSortField, page: 1 });
            }}
            className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={secondaryButton}
          aria-label={
            query.sortDirection === "asc"
              ? "Направление: по возрастанию"
              : "Направление: по убыванию"
          }
          onClick={() => {
            updateTaskListQuery({
              sortDirection: query.sortDirection === "asc" ? "desc" : "asc",
              page: 1,
            });
          }}
        >
          {query.sortDirection === "asc" ? "По возрастанию" : "По убыванию"}
        </button>
      </div>

      {projectError === null ? null : (
        <ErrorState message={`Проекты: ${projectError}`} onRetry={bumpTaskListRevision} />
      )}

      {taskError === null ? null : (
        <ErrorState message={taskError} onRetry={bumpTaskListRevision} />
      )}

      {tasksLoading && taskPage === null ? <LoadingState label="Загрузка задач…" /> : null}

      {!tasksLoading && taskError === null && tasks.length === 0 ? (
        <EmptyState
          title="Задач пока нет"
          description={
            projects.length === 0
              ? "Сначала создайте проект, затем добавьте первую задачу."
              : "Измените фильтры или создайте новую задачу."
          }
        />
      ) : null}

      {tasks.length === 0 ? null : (
        <TaskTable
          tasks={tasks}
          projects={projects}
          selectedTaskId={query.taskId}
          onSelect={(task) => {
            updateTaskListQuery({ taskId: task.id });
          }}
        />
      )}

      {tasksLoading && taskPage !== null ? (
        <p role="status" className="text-xs text-muted-foreground">
          Обновление списка…
        </p>
      ) : null}

      <nav
        aria-label="Пагинация задач"
        data-testid="task-pagination"
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <button
          type="button"
          className={secondaryButton}
          disabled={query.page <= 1 || tasksLoading}
          onClick={() => {
            updateTaskListQuery({ page: Math.max(1, query.page - 1) });
          }}
        >
          Назад
        </button>
        <p className="text-xs text-muted-foreground">
          Страница {query.page} из {totalPages} · Всего задач: {total}
        </p>
        <button
          type="button"
          className={secondaryButton}
          disabled={query.page >= totalPages || tasksLoading}
          onClick={() => {
            updateTaskListQuery({ page: Math.min(totalPages, query.page + 1) });
          }}
        >
          Вперёд
        </button>
      </nav>

      <p className="text-xs text-muted-foreground">
        Статусы:{" "}
        {taskStatuses()
          .map((status) => status)
          .join(", ")}
        . Все изменения выполняются публичными командами, а список перечитывается после каждой
        команды.
      </p>

      <span className="sr-only" data-testid="task-list-projects-loading">
        {projectsLoading ? "Проекты загружаются" : "Проекты загружены"}
      </span>
    </div>
  );
}
