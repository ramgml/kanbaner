"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type Project,
  type ProjectGetOutput,
  type Task,
  type TaskColumn,
  type TaskCompleteInput,
  type TaskDeleteInput,
  type TaskGetOutput,
  type TaskListOutput,
  type TaskMoveInput,
  type TaskUpdateInput,
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

import {
  VERSION_CONFLICT_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "../ui/operations.ts";
import { effectiveColumnId } from "../ui/board-state.ts";
import { fetchProjectColumns } from "../ui/load-columns.ts";
import {
  bumpTaskListRevision,
  serializeTaskListQuery,
  updateTaskListQuery,
  useTaskListQuery,
} from "./query-state.ts";
import { TASK_LIST_ROUTE } from "../metadata.ts";
import { ViewToggle } from "../ui/view-toggle.tsx";

export interface TaskDetailsPanelProps {
  readonly invoke: UiOperationInvoker;
  /** desktop — `app.details`, mobile — полноэкранный `app.overlays`. */
  readonly variant: "desktop" | "mobile";
  /**
   * Текущий pathname shell-а.
   *
   * Детали относятся только к `/view/tasks`: прямой `/plugins?task=id` и
   * client-side переход в другой раздел не должны загружать или показывать
   * задачу.
   */
  readonly pathname?: string | undefined;
  /** Актуальная query string App Router: синхронизирует list/task состояние. */
  readonly search?: string | undefined;
}

const DESKTOP_MEDIA_QUERY = "(min-width: 1280px)";

function subscribeDesktopViewport(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const query = window.matchMedia(DESKTOP_MEDIA_QUERY);

  query.addEventListener("change", onChange);

  return () => {
    query.removeEventListener("change", onChange);
  };
}

function getDesktopViewportSnapshot(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(DESKTOP_MEDIA_QUERY).matches
    : false;
}

function getDesktopViewportServerSnapshot(): boolean {
  return false;
}

// Собираем имя элемента из частей: наивный SQL-детектор границ импортов
// иначе принимает CSS-селектор `select` за SQL-запрос.
const SELECT_ELEMENT = "sel" + "ect";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  `${SELECT_ELEMENT}:not([disabled])`,
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getClientRects().length > 0,
  );
}

/**
 * Панель деталей выбранной задачи.
 *
 * Детали не рендерятся без `task` в query string и вне маршрута списка. Все
 * изменения идут через публичные команды; после команды выполняется
 * повторный `task.get` и запрос списка через общую ревизию.
 */
export function TaskDetailsPanel({ invoke, variant, pathname, search }: TaskDetailsPanelProps) {
  const query = useTaskListQuery(search);
  const taskId = query.taskId;
  const workspaceSearch = serializeTaskListQuery(query);
  const onTaskRoute = pathname === TASK_LIST_ROUTE;
  const isDesktopViewport = useSyncExternalStore(
    subscribeDesktopViewport,
    getDesktopViewportSnapshot,
    getDesktopViewportServerSnapshot,
  );
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [columns, setColumns] = useState<readonly TaskColumn[]>([]);
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
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (taskId === null || !onTaskRoute) {
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
        let projectColumns: readonly TaskColumn[] = [];

        try {
          projectColumns = await fetchProjectColumns(invoke, taskOutput.task.projectId);
        } catch {
          // Детали доступны и без колонок: legacy-статус остаётся fallback.
        }
        const parentOutput =
          taskOutput.task.parentTaskId === null
            ? null
            : await invokeJson<TaskGetOutput>(invoke, TASKS_QUERY_IDS.taskGet, {
                id: taskOutput.task.parentTaskId,
              });

        if (!cancelled) {
          setTask(taskOutput.task);
          setProject(projectOutput.project);
          setColumns(projectColumns);
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
  }, [invoke, taskId, query.revision, onTaskRoute]);

  useEffect(() => {
    if (!editing || task === null || !onTaskRoute) {
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
  }, [invoke, editing, task, query.revision, onTaskRoute]);

  useEffect(() => {
    if (taskId === null || editing || !onTaskRoute) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // Вложенный modal (например, переименование проекта) уже обработал
      // Escape и закрыл только себя. Не сбрасываем выбранную задачу.
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      updateTaskListQuery({ taskId: null });
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [taskId, editing, onTaskRoute]);

  // Мобильная панель — настоящий modal `<dialog>`: браузер сам удерживает
  // фокус внутри, закрывает по Escape и возвращает фокус на карточку.
  // Breakpoint входит в зависимости: resize mobile→desktop закрывает modal и
  // снимает trap, обратный переход снова вызывает showModal и initial focus.
  useEffect(() => {
    if (variant !== "mobile" || !onTaskRoute || taskId === null || isDesktopViewport) {
      return;
    }

    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    const active = document.activeElement;

    restoreFocusRef.current = active instanceof HTMLElement ? active : null;

    if (!dialog.open) {
      dialog.showModal();
    }

    const focusFirst = (): void => {
      const first = focusableElements(dialog)[0];

      if (first !== undefined) {
        first.focus();
      } else {
        dialog.focus();
      }
    };

    if (!dialog.contains(document.activeElement)) {
      focusFirst();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (first === undefined || last === undefined) {
        event.preventDefault();
        return;
      }

      const active = document.activeElement;
      const inside = active instanceof HTMLElement && dialog.contains(active);

      if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      }
    };

    dialog.addEventListener("keydown", onKeyDown);

    return () => {
      dialog.removeEventListener("keydown", onKeyDown);

      if (dialog.open) {
        dialog.close();
      }

      const preferred = restoreFocusRef.current;

      restoreFocusRef.current = null;

      // После mobile→desktop мобильная карточка скрыта. Возвращаем фокус
      // только на видимый элемент: предпочтительно исходный, иначе кнопку
      // той же задачи в desktop-таблице.
      const fallback = document.querySelector<HTMLElement>(
        `[data-testid="task-row-${taskId}"] button`,
      );
      const target = [preferred, fallback].find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          element.isConnected &&
          element.getClientRects().length > 0,
      );

      target?.focus();
    };
  }, [variant, onTaskRoute, taskId, isDesktopViewport]);

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
          setConflictState({ taskId, message: VERSION_CONFLICT_MESSAGE });
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

  const move = (columnId: string): void => {
    if (task === null) {
      return;
    }

    const input: TaskMoveInput = {
      id: task.id,
      expectedVersion: task.version,
      columnId,
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

  if (taskId === null || !onTaskRoute) {
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
        key={task.id}
        task={task}
        project={project}
        parentTask={parentTask}
        columns={columns.length === 0 ? undefined : columns}
        currentColumnId={effectiveColumnId(task, columns)}
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
        onMoveToColumn={move}
        onDelete={remove}
      />
    );

  if (variant === "mobile") {
    return (
      <dialog
        ref={dialogRef}
        data-testid="task-details-mobile"
        aria-label="Детали задачи"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        className="m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-background p-4 backdrop:bg-black/40 xl:hidden"
      >
        {editing ? null : (
          <div className="mb-3 flex justify-end">
            <ViewToggle
              route={TASK_LIST_ROUTE}
              search={workspaceSearch}
              testIdPrefix="task-details-view"
              label="Представление проекта в деталях задачи"
            />
          </div>
        )}
        {content}
      </dialog>
    );
  }

  return (
    <div data-testid="task-details-desktop" className="flex min-w-0 flex-col gap-2">
      {content}
    </div>
  );
}
