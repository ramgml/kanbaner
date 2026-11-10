"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  normalizeTags,
  type Project,
  type ProjectGetOutput,
  type Task,
  type TaskColumn,
  type TaskCompleteInput,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskGetOutput,
  type TaskListOutput,
  type TaskMoveInput,
  type TaskMutationOutput,
  type TaskPriority,
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
import { defaultCreateColumnId, effectiveColumnId } from "./board-state.ts";
import { fetchProjectColumns } from "./load-columns.ts";
import {
  VERSION_CONFLICT_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "./operations.ts";
import {
  bumpKanbanRevision,
  registerKanbanSearchWriter,
  serializeKanbanQuery,
  updateKanbanQuery,
  useKanbanQuery,
} from "./query-state.ts";
import {
  TaskModal,
  type QuickDraftField,
  type SubtaskDraft,
  type SubtaskFormDraft,
} from "./task-modal.tsx";
import { ViewToggle } from "./view-toggle.tsx";

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
  readonly columnId: string;
  readonly dueAt: string | null;
  readonly tags: readonly string[];
}

/** Несохранённые значения быстрых действий, живущие вне breakpoint-модала. */
interface QuickDraft {
  readonly taskId: string;
  readonly nextColumnId: string;
  readonly dueValue: string;
  readonly tagsValue: string;
  readonly subtaskOpen: boolean;
  readonly subtaskTitle: string;
  readonly subtaskColumnId: string;
}

/** Черновик и поля, по которым сервер и локальное значение разошлись. */
interface QuickState {
  readonly draft: QuickDraft;
  readonly conflicts: readonly QuickDraftField[];
}

/** Сессия редактирования: версия фиксируется в момент открытия формы. */
interface EditSession {
  readonly taskId: string;
  readonly expectedVersion: number;
}

function baselineOf(task: Task, columns: readonly TaskColumn[]): QuickBaseline {
  return {
    taskId: task.id,
    columnId: effectiveColumnId(task, columns) ?? "",
    dueAt: task.dueAt,
    tags: [...task.tags],
  };
}

function createQuickDraft(task: Task, columns: readonly TaskColumn[]): QuickDraft {
  return {
    taskId: task.id,
    nextColumnId: effectiveColumnId(task, columns) ?? "",
    dueValue: dueAtToDateInput(task.dueAt),
    tagsValue: tagsToInput(task.tags),
    subtaskOpen: false,
    subtaskTitle: "",
    subtaskColumnId: defaultCreateColumnId(columns) ?? "",
  };
}

function tagsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/**
 * Канонизирует значение поля тегов тем же способом, что и домен:
 * trim, нижний регистр, дедупликация.
 *
 * Возвращает `null`, если значение нельзя нормализовать (слишком много или
 * слишком длинные теги); тогда поле считается изменённым.
 */
function canonicalTags(value: string): readonly string[] | null {
  try {
    return normalizeTags(parseTagsInput(value));
  } catch {
    return null;
  }
}

function sameTagsValue(value: string, serverTags: readonly string[]): boolean {
  const canonical = canonicalTags(value);

  return canonical !== null && tagsEqual(canonical, serverTags);
}

function sameDueValue(value: string, dueAt: string | null): boolean {
  return dueAtToDateInput(dueAt) === value;
}

/** Поле всё ещё отличается от серверного значения. */
function fieldConflicted(
  field: QuickDraftField,
  draft: QuickDraft,
  task: Task,
  columns: readonly TaskColumn[],
): boolean {
  if (field === "column") {
    return draft.nextColumnId !== (effectiveColumnId(task, columns) ?? "");
  }

  if (field === "due") {
    return !sameDueValue(draft.dueValue, task.dueAt);
  }

  return !sameTagsValue(draft.tagsValue, task.tags);
}

/**
 * Трёхстороннее слияние быстрых черновиков с новой серверной версией.
 *
 * Для status/due/tags:
 * - локальное значение совпадает с новым серверным → канонизируем локальное
 *   (включая регистр/trim/дубликаты тегов) и снимаем конфликт;
 * - локальное значение равно старому baseline → принимаем новое серверное;
 * - серверное значение не изменилось → сохраняем локальный черновик;
 * - изменились и локальное, и серверное → сохраняем локальное и фиксируем
 *   конфликт, который требует явного «Взять серверные» или «Оставить мои».
 *
 * Поэтому успешная команда по другому полю или перечитывание после сохранения
 * не затирают несохранённое поле молча.
 */
function syncQuickState(
  current: QuickState | null,
  task: Task,
  baseline: QuickBaseline | null,
  columns: readonly TaskColumn[],
): QuickState {
  if (
    current === null ||
    current.draft.taskId !== task.id ||
    baseline === null ||
    baseline.taskId !== task.id
  ) {
    return { draft: createQuickDraft(task, columns), conflicts: [] };
  }

  const serverColumnId = effectiveColumnId(task, columns) ?? "";
  const next: {
    taskId: string;
    nextColumnId: string;
    dueValue: string;
    tagsValue: string;
    subtaskOpen: boolean;
    subtaskTitle: string;
    subtaskColumnId: string;
  } = { ...current.draft };
  const conflicts = new Set(current.conflicts);

  if (next.nextColumnId === serverColumnId) {
    next.nextColumnId = serverColumnId;
    conflicts.delete("column");
  } else if (baseline.columnId === next.nextColumnId) {
    next.nextColumnId = serverColumnId;
    conflicts.delete("column");
  } else if (baseline.columnId !== serverColumnId) {
    conflicts.add("column");
  }

  if (columns.length > 0 && !columns.some((column) => column.id === next.subtaskColumnId)) {
    next.subtaskColumnId = defaultCreateColumnId(columns) ?? "";
  }

  if (sameDueValue(next.dueValue, task.dueAt)) {
    next.dueValue = dueAtToDateInput(task.dueAt);
    conflicts.delete("due");
  } else if (sameDueValue(next.dueValue, baseline.dueAt)) {
    next.dueValue = dueAtToDateInput(task.dueAt);
    conflicts.delete("due");
  } else if (baseline.dueAt !== task.dueAt) {
    conflicts.add("due");
  }

  if (sameTagsValue(next.tagsValue, task.tags)) {
    next.tagsValue = tagsToInput(task.tags);
    conflicts.delete("tags");
  } else if (sameTagsValue(next.tagsValue, baseline.tags)) {
    next.tagsValue = tagsToInput(task.tags);
    conflicts.delete("tags");
  } else if (!tagsEqual(baseline.tags, task.tags)) {
    conflicts.add("tags");
  }

  return { draft: next, conflicts: [...conflicts] };
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
  const [columns, setColumns] = useState<readonly TaskColumn[]>([]);
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const [subtasks, setSubtasks] = useState<SubtasksState>(EMPTY_SUBTASKS);
  const [rootTasks, setRootTasks] = useState<readonly Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editSession, setEditSession] = useState<EditSession | null>(null);
  const [editValues, setEditValues] = useState<TaskFormValues | null>(null);
  const [editInitial, setEditInitial] = useState<TaskFormValues | null>(null);
  const [quickState, setQuickState] = useState<QuickState | null>(null);
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
  const activeQuickState =
    currentTask === null
      ? null
      : quickState !== null && quickState.draft.taskId === currentTask.id
        ? quickState
        : null;
  const activeQuickDraft =
    activeQuickState?.draft ??
    (currentTask === null ? null : createQuickDraft(currentTask, columns));
  const currentColumnId =
    currentTask === null ? "" : (effectiveColumnId(currentTask, columns) ?? "");
  const quickConflicts = activeQuickState?.conflicts ?? [];
  const quickDirty =
    currentTask !== null &&
    activeQuickDraft !== null &&
    (activeQuickDraft.nextColumnId !== currentColumnId ||
      !sameDueValue(activeQuickDraft.dueValue, currentTask.dueAt) ||
      !sameTagsValue(activeQuickDraft.tagsValue, currentTask.tags) ||
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
        let projectColumns: readonly TaskColumn[] = [];

        try {
          projectColumns = await fetchProjectColumns(invoke, loadedTask.projectId);
        } catch {
          // Колонки недоступны — карточка остаётся работоспособной через
          // legacy-статус, но quick move и подзадачи без колонок блокируются.
        }

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
          setColumns(projectColumns);
          setParentTask(parentOutput?.task ?? null);
          setSubtasks({
            taskId: loadedTask.id,
            items: subtaskItems,
            loading: false,
            error: subtaskError,
          });
          setQuickState((current) =>
            syncQuickState(current, loadedTask, previousBaseline, projectColumns),
          );
          quickBaselineRef.current = baselineOf(loadedTask, projectColumns);
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
    setQuickState(null);
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
    setQuickState((current) => {
      const base =
        current?.draft ?? (currentTask === null ? null : createQuickDraft(currentTask, columns));

      if (base === null) {
        return current;
      }

      const draft = { ...base, ...patch };

      return {
        draft,
        conflicts:
          currentTask === null
            ? []
            : (current?.conflicts ?? []).filter((field) =>
                fieldConflicted(field, draft, currentTask, columns),
              ),
      };
    });
  };

  const acceptServerDrafts = (): void => {
    if (currentTask === null) {
      return;
    }

    const server = createQuickDraft(currentTask, columns);

    setQuickState((current) => {
      if (current === null || current.draft.taskId !== currentTask.id) {
        return current;
      }

      const draft = { ...current.draft };

      // «Взять серверные» относится только к полям, по которым показан
      // конфликт. Неконфликтные dirty-черновики (в том числе subtask-форма)
      // остаются локальными и продолжают удерживать общий dirty guard.
      for (const field of current.conflicts) {
        if (field === "column") {
          draft.nextColumnId = server.nextColumnId;
        } else if (field === "due") {
          draft.dueValue = server.dueValue;
        } else {
          draft.tagsValue = server.tagsValue;
        }
      }

      return { draft, conflicts: [] };
    });
  };

  const keepLocalDrafts = (): void => {
    setQuickState((current) => (current === null ? current : { ...current, conflicts: [] }));
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

  const move = (columnId: string): void => {
    if (currentTask === null || columnId.length === 0) {
      return;
    }

    const input: TaskMoveInput = {
      id: currentTask.id,
      expectedVersion: currentTask.version,
      columnId,
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
    setQuickState(null);
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

    if (draft.columnId.length === 0 || !columns.some((column) => column.id === draft.columnId)) {
      setError("Выберите существующую колонку для подзадачи");

      return false;
    }

    const input: TaskCreateInput = {
      projectId: currentTask.projectId,
      parentTaskId: currentTask.id,
      title,
      descriptionMarkdown: "",
      columnId: draft.columnId,
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
      setQuickState((current) =>
        current !== null && current.draft.taskId === currentTask.id
          ? {
              draft: {
                ...current.draft,
                subtaskOpen: false,
                subtaskTitle: "",
                subtaskColumnId: defaultCreateColumnId(columns) ?? "",
              },
              conflicts: current.conflicts,
            }
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
        draftDirty={draftDirty}
        quickConflicts={quickConflicts}
        columns={columns}
        currentColumnId={currentColumnId}
        nextColumnId={activeQuickDraft?.nextColumnId ?? currentColumnId}
        dueValue={activeQuickDraft?.dueValue ?? dueAtToDateInput(currentTask.dueAt)}
        tagsValue={activeQuickDraft?.tagsValue ?? tagsToInput(currentTask.tags)}
        subtaskDraft={
          {
            open: activeQuickDraft?.subtaskOpen ?? false,
            title: activeQuickDraft?.subtaskTitle ?? "",
            columnId: activeQuickDraft?.subtaskColumnId ?? "",
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
        onNextColumnChange={(columnId) => {
          changeQuickDraft({ nextColumnId: columnId });
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
            ...(patch.columnId === undefined ? {} : { subtaskColumnId: patch.columnId }),
          });
        }}
        onAcceptServerDrafts={acceptServerDrafts}
        onKeepLocalDrafts={keepLocalDrafts}
        onDelete={remove}
        onDiscardDraft={closeNow}
        onKeepEditing={() => {
          setCloseConfirm(false);
        }}
        viewSwitch={
          <ViewToggle
            route={KANBAN_ROUTE}
            search={serializeKanbanQuery(query)}
            testIdPrefix="project-view-modal"
            label="Представление проекта в карточке"
          />
        }
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
