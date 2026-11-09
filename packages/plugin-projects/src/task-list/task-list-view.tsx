"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
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
  TaskFilters,
  TaskTable,
  dateInputToDueAt,
  type TaskFilterValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { TASK_LIST_ROUTE } from "../metadata.ts";
import { invokeJson } from "../ui/operations.ts";
import { ProjectHeader } from "../ui/project-header.tsx";
import { TitleComposer, type TitleCreateResult } from "../ui/title-composer.tsx";
import { useProjectSummary } from "../ui/use-project-summary.ts";
import { useProjectsData } from "../ui/use-projects.ts";
import { registerWorkspaceView, requestProjectCreate } from "../ui/workspace.ts";
import {
  TASK_LIST_PAGE_SIZE,
  bumpTaskListRevision,
  registerTaskListSearchWriter,
  resetTaskListFilters,
  serializeTaskListQuery,
  setTaskListSearch,
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
export function TaskListView({
  invoke,
  search,
  replaceSearch,
}: {
  readonly invoke: UiOperationInvoker;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
}) {
  const query = useTaskListQuery(search);
  const { projects, loading: projectsLoading, error: projectError } = useProjectsData(invoke);
  const [taskPage, setTaskPage] = useState<TaskListOutput | null>(null);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === query.projectId) ?? null,
    [projects, query.projectId],
  );
  const { summary } = useProjectSummary(invoke, query.projectId, query.revision);
  const workspaceSearch = useMemo(() => serializeTaskListQuery(query), [query]);

  useEffect(() => {
    if (replaceSearch === undefined) {
      return;
    }

    return registerTaskListSearchWriter(replaceSearch);
  }, [replaceSearch]);

  useEffect(
    () =>
      registerWorkspaceView({
        route: TASK_LIST_ROUTE,
        projectId: query.projectId,
        search: workspaceSearch,
        navigate: setTaskListSearch,
      }),
    [query.projectId, workspaceSearch],
  );

  useEffect(() => {
    let cancelled = false;

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

  const createTask = useCallback(
    async (title: string): Promise<TitleCreateResult> => {
      if (query.projectId.length === 0) {
        return { ok: false, message: "Выберите проект в списке проектов" };
      }

      const input: TaskCreateInput = {
        projectId: query.projectId,
        title,
        descriptionMarkdown: "",
        status: "todo",
        priority: "medium",
        dueAt: null,
        tags: [],
      };

      try {
        const data = await invokeJson<{ readonly task: Task }>(
          invoke,
          TASKS_COMMAND_IDS.taskCreate,
          input as unknown as JsonValue,
        );

        setComposerOpen(false);
        updateTaskListQuery({ taskId: data.task.id });
        bumpTaskListRevision();

        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Не удалось создать задачу",
        };
      }
    },
    [invoke, query.projectId],
  );

  return (
    <div data-testid="task-list-view" className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <ProjectHeader
        variant="list"
        route={TASK_LIST_ROUTE}
        project={selectedProject}
        summary={query.projectId.length === 0 ? null : summary}
        search={workspaceSearch}
        fallbackTitle="Задачи"
        invoke={invoke}
        onProjectRenamed={bumpTaskListRevision}
        actions={
          <>
            <button
              type="button"
              className={primaryButton}
              data-testid="create-task-button"
              disabled={query.projectId.length === 0}
              title={
                query.projectId.length === 0
                  ? "Сначала выберите проект в списке проектов"
                  : "Новая задача"
              }
              onClick={() => {
                setComposerOpen((current) => !current);
              }}
            >
              Новая задача
            </button>
            <button
              type="button"
              className={secondaryButton}
              data-testid="create-project-button"
              onClick={() => {
                requestProjectCreate();
              }}
            >
              Новый проект
            </button>
          </>
        }
      />

      {composerOpen ? (
        <section data-testid="task-list-create-panel" aria-label="Новая задача">
          <TitleComposer
            status="todo"
            projectId={query.projectId}
            disabled={query.projectId.length === 0}
            onCreate={createTask}
            onCancel={() => {
              setComposerOpen(false);
            }}
            testIdPrefix="task-list-create"
            submitLabel="Создать задачу"
          />
        </section>
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
        Статусы: backlog, todo, in_progress, done. Все изменения выполняются публичными командами, а
        список перечитывается после каждой команды.
      </p>

      <span className="sr-only" data-testid="task-list-projects-loading">
        {projectsLoading ? "Проекты загружаются" : "Проекты загружены"}
      </span>
    </div>
  );
}
