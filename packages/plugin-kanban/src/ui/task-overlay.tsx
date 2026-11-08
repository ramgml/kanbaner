"use client";

import { useEffect, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type Project,
  type ProjectGetOutput,
  type Task,
  type TaskCompleteInput,
  type TaskDeleteInput,
  type TaskGetOutput,
  type TaskListOutput,
  type TaskMoveInput,
  type TaskStatus,
  type TaskUpdateInput,
} from "@kanbaner/plugin-tasks/contract";
import {
  ErrorState,
  LoadingState,
  ModalDialog,
  TaskDetails,
  TaskForm,
  dateInputToDueAt,
  parseTagsInput,
  taskToFormValues,
  useMediaQuery,
  type TaskFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { KANBAN_ROUTE } from "../metadata.ts";
import {
  VERSION_CONFLICT_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "./operations.ts";
import {
  bumpKanbanRevision,
  registerKanbanSearchWriter,
  updateKanbanQuery,
  useKanbanQuery,
} from "./query-state.ts";

const DESKTOP_MEDIA_QUERY = "(min-width: 1280px)";

const MOBILE_DIALOG_CLASS =
  "m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-background p-4 backdrop:bg-black/40 xl:hidden";

export interface TaskOverlayProps {
  readonly invoke: UiOperationInvoker;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
}

/**
 * Overlay деталей и редактора выбранной карточки канбана.
 *
 * Рендерится только на `/view/kanban`, только при `task` в query string и
 * только пока локальное состояние открыто. Детали и форма берутся из
 * `@kanbaner/task-ui`, поэтому плагин не зависит от `kanbaner.task-list`.
 */
export function TaskOverlay({ invoke, pathname, search, replaceSearch }: TaskOverlayProps) {
  const query = useKanbanQuery(search);

  useEffect(() => {
    if (replaceSearch === undefined) {
      return;
    }

    return registerKanbanSearchWriter(replaceSearch);
  }, [replaceSearch]);
  const taskId = query.taskId;
  const onKanbanRoute = pathname === KANBAN_ROUTE;
  const isDesktopViewport = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const [rootTasks, setRootTasks] = useState<readonly Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // Данные от предыдущей задачи (A) не должны показываться или выполнять
  // команды, пока не загрузилась выбранная задача (B).
  const currentTask = task !== null && task.id === taskId ? task : null;
  const editing = editingTaskId !== null && editingTaskId === taskId && currentTask !== null;
  const [conflictState, setConflictState] = useState<{
    readonly taskId: string;
    readonly message: string;
  } | null>(null);
  const conflict =
    conflictState !== null && conflictState.taskId === taskId ? conflictState.message : null;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (taskId === null || !onKanbanRoute) {
      return;
    }

    let cancelled = false;

    // Эффект — точка запуска запроса к внешнему API; сброс флага перед
    // запросом является частью этого сценария.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    void (async () => {
      try {
        const taskOutput = await invokeJson<TaskGetOutput>(invoke, TASKS_QUERY_IDS.taskGet, {
          id: taskId,
        });
        const projectOutput = await invokeJson<ProjectGetOutput>(
          invoke,
          TASKS_QUERY_IDS.projectGet,
          { id: taskOutput.task.projectId },
        );
        const parentOutput =
          taskOutput.task.parentTaskId === null
            ? null
            : await invokeJson<TaskGetOutput>(invoke, TASKS_QUERY_IDS.taskGet, {
                id: taskOutput.task.parentTaskId,
              });

        if (!cancelled) {
          setTask(taskOutput.task);
          setProject(projectOutput.project);
          setParentTask(parentOutput?.task ?? null);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setTask(null);
          setError(errorMessage(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, taskId, query.revision, onKanbanRoute]);

  useEffect(() => {
    if (!editing || currentTask === null || !onKanbanRoute) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
          projectId: currentTask.projectId,
          parentTaskId: null,
          limit: 200,
          offset: 0,
          sort: { field: "title", direction: "asc" },
        } as unknown as JsonValue);

        if (!cancelled) {
          setRootTasks(data.items);
        }
      } catch {
        // Список родителей необязателен: форма работает и без него.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, editing, currentTask, query.revision, onKanbanRoute]);

  useEffect(() => {
    if (!onKanbanRoute || taskId === null || editing || !isDesktopViewport) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        updateKanbanQuery({ taskId: null });
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onKanbanRoute, taskId, editing, isDesktopViewport]);

  if (taskId === null || !onKanbanRoute) {
    return null;
  }

  const close = (): void => {
    updateKanbanQuery({ taskId: null });
  };

  const runCommand = async (command: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setConflictState(null);

    try {
      await command();
      bumpKanbanRevision();
    } catch (commandError) {
      if (isVersionConflict(commandError)) {
        if (taskId !== null) {
          setConflictState({ taskId, message: VERSION_CONFLICT_MESSAGE });
        }

        setEditingTaskId(null);
        bumpKanbanRevision();
      } else {
        setError(errorMessage(commandError));
      }
    } finally {
      setBusy(false);
    }
  };

  const save = async (values: TaskFormValues): Promise<void> => {
    if (currentTask === null) {
      return;
    }

    const input: TaskUpdateInput = {
      id: currentTask.id,
      expectedVersion: currentTask.version,
      title: values.title,
      descriptionMarkdown: values.descriptionMarkdown,
      priority: values.priority,
      dueAt: dateInputToDueAt(values.dueAt, "start"),
      tags: parseTagsInput(values.tags),
    };

    await runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskUpdate, input as unknown as JsonValue);
      setEditingTaskId(null);
    });
  };

  const complete = (): void => {
    if (currentTask === null) {
      return;
    }

    const input: TaskCompleteInput = {
      id: currentTask.id,
      expectedVersion: currentTask.version,
    };

    void runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskComplete, input as unknown as JsonValue);
    });
  };

  const move = (status: TaskStatus): void => {
    if (currentTask === null) {
      return;
    }

    const input: TaskMoveInput = {
      id: currentTask.id,
      expectedVersion: currentTask.version,
      status,
      position: 0,
    };

    void runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskMove, input as unknown as JsonValue);
    });
  };

  const remove = (): void => {
    if (currentTask === null) {
      return;
    }

    const input: TaskDeleteInput = {
      id: currentTask.id,
      expectedVersion: currentTask.version,
      confirm: true,
    };

    void runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskDelete, input as unknown as JsonValue);
      updateKanbanQuery({ taskId: null });
    });
  };

  const content =
    loading && currentTask === null ? (
      <LoadingState label="Загрузка деталей…" />
    ) : currentTask === null ? (
      <ErrorState message={error ?? "Задача не найдена"} onRetry={bumpKanbanRevision} />
    ) : editing ? (
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {error === null ? null : (
          <p role="alert" style={{ margin: 0, fontSize: "13px", color: "var(--destructive)" }}>
            {error}
          </p>
        )}
        <TaskForm
          key={`edit-${currentTask.id}-${String(currentTask.version)}`}
          mode="edit"
          projects={project === null ? [] : [project]}
          rootTasks={rootTasks}
          initial={taskToFormValues(currentTask)}
          excludeTaskId={currentTask.id}
          lockParent
          submitting={busy || loading}
          error={error}
          onSubmit={(values) => {
            void save(values);
          }}
          onCancel={() => {
            setEditingTaskId(null);
            setError(null);
          }}
        />
      </div>
    ) : (
      <TaskDetails
        task={currentTask}
        project={project}
        parentTask={parentTask}
        busy={busy || loading}
        error={error ?? conflict}
        onClose={close}
        onEdit={() => {
          setError(null);
          setConflictState(null);

          if (taskId !== null) {
            setEditingTaskId(taskId);
          }
        }}
        onComplete={complete}
        onMove={move}
        onDelete={remove}
      />
    );

  if (!isDesktopViewport) {
    return (
      <ModalDialog
        open
        label="Детали задачи"
        testId="kanban-details"
        onClose={close}
        restoreFocusSelector={`[data-testid="kanban-open-${taskId}"]`}
        className={MOBILE_DIALOG_CLASS}
      >
        {content}
      </ModalDialog>
    );
  }

  return (
    <div
      data-testid="kanban-details"
      data-variant="desktop"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        maxHeight: "70vh",
        overflowY: "auto",
        border: "1px solid var(--border)",
        background: "var(--card)",
        color: "var(--card-foreground)",
        borderRadius: "12px",
        padding: "12px",
        boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
      }}
    >
      {content}
    </div>
  );
}
