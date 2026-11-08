"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type Project,
  type ProjectGetOutput,
  type Task,
  type TaskCompleteInput,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskGetOutput,
  type TaskListOutput,
  type TaskMoveInput,
  type TaskMutationOutput,
  type TaskPriority,
  type TaskStatus,
  type TaskUpdateInput,
} from "@kanbaner/plugin-tasks/contract";
import {
  ErrorState,
  LoadingState,
  ModalDialog,
  createTaskFormValues,
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
import { TaskModal, type SubtaskDraft } from "./task-modal.tsx";

const DESKTOP_MEDIA_QUERY = "(min-width: 1280px)";

/** Контракт задачи ограничивает `limit` значением 200. */
const MAX_LIST_LIMIT = 200;

const MOBILE_DIALOG_CLASS =
  "m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-background p-0 backdrop:bg-black/40";

interface SubtasksState {
  readonly taskId: string | null;
  readonly items: readonly Task[];
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SUBTASKS: SubtasksState = Object.freeze({
  taskId: null,
  items: [],
  loading: false,
  error: null,
});

function sameValues(left: TaskFormValues | null, right: TaskFormValues | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return (
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.descriptionMarkdown === right.descriptionMarkdown &&
    left.status === right.status &&
    left.priority === right.priority &&
    left.dueAt === right.dueAt &&
    left.tags === right.tags &&
    left.parentTaskId === right.parentTaskId
  );
}

export interface TaskOverlayProps {
  readonly invoke: UiOperationInvoker;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
}

/**
 * Overlay выбранной карточки канбана в стиле Trello.
 *
 * На desktop — центрированный modal поверх доски: слева описание и подзадачи,
 * справа действия. На mobile — полноэкранный нативный `ModalDialog` с focus
 * trap, Escape и возвратом фокуса. Детали и формы берутся из `@kanbaner/task-ui`,
 * поэтому плагин не зависит от внутренностей `kanbaner.task-list`.
 *
 * Все команды выполняются только над `currentTask`, у которого
 * `task.id === taskId`: при переходе A → B устаревшая задача не показывается и
 * не принимает действий.
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
  const [subtasks, setSubtasks] = useState<SubtasksState>(EMPTY_SUBTASKS);
  const [rootTasks, setRootTasks] = useState<readonly Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<TaskFormValues | null>(null);
  const [editInitial, setEditInitial] = useState<TaskFormValues | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [conflictState, setConflictState] = useState<{
    readonly taskId: string;
    readonly message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Данные от предыдущей задачи (A) не должны показываться или выполнять
  // команды, пока не загрузилась выбранная задача (B).
  const currentTask = task !== null && task.id === taskId ? task : null;
  const editing =
    editingTaskId !== null &&
    editingTaskId === taskId &&
    currentTask !== null &&
    editValues !== null;
  const dirty = editing && !sameValues(editValues, editInitial);
  const conflict =
    conflictState !== null && conflictState.taskId === taskId ? conflictState.message : null;
  const visibleSubtasks =
    currentTask !== null && subtasks.taskId === currentTask.id ? subtasks : EMPTY_SUBTASKS;

  useEffect(() => {
    if (taskId === null || !onKanbanRoute) {
      return;
    }

    let cancelled = false;

    // Эффект — точка запуска запроса к внешнему API; сброс флага перед
    // запросом является частью этого сценария.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setSubtasks((current) =>
      current.taskId === taskId
        ? { ...current, loading: true }
        : { ...EMPTY_SUBTASKS, loading: true },
    );

    void (async () => {
      try {
        const taskOutput = await invokeJson<TaskGetOutput>(invoke, TASKS_QUERY_IDS.taskGet, {
          id: taskId,
        });
        const loadedTask = taskOutput.task;
        const [projectOutput, parentOutput] = await Promise.all([
          invokeJson<ProjectGetOutput>(invoke, TASKS_QUERY_IDS.projectGet, {
            id: loadedTask.projectId,
          }),
          loadedTask.parentTaskId === null
            ? Promise.resolve(null)
            : invokeJson<TaskGetOutput>(invoke, TASKS_QUERY_IDS.taskGet, {
                id: loadedTask.parentTaskId,
              }),
        ]);

        let subtaskItems: readonly Task[] = [];
        let subtaskError: string | null = null;

        if (loadedTask.parentTaskId === null) {
          try {
            const subtaskOutput = await invokeJson<TaskListOutput>(
              invoke,
              TASKS_QUERY_IDS.taskList,
              {
                parentTaskId: loadedTask.id,
                limit: MAX_LIST_LIMIT,
                offset: 0,
                sort: { field: "position", direction: "asc" },
              } as unknown as JsonValue,
            );

            subtaskItems = subtaskOutput.items;
          } catch (subtaskLoadError) {
            // Ошибка списка подзадач не должна скрывать саму карточку.
            subtaskError = errorMessage(subtaskLoadError);
          }
        }

        if (!cancelled) {
          setTask(loadedTask);
          setProject(projectOutput.project);
          setParentTask(parentOutput?.task ?? null);
          setSubtasks({
            taskId: loadedTask.id,
            items: subtaskItems,
            loading: false,
            error: subtaskError,
          });
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setTask(null);
          setSubtasks(EMPTY_SUBTASKS);
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

  // Смена выбранной карточки всегда начинает новую сессию: черновик и
  // подтверждение закрытия от предыдущей задачи не переносятся.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditingTaskId(null);
    setEditValues(null);
    setEditInitial(null);
    setCloseConfirm(false);
  }, [taskId]);

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
          limit: MAX_LIST_LIMIT,
          offset: 0,
          sort: { field: "title", direction: "asc" },
        } as unknown as JsonValue);

        if (!cancelled) {
          setRootTasks(data.items);
        }
      } catch {
        // Список родителей необязателен: форма работает и без него.
        if (!cancelled) {
          setRootTasks([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, editing, currentTask, query.revision, onKanbanRoute]);

  const closeNow = useCallback((): void => {
    setCloseConfirm(false);
    setEditingTaskId(null);
    setEditValues(null);
    setEditInitial(null);
    setError(null);
    setConflictState(null);
    updateKanbanQuery({ taskId: null });
  }, []);

  const requestClose = useCallback((): void => {
    if (dirty) {
      setCloseConfirm(true);
      return;
    }

    closeNow();
  }, [dirty, closeNow]);

  useEffect(() => {
    if (!onKanbanRoute || taskId === null || !isDesktopViewport) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onKanbanRoute, taskId, isDesktopViewport, requestClose]);

  if (taskId === null || !onKanbanRoute) {
    return null;
  }

  const runCommand = async (command: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current) {
      return false;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    setConflictState(null);

    try {
      await command();
      bumpKanbanRevision();

      return true;
    } catch (commandError) {
      if (isVersionConflict(commandError)) {
        if (taskId !== null) {
          setConflictState({ taskId, message: VERSION_CONFLICT_MESSAGE });
        }

        setEditingTaskId(null);
        setEditValues(null);
        setEditInitial(null);
        bumpKanbanRevision();
      } else {
        setError(errorMessage(commandError));
      }

      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const startEdit = (): void => {
    if (currentTask === null) {
      return;
    }

    const initial = createTaskFormValues(
      project === null ? [] : [project],
      taskToFormValues(currentTask),
    );

    setError(null);
    setConflictState(null);
    setCloseConfirm(false);
    setEditInitial(initial);
    setEditValues(initial);
    setEditingTaskId(currentTask.id);
  };

  const cancelEdit = (): void => {
    setEditingTaskId(null);
    setEditValues(null);
    setEditInitial(null);
    setCloseConfirm(false);
    setError(null);
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

    const saved = await runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskUpdate, input as unknown as JsonValue);
      setEditingTaskId(null);
      setEditValues(null);
      setEditInitial(null);
    });

    if (saved) {
      setCloseConfirm(false);
    }
  };

  const updateTask = async (patch: Partial<TaskUpdateInput>): Promise<void> => {
    if (currentTask === null) {
      return;
    }

    const input: TaskUpdateInput = {
      id: currentTask.id,
      expectedVersion: currentTask.version,
      ...patch,
    };

    await runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskUpdate, input as unknown as JsonValue);
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

  const changePriority = (priority: TaskPriority): void => {
    void updateTask({ priority });
  };

  const changeDue = (value: string): void => {
    void updateTask({ dueAt: dateInputToDueAt(value, "start") });
  };

  const changeTags = (value: string): void => {
    void updateTask({ tags: parseTagsInput(value) });
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
      closeNow();
    });
  };

  const openTask = (nextTaskId: string): void => {
    setCloseConfirm(false);
    setEditingTaskId(null);
    setEditValues(null);
    setEditInitial(null);
    updateKanbanQuery({ taskId: nextTaskId });
  };

  const createSubtask = async (draft: SubtaskDraft): Promise<boolean> => {
    if (currentTask === null || currentTask.parentTaskId !== null || busyRef.current) {
      return false;
    }

    const title = draft.title.trim();

    if (title.length === 0) {
      return false;
    }

    const input: TaskCreateInput = {
      projectId: currentTask.projectId,
      parentTaskId: currentTask.id,
      title,
      descriptionMarkdown: "",
      status: draft.status,
      priority: "medium",
      dueAt: null,
      tags: [],
    };

    busyRef.current = true;
    setBusy(true);
    setError(null);
    setConflictState(null);

    try {
      await invokeJson<TaskMutationOutput>(
        invoke,
        TASKS_COMMAND_IDS.taskCreate,
        input as unknown as JsonValue,
      );
      bumpKanbanRevision();

      return true;
    } catch (commandError) {
      setError(errorMessage(commandError));

      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const body =
    loading && currentTask === null ? (
      <div className="p-4">
        <LoadingState label="Загрузка деталей…" />
      </div>
    ) : currentTask === null ? (
      <div className="p-4">
        <ErrorState message={error ?? "Задача не найдена"} onRetry={bumpKanbanRevision} />
      </div>
    ) : (
      <TaskModal
        key={`${currentTask.id}-${String(currentTask.version)}`}
        variant={isDesktopViewport ? "desktop" : "mobile"}
        task={currentTask}
        project={project}
        parentTask={parentTask}
        subtasks={visibleSubtasks.items}
        subtasksLoading={visibleSubtasks.loading}
        subtasksError={visibleSubtasks.error}
        busy={busy || loading}
        error={error ?? conflict}
        editing={editing}
        editValues={editValues}
        editRootTasks={rootTasks}
        closeConfirm={closeConfirm}
        onChangeEditValues={setEditValues}
        onStartEdit={startEdit}
        onCancelEdit={cancelEdit}
        onSubmitEdit={(values) => {
          void save(values);
        }}
        onClose={requestClose}
        onOpenTask={openTask}
        onCreateSubtask={createSubtask}
        onComplete={complete}
        onMove={move}
        onPriority={changePriority}
        onDue={changeDue}
        onTags={changeTags}
        onDelete={remove}
        onDiscardDraft={closeNow}
        onKeepEditing={() => {
          setCloseConfirm(false);
        }}
      />
    );

  if (!isDesktopViewport) {
    return (
      <ModalDialog
        open
        label="Детали задачи"
        testId="kanban-details"
        onClose={requestClose}
        restoreFocusSelector={`[data-testid="kanban-open-${taskId}"]`}
        className={MOBILE_DIALOG_CLASS}
      >
        {body}
      </ModalDialog>
    );
  }

  return (
    <div
      data-testid="kanban-details-backdrop"
      className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div
        data-testid="kanban-details"
        data-variant="desktop"
        role="dialog"
        aria-modal="true"
        aria-label="Детали задачи"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[860px] min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl"
      >
        {body}
      </div>
    </div>
  );
}
