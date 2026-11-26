"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type Task,
  type TaskColumn,
  type TaskCreateInput,
  type TaskListInput,
  type TaskListOutput,
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
import { defaultCreateColumnId } from "../ui/board-state.ts";
import { fetchProjectColumns } from "../ui/load-columns.ts";
import { invokeJson, errorMessage } from "../ui/operations.ts";
import { ProjectHeader } from "../ui/project-header.tsx";
import { TaskSearch } from "../ui/task-search.tsx";
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
  const text = query.q.trim();

  return {
    ...(query.projectId.length === 0 ? {} : { projectId: query.projectId }),
    ...(query.columnId.length === 0 ? {} : { columnId: query.columnId }),
    ...(query.legacyStatus.length === 0 ? {} : { status: query.legacyStatus as Task["status"] }),
    ...(query.priority.length === 0 ? {} : { priority: query.priority as Task["priority"] }),
    ...(query.tag.length === 0 ? {} : { tag: query.tag }),
    ...(text.length === 0 ? {} : { text }),
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
  const [columns, setColumns] = useState<readonly TaskColumn[]>([]);
  const [columnsProjectId, setColumnsProjectId] = useState("");
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [columnsErrorProjectId, setColumnsErrorProjectId] = useState("");

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
    query.columnId,
    query.legacyStatus,
    query.priority,
    query.tag,
    query.q,
    query.dueAfter,
    query.dueBefore,
    query.sortField,
    query.sortDirection,
    query.page,
  ]);

  useEffect(() => {
    if (query.projectId.length === 0) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const loaded = await fetchProjectColumns(invoke, query.projectId);

        if (!cancelled) {
          setColumns(loaded);
          setColumnsProjectId(query.projectId);
          setColumnsError(null);
          setColumnsErrorProjectId("");
        }
      } catch (error) {
        if (!cancelled) {
          setColumnsError(errorMessage(error));
          setColumnsErrorProjectId(query.projectId);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, query.projectId, query.revision]);

  const columnsLoading =
    query.projectId.length > 0 &&
    columnsProjectId !== query.projectId &&
    columnsErrorProjectId !== query.projectId;
  const columnsReady =
    query.projectId.length > 0 &&
    columnsProjectId === query.projectId &&
    columnsErrorProjectId !== query.projectId;
  const activeColumns = useMemo(() => (columnsReady ? columns : []), [columnsReady, columns]);

  // Фильтр колонки валидируется только после успешной загрузки списка именно
  // текущего проекта. Stale/пустой/ошибочный ответ фильтр не сбрасывает.
  useEffect(() => {
    if (
      columnsReady &&
      activeColumns.length > 0 &&
      query.columnId.length > 0 &&
      !activeColumns.some((column) => column.id === query.columnId)
    ) {
      updateTaskListQuery({ columnId: "", page: 1 });
    }
  }, [activeColumns, columnsReady, query.columnId]);

  const filterValues: TaskFilterValues = {
    projectId: query.projectId,
    status: query.legacyStatus,
    columnId: query.columnId,
    priority: query.priority,
    tag: query.tag,
    dueAfter: query.dueAfter,
    dueBefore: query.dueBefore,
  };

  const tasks = taskPage?.items ?? [];
  const total = taskPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / TASK_LIST_PAGE_SIZE));
  const legacyCreateStatus =
    query.legacyStatus === "backlog" ||
    query.legacyStatus === "todo" ||
    query.legacyStatus === "in_progress" ||
    query.legacyStatus === "done"
      ? query.legacyStatus
      : null;
  const legacyColumn =
    legacyCreateStatus === null
      ? null
      : (activeColumns.find((column) => column.status === legacyCreateStatus) ?? null);
  const legacyTitles: Record<NonNullable<typeof legacyCreateStatus>, string> = {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    done: "Done",
  };
  const createColumn =
    legacyCreateStatus === null
      ? (activeColumns.find((column) => column.id === defaultCreateColumnId(activeColumns)) ?? null)
      : legacyColumn;
  const createColumnTitle =
    legacyCreateStatus === null
      ? createColumn?.title
      : (legacyColumn?.title ?? legacyTitles[legacyCreateStatus]);

  const createTask = useCallback(
    async (title: string): Promise<TitleCreateResult> => {
      if (query.projectId.length === 0) {
        return { ok: false, message: "Выберите проект в списке проектов" };
      }

      const columnId = defaultCreateColumnId(activeColumns);

      if (columnId === null && query.legacyStatus.length === 0) {
        return {
          ok: false,
          message: "В проекте нет доступных колонок. Добавьте колонку на доске.",
        };
      }

      const input: TaskCreateInput = {
        projectId: query.projectId,
        ...(query.legacyStatus.length > 0
          ? { status: query.legacyStatus as Task["status"] }
          : { columnId: columnId as string }),
        title,
        descriptionMarkdown: "",
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
    [activeColumns, invoke, query.legacyStatus, query.projectId],
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
        onProjectUpdated={bumpTaskListRevision}
        onColumnsChanged={bumpTaskListRevision}
        actions={
          <>
            <button
              type="button"
              className={primaryButton}
              data-testid="create-task-button"
              disabled={
                query.projectId.length === 0 ||
                columnsLoading ||
                (activeColumns.length === 0 && legacyCreateStatus === null)
              }
              title={
                query.projectId.length === 0
                  ? "Сначала выберите проект в списке проектов"
                  : columnsLoading
                    ? "Колонки проекта загружаются"
                    : activeColumns.length === 0 && legacyCreateStatus === null
                      ? "В проекте нет доступных колонок"
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

      {legacyCreateStatus === null ? null : (
        <div
          data-testid="task-list-legacy-status"
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
        >
          <span>
            Legacy-фильтр статуса «{legacyCreateStatus}». Новые задачи создаются через публичный
            legacy status и материализуют колонку.
          </span>
          <button
            type="button"
            data-testid="task-list-legacy-status-reset"
            onClick={() => {
              updateTaskListQuery({ legacyStatus: "", columnId: "", page: 1 });
            }}
            className={secondaryButton}
          >
            Показать все колонки
          </button>
        </div>
      )}

      {composerOpen ? (
        <section data-testid="task-list-create-panel" aria-label="Новая задача">
          <TitleComposer
            status={createColumn?.status ?? legacyCreateStatus ?? "todo"}
            columnTitle={createColumnTitle}
            projectId={query.projectId}
            disabled={
              query.projectId.length === 0 ||
              (activeColumns.length === 0 && legacyCreateStatus === null)
            }
            onCreate={createTask}
            onCancel={() => {
              setComposerOpen(false);
            }}
            testIdPrefix="task-list-create"
            submitLabel="Создать задачу"
          />
        </section>
      ) : null}

      <section
        aria-label="Поиск задач"
        data-testid="task-search"
        className="rounded-lg border bg-card p-3"
      >
        <TaskSearch
          value={query.q}
          onChange={(q) => {
            updateTaskListQuery({ q, page: 1 });
          }}
          className="max-w-md"
        />
      </section>

      <TaskFilters
        projects={projects}
        columns={query.projectId.length === 0 ? [] : activeColumns}
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

      {columnsError === null ? null : (
        <ErrorState message={`Колонки: ${columnsError}`} onRetry={bumpTaskListRevision} />
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
          columns={query.projectId.length === 0 ? undefined : activeColumns}
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
        Колонки загружаются из проекта; фильтр колонки сохраняется в адресе. Все изменения
        выполняются публичными командами, а список перечитывается после каждой команды.
      </p>

      <span className="sr-only" data-testid="task-list-projects-loading">
        {projectsLoading ? "Проекты загружаются" : "Проекты загружены"}
      </span>
    </div>
  );
}
