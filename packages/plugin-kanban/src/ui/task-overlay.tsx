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
  dueAtToDateInput,
  parseTagsInput,
  tagsToInput,
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
import { TaskModal, type SubtaskDraft, type SubtaskFormDraft } from "./task-modal.tsx";

const DESKTOP_MEDIA_QUERY = "(min-width: 1280px)";

/** Контракт задачи ограничивает `limit` значением 200. */
const MAX_LIST_LIMIT = 200;

const MOBILE_DIALOG_CLASS =
  "m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-background p-0 backdrop:bg-black/40";

const DESKTOP_DIALOG_CLASS =
  "m-auto w-[calc(100vw-2rem)] max-w-[860px] max-h-[calc(100dvh-2rem)] overflow-hidden rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/45";

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

/** Серверные значения, от которых отсчитывается черновик быстрых действий. */
interface QuickBaseline {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly dueAt: string | null;
  readonly tagsKey: string;
}

/** Несохранённые значения быстрых действий, живущие вне breakpoint-модала. */
interface QuickDraft {
  readonly taskId: string;
  readonly nextStatus: TaskStatus;
  readonly dueValue: string;
  readonly tagsValue: string;
  readonly subtaskOpen: boolean;
  readonly subtaskTitle: string;
  readonly subtaskStatus: TaskStatus;
}

/** Сессия редактирования: версия фиксируется в момент открытия формы. */
interface EditSession {
  readonly taskId: string;
  readonly expectedVersion: number;
}

function baselineOf(task: Task): QuickBaseline {
  return {
    taskId: task.id,
    status: task.status,
    dueAt: task.dueAt,
    tagsKey: tagsToInput(task.tags),
  };
}

function createQuickDraft(task: Task): QuickDraft {
  return {
    taskId: task.id,
    nextStatus: task.status,
    dueValue: dueAtToDateInput(task.dueAt),
    tagsValue: tagsToInput(task.tags),
    subtaskOpen: false,
    subtaskTitle: "",
    subtaskStatus: "todo",
  };
}

/**
 * Переносит черновик на новую серверную версию без молчаливой потери
 * несохранённых полей.
 *
 * Поле синхронизируется только если изменилось его серверное значение
 * относительно baseline. Поэтому успешная команда по приоритету не стирает
 * введённый, но ещё не сохранённый срок или теги.
 */
function syncQuickDraft(
  current: QuickDraft | null,
  task: Task,
  baseline: QuickBaseline | null,
): QuickDraft {
  if (current === null || current.taskId !== task.id || baseline?.taskId !== task.id) {
    return createQuickDraft(task);
  }

  const next: {
    taskId: string;
    nextStatus: TaskStatus;
    dueValue: string;
    tagsValue: string;
    subtaskOpen: boolean;
    subtaskTitle: string;
    subtaskStatus: TaskStatus;
  } = { ...current };

  if (baseline.status !== task.status) {
    next.nextStatus = task.status;
  }

  if (baseline.dueAt !== task.dueAt) {
    next.dueValue = dueAtToDateInput(task.dueAt);
  }

  if (baseline.tagsKey !== tagsToInput(task.tags)) {
    next.tagsValue = tagsToInput(task.tags);
  }

  return next;
}

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

/**
 * Читает все подзадачи задачи.
 *
 * `task.list` ограничивает `limit` значением 200, поэтому после первой
 * страницы запрос продолжается по `nextOffset`, пока сервер не сообщит конец.
 * Созданная append-подзадача поэтому видна и после границы страницы.
 */
async function fetchSubtasks(invoke: UiOperationInvoker, taskId: string): Promise<readonly Task[]> {
  const items: Task[] = [];
  let offset = 0;

  for (;;) {
    const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
      parentTaskId: taskId,
      limit: MAX_LIST_LIMIT,
      offset,
      sort: { field: "position", direction: "asc" },
    } as unknown as JsonValue);

    items.push(...data.items);

    if (data.nextOffset === null || data.items.length === 0 || data.nextOffset <= offset) {
      break;
    }

    offset = data.nextOffset;
  }

  return items;
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
 * Desktop и mobile используют общий `ModalDialog`: native `<dialog>` даёт
 * inert-фон, focus trap и возврат фокуса. Desktop-вариант центрируется и
 * ограничен 860 px. Все команды выполняются только над `currentTask`, у
 * которого `task.id === taskId`.
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
  const [editSession, setEditSession] = useState<EditSession | null>(null);
  const [editValues, setEditValues] = useState<TaskFormValues | null>(null);
  const [editInitial, setEditInitial] = useState<TaskFormValues | null>(null);
  const [quickDraft, setQuickDraft] = useState<QuickDraft | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [conflictState, setConflictState] = useState<{
    readonly taskId: string;
    readonly message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const quickBaselineRef = useRef<QuickBaseline | null>(null);

  // Данные от предыдущей задачи (A) не должны показываться или выполнять
  // команды, пока не загрузилась выбранная задача (B).
  const currentTask = task !== null && task.id === taskId ? task : null;
  const editing =
    editingTaskId !== null &&
    editingTaskId === taskId &&
    currentTask !== null &&
    editValues !== null;
  const editDirty = editing && !sameValues(editValues, editInitial);
  const editOutdated =
    editing &&
    currentTask !== null &&
    editSession !== null &&
    editSession.taskId === currentTask.id &&
    editSession.expectedVersion !== currentTask.version;
  const conflict =
    conflictState !== null && conflictState.taskId === taskId ? conflictState.message : null;
  const visibleSubtasks =
    currentTask !== null && subtasks.taskId === currentTask.id ? subtasks : EMPTY_SUBTASKS;
  const activeQuickDraft =
    currentTask === null
      ? null
      : quickDraft !== null && quickDraft.taskId === currentTask.id
        ? quickDraft
        : createQuickDraft(currentTask);
  const quickDirty =
    currentTask !== null &&
    activeQuickDraft !== null &&
    (activeQuickDraft.nextStatus !== currentTask.status ||
      activeQuickDraft.dueValue !== dueAtToDateInput(currentTask.dueAt) ||
      activeQuickDraft.tagsValue !== tagsToInput(currentTask.tags) ||
      (activeQuickDraft.subtaskOpen && activeQuickDraft.subtaskTitle.trim().length > 0));
  const draftDirty = editDirty || quickDirty;

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
            subtaskItems = await fetchSubtasks(invoke, loadedTask.id);
          } catch (subtaskLoadError) {
            // Ошибка списка подзадач не должна скрывать саму карточку.
            subtaskError = errorMessage(subtaskLoadError);
          }
        }

        if (!cancelled) {
          const previousBaseline = quickBaselineRef.current;

          setTask(loadedTask);
          setProject(projectOutput.project);
          setParentTask(parentOutput?.task ?? null);
          setSubtasks({
            taskId: loadedTask.id,
            items: subtaskItems,
            loading: false,
            error: subtaskError,
          });
          setQuickDraft((current) => syncQuickDraft(current, loadedTask, previousBaseline));
          quickBaselineRef.current = baselineOf(loadedTask);
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

  // Смена выбранной карточки всегда начинает новую сессию: черновики и
  // подтверждение закрытия от предыдущей задачи не переносятся.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditingTaskId(null);
    setEditSession(null);
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
    setEditSession(null);
    setEditValues(null);
    setEditInitial(null);
    setQuickDraft(null);
    quickBaselineRef.current = null;
    setError(null);
    setConflictState(null);
    updateKanbanQuery({ taskId: null });
  }, []);

  const requestClose = useCallback((): void => {
    if (draftDirty) {
      setCloseConfirm(true);
      return;
    }

    closeNow();
  }, [draftDirty, closeNow]);

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
        setEditSession(null);
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

  const changeQuickDraft = (patch: Partial<Omit<QuickDraft, "taskId">>): void => {
    setQuickDraft((current) => {
      const base = current ?? (currentTask === null ? null : createQuickDraft(currentTask));

      return base === null ? current : { ...base, ...patch };
    });
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
    setEditSession({ taskId: currentTask.id, expectedVersion: currentTask.version });
    setEditInitial(initial);
    setEditValues(initial);
    setEditingTaskId(currentTask.id);
  };

  const cancelEdit = (): void => {
    setEditingTaskId(null);
    setEditSession(null);
    setEditValues(null);
    setEditInitial(null);
    setCloseConfirm(false);
    setError(null);
  };

  const save = async (values: TaskFormValues): Promise<void> => {
    if (currentTask === null || editSession === null || editSession.taskId !== currentTask.id) {
      return;
    }

    // expectedVersion фиксируется при открытии формы: даже если карточка
    // успела перечитаться, сохранение устаревшего черновика обязано получить
    // VERSION_CONFLICT, а не тихо перезаписать чужую правку.
    const input: TaskUpdateInput = {
      id: editSession.taskId,
      expectedVersion: editSession.expectedVersion,
      title: values.title,
      descriptionMarkdown: values.descriptionMarkdown,
      priority: values.priority,
      dueAt: dateInputToDueAt(values.dueAt, "start"),
      tags: parseTagsInput(values.tags),
    };

    const saved = await runCommand(async () => {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskUpdate, input as unknown as JsonValue);
      setEditingTaskId(null);
      setEditSession(null);
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
    setEditSession(null);
    setEditValues(null);
    setEditInitial(null);
    setQuickDraft(null);
    quickBaselineRef.current = null;
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
      setQuickDraft((current) =>
        current !== null && current.taskId === currentTask.id
          ? { ...current, subtaskOpen: false, subtaskTitle: "", subtaskStatus: "todo" }
          : current,
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
        key={currentTask.id}
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
        editOutdated={editOutdated}
        editValues={editValues}
        editRootTasks={rootTasks}
        closeConfirm={closeConfirm}
        nextStatus={activeQuickDraft?.nextStatus ?? currentTask.status}
        dueValue={activeQuickDraft?.dueValue ?? dueAtToDateInput(currentTask.dueAt)}
        tagsValue={activeQuickDraft?.tagsValue ?? tagsToInput(currentTask.tags)}
        subtaskDraft={
          {
            open: activeQuickDraft?.subtaskOpen ?? false,
            title: activeQuickDraft?.subtaskTitle ?? "",
            status: activeQuickDraft?.subtaskStatus ?? "todo",
          } satisfies SubtaskFormDraft
        }
        onChangeEditValues={setEditValues}
        onStartEdit={startEdit}
        onCancelEdit={cancelEdit}
        onCancelStaleEdit={cancelEdit}
        onSubmitEdit={(values) => {
          void save(values);
        }}
        onClose={requestClose}
        onOpenTask={openTask}
        onCreateSubtask={createSubtask}
        onComplete={complete}
        onMove={move}
        onNextStatusChange={(status) => {
          changeQuickDraft({ nextStatus: status });
        }}
        onPriority={changePriority}
        onDue={changeDue}
        onDueValueChange={(value) => {
          changeQuickDraft({ dueValue: value });
        }}
        onTags={changeTags}
        onTagsValueChange={(value) => {
          changeQuickDraft({ tagsValue: value });
        }}
        onSubtaskDraftChange={(patch) => {
          changeQuickDraft({
            ...(patch.open === undefined ? {} : { subtaskOpen: patch.open }),
            ...(patch.title === undefined ? {} : { subtaskTitle: patch.title }),
            ...(patch.status === undefined ? {} : { subtaskStatus: patch.status }),
          });
        }}
        onDelete={remove}
        onDiscardDraft={closeNow}
        onKeepEditing={() => {
          setCloseConfirm(false);
        }}
      />
    );

  return (
    <ModalDialog
      open
      label="Детали задачи"
      testId="kanban-details"
      dataVariant={isDesktopViewport ? "desktop" : "mobile"}
      onClose={requestClose}
      closeOnBackdrop
      restoreFocusSelector={`[data-testid="kanban-open-${taskId}"]`}
      className={isDesktopViewport ? DESKTOP_DIALOG_CLASS : MOBILE_DIALOG_CLASS}
    >
      {body}
    </ModalDialog>
  );
}
