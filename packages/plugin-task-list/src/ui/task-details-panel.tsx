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
  type TaskUpdateInput,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import {
  ErrorState,
  LoadingState,
  TaskDetails,
  TaskForm,
  dateInputToDueAt,
  parseTagsInput,
  taskToFormValues,
  type TaskFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { errorMessage, invokeJson, isVersionConflict } from "./operations.ts";
import { bumpTaskListRevision, updateTaskListQuery, useTaskListQuery } from "./query-state.ts";

export interface TaskDetailsPanelProps {
  readonly invoke: UiOperationInvoker;
  /** desktop — `app.details`, mobile — полноэкранный `app.overlays`. */
  readonly variant: "desktop" | "mobile";
}

/**
 * Панель деталей выбранной задачи.
 *
 * Детали не рендерятся без `task` в query string. Все изменения идут через
 * публичные команды; после команды выполняется повторный `task.get` и запрос
 * списка через общую ревизию.
 */
export function TaskDetailsPanel({ invoke, variant }: TaskDetailsPanelProps) {
  const query = useTaskListQuery();
  const taskId = query.taskId;
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const [rootTasks, setRootTasks] = useState<readonly Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Режим редактирования и предупреждение о конфликте привязаны к ID задачи:
  // при переходе к другой задаче они не переносятся без отдельного эффекта.
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const editing = editingTaskId !== null && editingTaskId === taskId;
  const [conflictState, setConflictState] = useState<{
    readonly taskId: string;
    readonly message: string;
  } | null>(null);
  const conflict =
    conflictState !== null && conflictState.taskId === taskId ? conflictState.message : null;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (taskId === null) {
      return;
    }

    let cancelled = false;

    // Эффект является точкой запуска запроса к внешнему API; сброс флага
    // загрузки перед запросом — часть этого сценария.
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
  }, [invoke, taskId, query.revision]);

  useEffect(() => {
    if (!editing || task === null) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
          projectId: task.projectId,
          parentTaskId: null,
          limit: 200,
          offset: 0,
          sort: { field: "title", direction: "asc" },
        } as unknown as JsonValue);

        if (!cancelled) {
          setRootTasks(data.items);
        }
      } catch {
        // Родитель в режиме edit только для чтения; ошибка не блокирует форму.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, editing, task, query.revision]);

  useEffect(() => {
    if (taskId === null || editing) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        updateTaskListQuery({ taskId: null });
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [taskId, editing]);

  const close = (): void => {
    updateTaskListQuery({ taskId: null });
  };

  const runCommand = async (command: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setConflictState(null);

    try {
      await command();
      bumpTaskListRevision();
    } catch (commandError) {
      if (isVersionConflict(commandError)) {
        // Устаревшую версию не отправляем повторно: выходим из формы,
        // перечитываем задачу и список и оставляем видимое объяснение.
        // Сообщение хранится отдельно от `error`, потому что повторное
        // чтение задачи очищает обычную ошибку.
        if (taskId !== null) {
          setConflictState({ taskId, message: errorMessage(commandError) });
        }

        setEditingTaskId(null);
        bumpTaskListRevision();
      } else {
        setError(errorMessage(commandError));
      }
    } finally {
      setBusy(false);
    }
  };

  const save = async (values: TaskFormValues): Promise<void> => {
    if (task === null) {
      return;
    }

    const input: TaskUpdateInput = {
      id: task.id,
      expectedVersion: task.version,
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
    if (task === null) {
      return;
    }

    const input: TaskCompleteInput = { id: task.id, expectedVersion: task.version };

    void runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskComplete, input as unknown as JsonValue);
    });
  };

  const move = (status: TaskStatus): void => {
    if (task === null) {
      return;
    }

    const input: TaskMoveInput = {
      id: task.id,
      expectedVersion: task.version,
      status,
      position: 0,
    };

    void runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskMove, input as unknown as JsonValue);
    });
  };

  const remove = (): void => {
    if (task === null) {
      return;
    }

    const input: TaskDeleteInput = {
      id: task.id,
      expectedVersion: task.version,
      confirm: true,
    };

    void runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskDelete, input as unknown as JsonValue);
      updateTaskListQuery({ taskId: null });
    });
  };

  if (taskId === null) {
    return null;
  }

  const content =
    loading && task === null ? (
      <LoadingState label="Загрузка деталей…" />
    ) : task === null ? (
      <ErrorState message={error ?? "Задача не найдена"} onRetry={bumpTaskListRevision} />
    ) : editing ? (
      <div className="flex flex-col gap-2">
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <TaskForm
          key={`edit-${task.id}-${String(task.version)}`}
          mode="edit"
          projects={project === null ? [] : [project]}
          rootTasks={rootTasks}
          initial={taskToFormValues(task)}
          excludeTaskId={task.id}
          lockParent
          submitting={busy}
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
        task={task}
        project={project}
        parentTask={parentTask}
        busy={busy}
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

  if (variant === "mobile") {
    return (
      <div
        data-testid="task-details-mobile"
        role="dialog"
        aria-modal="true"
        aria-label="Детали задачи"
        className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background p-4 xl:hidden"
      >
        {content}
      </div>
    );
  }

  return (
    <div data-testid="task-details-desktop" className="flex min-w-0 flex-col gap-2">
      {content}
    </div>
  );
}
