"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { Project, Task, TaskColumn, TaskPriority } from "@kanbaner/plugin-tasks/contract";
import {
  dueAtToDateInput,
  formatDueAt,
  tagsToInput,
  taskPriorities,
  taskPriorityLabel,
  taskStatusLabel,
} from "@kanbaner/task-ui";

export interface SubtaskDraft {
  readonly title: string;
  /** Фактическая колонка, в которой создаётся подзадача. */
  readonly columnId: string;
}

export interface SubtaskFormDraft extends SubtaskDraft {
  readonly open: boolean;
}

/** Быстрые поля, для которых возможен конфликт локального и серверного значения. */
export type QuickDraftField = "column" | "due" | "tags";

/** Поле карточки с inline-редактором. */
export type InlineField = "title" | "description";

/**
 * Сессия inline-редактирования.
 *
 * `expectedVersion` фиксируется в момент открытия редактора, а `initial`
 * хранит серверное значение на этот момент. Благодаря этому поздний refresh
 * не затирает ввод, а сохранение устаревшего черновика получает конфликт.
 */
export interface InlineEditSession {
  readonly field: InlineField;
  readonly taskId: string;
  readonly initial: string;
  readonly draft: string;
  readonly expectedVersion: number;
}

export interface TaskModalProps {
  readonly variant: "desktop" | "mobile";
  readonly task: Task;
  readonly project: Project | null;
  readonly parentTask: Task | null;
  readonly subtasks: readonly Task[];
  readonly subtasksLoading: boolean;
  readonly subtasksError: string | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly inlineSession: InlineEditSession | null;
  readonly inlineError: string | null;
  /** Версия задачи изменилась после открытия редактора. */
  readonly inlineStale: boolean;
  readonly closeConfirm: boolean;
  /** Есть несохранённый ввод (inline-редактор или быстрые поля). */
  readonly quickConflicts: readonly QuickDraftField[];
  readonly columns: readonly TaskColumn[];
  readonly currentColumnId: string;
  readonly nextColumnId: string;
  readonly dueValue: string;
  readonly tagsValue: string;
  readonly subtaskDraft: SubtaskFormDraft;
  readonly onStartInline: (field: InlineField) => void;
  readonly onChangeInline: (value: string) => void;
  readonly onSaveInline: () => void;
  readonly onCancelInline: () => void;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onCreateSubtask: (draft: SubtaskDraft) => Promise<boolean>;
  readonly onComplete: () => void;
  readonly onMove: (columnId: string) => void;
  readonly onNextColumnChange: (columnId: string) => void;
  readonly onPriority: (priority: TaskPriority) => void;
  readonly onDue: (value: string) => void;
  readonly onDueValueChange: (value: string) => void;
  readonly onTags: (value: string) => void;
  readonly onTagsValueChange: (value: string) => void;
  readonly onSubtaskDraftChange: (patch: Partial<SubtaskFormDraft>) => void;
  readonly onAcceptServerDrafts: () => void;
  readonly onKeepLocalDrafts: () => void;
  readonly onDelete: () => void;
  readonly onDiscardDraft: () => void;
  readonly onKeepEditing: () => void;
}

const actionClass =
  "rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

const inputClass =
  "h-9 w-full rounded-md border bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

const labelClass = "flex flex-col gap-1 text-xs font-medium text-muted-foreground";

const sectionClass = "rounded-lg border border-border/70 bg-muted/30 p-3";

const DESTRUCTIVE_BUTTON =
  "rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 disabled:opacity-50";

const QUICK_CONFLICT_LABELS: Record<QuickDraftField, string> = {
  column: "колонка",
  due: "срок",
  tags: "теги",
};

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

function completedLabel(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

/**
 * Содержимое Trello-like карточки.
 *
 * Компонент не выполняет доменных запросов: все действия передаются наружу
 * через публичные callbacks, а данные приходят из `TaskOverlay`. Один и тот же
 * контент используется desktop- и mobile-вариантами общего `ModalDialog`;
 * раскладка переходит в одну колонку ниже breakpoint-а `xl`.
 *
 * Черновики inline-полей (название, описание) и быстрых действий (статус, срок,
 * теги, форма подзадачи) хранятся снаружи, в `TaskOverlay`. Поэтому успешная
 * команда по другому полю, поздний refresh и смена layout не стирают
 * несохранённые значения.
 */
export function TaskModal({
  variant,
  task,
  project,
  parentTask,
  subtasks,
  subtasksLoading,
  subtasksError,
  busy,
  error,
  inlineSession,
  inlineError,
  inlineStale,
  closeConfirm,
  quickConflicts,
  columns,
  currentColumnId,
  nextColumnId,
  dueValue,
  tagsValue,
  subtaskDraft,
  onStartInline,
  onChangeInline,
  onSaveInline,
  onCancelInline,
  onClose,
  onOpenTask,
  onCreateSubtask,
  onComplete,
  onMove,
  onNextColumnChange,
  onPriority,
  onDue,
  onDueValueChange,
  onTags,
  onTagsValueChange,
  onSubtaskDraftChange,
  onAcceptServerDrafts,
  onKeepLocalDrafts,
  onDelete,
  onDiscardDraft,
  onKeepEditing,
}: TaskModalProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [subtaskError, setSubtaskError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const titleDisplayRef = useRef<HTMLHeadingElement | null>(null);
  const descriptionDisplayRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const touchTapRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startedAt: number;
    moved: boolean;
    invalid: boolean;
  } | null>(null);
  const cancelInlineRef = useRef(onCancelInline);
  const previousInlineFieldRef = useRef<InlineField | null>(null);
  const previousTaskIdRef = useRef(task.id);
  const inlineField = inlineSession?.field ?? null;
  const inlineTaskId = inlineSession?.taskId ?? null;

  useEffect(() => {
    cancelInlineRef.current = onCancelInline;
  }, [onCancelInline]);

  const canCreateSubtask = task.parentTaskId === null;
  const completed = completedLabel(task.completedAt);
  const dueDirty = dueValue !== dueAtToDateInput(task.dueAt);
  const tagsDirty = tagsValue !== tagsToInput(task.tags);
  const isMobile = variant === "mobile";
  const currentColumn =
    columns.find((column) => column.id === currentColumnId) ??
    columns.find((column) => column.status === task.status) ??
    null;
  const currentColumnDone = currentColumn?.status === "done";
  const columnTitleOf = (subtask: Task): string | null =>
    columns.find((column) => column.id === subtask.columnId)?.title ??
    columns.find((column) => column.status === subtask.status)?.title ??
    null;
  const subtaskColumn = columns.find((column) => column.id === subtaskDraft.columnId) ?? null;

  // Подтверждение закрытия — модальный alertdialog внутри модала: фокус
  // переходит в него, а Tab/Shift+Tab не выходят к форме за подтверждением.
  useEffect(() => {
    if (!closeConfirm) {
      return;
    }

    const panel = confirmRef.current;

    if (panel === null) {
      return;
    }

    const focusable = (): readonly HTMLElement[] => [
      ...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ];
    const first = focusable()[0];

    first?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") {
        return;
      }

      const items = focusable();
      const firstItem = items[0];
      const lastItem = items[items.length - 1];

      if (firstItem === undefined || lastItem === undefined) {
        event.preventDefault();
        return;
      }

      const active = document.activeElement;

      if (!event.shiftKey && (active === lastItem || !panel.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      } else if (event.shiftKey && (active === firstItem || !panel.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      }
    };

    panel.addEventListener("keydown", onKeyDown);

    return () => {
      panel.removeEventListener("keydown", onKeyDown);
    };
  }, [closeConfirm]);

  // Нативный <dialog> слушает Escape на bubble-фазе. Перехватываем Escape в
  // capture на самом редакторе, поэтому отмена поля не закрывает карточку и
  // не открывает подтверждение закрытия.
  useEffect(() => {
    const editor = editorRef.current;

    if (editor === null || inlineField === null) {
      return;
    }

    const onKeyDownCapture = (event: Event): void => {
      if (!(event instanceof KeyboardEvent) || event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      cancelInlineRef.current();
    };

    editor.addEventListener("keydown", onKeyDownCapture, true);

    return () => {
      editor.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, [inlineField, inlineTaskId]);

  // После сохранения или отмены возвращаем фокус на заголовок/область
  // описания. При смене задачи A→B фокус не переносится.
  useEffect(() => {
    const field = inlineSession?.field ?? null;
    const taskChanged = previousTaskIdRef.current !== task.id;

    if (taskChanged) {
      previousTaskIdRef.current = task.id;
    }

    if (!taskChanged && previousInlineFieldRef.current !== null && field === null) {
      const target =
        previousInlineFieldRef.current === "title"
          ? titleDisplayRef.current
          : descriptionDisplayRef.current;

      target?.focus();
    }

    previousInlineFieldRef.current = field;
  }, [inlineSession?.field, task.id]);

  // Второй палец или движение вне контейнера тоже отменяют tap. Слушаем
  // документ, потому что touch-события второго пальца не обязаны всплывать
  // через область заголовка/описания.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const tap = touchTapRef.current;

      if (tap !== null && event.pointerType === "touch" && event.pointerId !== tap.pointerId) {
        tap.invalid = true;
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      const tap = touchTapRef.current;

      if (
        tap !== null &&
        event.pointerType === "touch" &&
        event.pointerId === tap.pointerId &&
        Math.hypot(event.clientX - tap.startX, event.clientY - tap.startY) > 8
      ) {
        tap.moved = true;
      }
    };
    const onPointerCancel = (event: PointerEvent): void => {
      const tap = touchTapRef.current;

      if (tap !== null && event.pointerId === tap.pointerId) {
        touchTapRef.current = null;
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointercancel", onPointerCancel, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, []);

  const focusDraftOrigin = (): void => {
    const root = rootRef.current;

    if (root === null) {
      return;
    }

    const inlineEditor =
      inlineSession === null
        ? null
        : root.querySelector<HTMLElement>(
            inlineSession.field === "title"
              ? '[data-testid="kanban-title-input"]'
              : '[data-testid="kanban-description-input"]',
          );

    if (inlineEditor !== null) {
      inlineEditor.focus();

      return;
    }

    const target = dueDirty
      ? root.querySelector<HTMLElement>('[data-testid="kanban-modal-due"]')
      : tagsDirty
        ? root.querySelector<HTMLElement>('[data-testid="kanban-modal-tags"]')
        : nextColumnId !== currentColumnId
          ? root.querySelector<HTMLElement>('[data-testid="kanban-modal-move-field"]')
          : subtaskDraft.open && subtaskDraft.title.trim().length > 0
            ? root.querySelector<HTMLElement>('[data-testid="kanban-subtask-input"]')
            : root.querySelector<HTMLElement>('[data-testid="kanban-details-close"]');

    target?.focus();
  };

  const submitSubtask = async (): Promise<void> => {
    const title = subtaskDraft.title.trim();

    if (title.length === 0) {
      setSubtaskError("Укажите название подзадачи");
      return;
    }

    setSubtaskError(null);
    await onCreateSubtask({ title, columnId: subtaskDraft.columnId });
  };

  const isComposing = (event: ReactKeyboardEvent<HTMLElement>): boolean =>
    event.nativeEvent.isComposing || event.keyCode === 229;

  const startTouchTap = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType !== "touch") {
      return;
    }

    const active = touchTapRef.current;

    if (active !== null) {
      // Второй палец или повторное нажатие отменяют tap. Новый primary с
      // другим pointerId — это скорее потерянный pointerup прошлого жеста.
      if (!event.isPrimary || event.pointerId === active.pointerId) {
        active.invalid = true;
        return;
      }

      touchTapRef.current = null;
    }

    if (!event.isPrimary) {
      return;
    }

    touchTapRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: Date.now(),
      moved: false,
      invalid: false,
    };
  };

  const trackTouchTap = (event: ReactPointerEvent<HTMLElement>): void => {
    const tap = touchTapRef.current;

    if (tap === null || event.pointerType !== "touch" || event.pointerId !== tap.pointerId) {
      return;
    }

    if (Math.hypot(event.clientX - tap.startX, event.clientY - tap.startY) > 8) {
      tap.moved = true;
    }
  };

  const finishTouchTap =
    (field: InlineField) =>
    (event: ReactPointerEvent<HTMLElement>): void => {
      const tap = touchTapRef.current;

      if (tap === null || event.pointerType !== "touch" || event.pointerId !== tap.pointerId) {
        return;
      }

      // Долгое удержание (выделение текста) — не tap.
      const confirmed =
        event.isPrimary && !tap.moved && !tap.invalid && Date.now() - tap.startedAt < 500;

      touchTapRef.current = null;

      if (confirmed && !busy) {
        event.preventDefault();
        onStartInline(field);
      }
    };

  const cancelTouchTap = (event: ReactPointerEvent<HTMLElement>): void => {
    const tap = touchTapRef.current;

    if (tap !== null && event.pointerId === tap.pointerId) {
      touchTapRef.current = null;
    }
  };

  const openInlineOnKey = (field: InlineField) => (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.key === "Enter" || event.key === "F2") && !isComposing(event)) {
      event.preventDefault();
      onStartInline(field);
    }
  };

  const saveTitleOnKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && !isComposing(event)) {
      event.preventDefault();
      onSaveInline();
    }
  };

  const saveDescriptionOnKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing(event)) {
      event.preventDefault();
      onSaveInline();
    }
  };

  const inlineEditorClass =
    "w-full rounded-md border bg-background px-2 py-1.5 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

  const inlineHint = "Двойной клик или Enter — редактировать";

  return (
    <div
      ref={rootRef}
      data-testid="kanban-modal"
      data-task-version={task.version}
      className={`flex min-h-0 flex-col bg-card text-card-foreground ${
        isMobile ? "h-full" : "max-h-[calc(100dvh-2rem)]"
      }`}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-col gap-1">
          {inlineSession?.field === "title" ? (
            <div
              ref={editorRef}
              data-testid="kanban-title-editor"
              className="flex min-w-0 flex-col gap-2"
            >
              <input
                data-testid="kanban-title-input"
                name="title"
                aria-label="Название задачи"
                aria-invalid={inlineError === null ? undefined : true}
                value={inlineSession.draft}
                maxLength={200}
                autoFocus
                disabled={busy}
                onChange={(event) => {
                  onChangeInline(event.target.value);
                }}
                onKeyDown={saveTitleOnKey}
                className={`${inlineEditorClass} text-lg font-semibold sm:text-xl`}
              />
              {inlineError === null ? null : (
                <p
                  role="alert"
                  data-testid="kanban-inline-error"
                  className="m-0 text-xs text-destructive"
                >
                  {inlineError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="kanban-title-save"
                  disabled={busy}
                  onClick={onSaveInline}
                  className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  Сохранить
                </button>
                <button
                  type="button"
                  data-testid="kanban-title-cancel"
                  disabled={busy}
                  onClick={onCancelInline}
                  className={actionClass}
                >
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            <h2
              ref={titleDisplayRef}
              data-testid="kanban-modal-title"
              role="button"
              tabIndex={0}
              title={inlineHint}
              aria-label={`Название задачи: ${task.title}. ${inlineHint}`}
              onDoubleClick={() => {
                onStartInline("title");
              }}
              onPointerDown={startTouchTap}
              onPointerMove={trackTouchTap}
              onPointerUp={finishTouchTap("title")}
              onPointerCancel={cancelTouchTap}
              onKeyDown={openInlineOnKey("title")}
              className="m-0 cursor-text rounded-sm text-lg leading-tight font-semibold break-words hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-xl"
            >
              {task.title}
            </h2>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="kanban-modal-project">{project?.title ?? "—"}</span>
            <span
              data-testid="kanban-modal-status"
              className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground"
            >
              {currentColumn?.title ?? taskStatusLabel(task.status)}
            </span>
            {completed === null ? null : (
              <span data-testid="kanban-modal-completed">Завершено: {completed}</span>
            )}
          </div>
          {parentTask === null ? null : (
            <button
              type="button"
              data-testid="kanban-modal-parent"
              disabled={busy}
              onClick={() => {
                onOpenTask(parentTask.id);
              }}
              className="w-fit rounded text-left text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Родитель: {parentTask.title}
            </button>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            data-testid="kanban-details-close"
            aria-label="Закрыть детали задачи"
            autoFocus
            onClick={onClose}
            className="flex size-10 shrink-0 items-center justify-center rounded-md text-lg leading-none text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      {closeConfirm ? (
        <div
          ref={confirmRef}
          role="alertdialog"
          aria-modal="true"
          aria-label="Несохранённые изменения"
          data-testid="kanban-draft-confirm"
          className="m-3 flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
        >
          <p className="m-0 font-medium">В карточке есть несохранённые изменения.</p>
          <p className="m-0 text-xs text-muted-foreground">
            Закрытие без сохранения потеряет введённые значения.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="kanban-draft-discard"
              disabled={busy}
              onClick={onDiscardDraft}
              className="rounded-md bg-destructive px-2.5 py-1.5 text-xs font-medium text-white hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 disabled:opacity-50"
            >
              Закрыть без сохранения
            </button>
            <button
              type="button"
              data-testid="kanban-draft-keep"
              disabled={busy}
              onClick={() => {
                onKeepEditing();
                focusDraftOrigin();
              }}
              className={actionClass}
            >
              Продолжить редактирование
            </button>
          </div>
        </div>
      ) : null}

      {inlineStale && inlineSession !== null ? (
        <div
          role="alert"
          data-testid="kanban-inline-stale"
          className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive sm:mx-5"
        >
          <span>
            Задача изменена на сервере. Черновик сохранён; сохранение будет отклонено с конфликтом
            версий.
          </span>
          <button
            type="button"
            data-testid="kanban-inline-stale-cancel"
            disabled={busy}
            onClick={onCancelInline}
            className={actionClass}
          >
            Отменить правки
          </button>
        </div>
      ) : null}

      {quickConflicts.length === 0 ? null : (
        <div
          role="alert"
          data-testid="kanban-quick-conflict"
          className="mx-4 mt-3 flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-900 dark:text-amber-200 sm:mx-5"
        >
          <span>
            Изменены на сервере, пока вы редактировали:{" "}
            {quickConflicts.map((field) => QUICK_CONFLICT_LABELS[field]).join(", ")}. Локальные
            значения сохранены.
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="kanban-quick-conflict-rebase"
              disabled={busy}
              onClick={onAcceptServerDrafts}
              className={actionClass}
            >
              Взять серверные
            </button>
            <button
              type="button"
              data-testid="kanban-quick-conflict-keep"
              disabled={busy}
              onClick={onKeepLocalDrafts}
              className={actionClass}
            >
              Оставить мои
            </button>
          </div>
        </div>
      )}

      {error === null ? null : (
        <p
          role="alert"
          data-testid="task-details-error"
          className="mx-4 mt-3 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive sm:mx-5"
        >
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_270px]">
          <div className="flex min-w-0 flex-col gap-4">
            <section aria-label="Описание задачи" className={sectionClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Описание (Markdown)
                </h3>
                {inlineSession?.field === "description" ? null : (
                  <span className="text-[11px] text-muted-foreground">{inlineHint}</span>
                )}
              </div>
              {inlineSession?.field === "description" ? (
                <div
                  ref={editorRef}
                  data-testid="kanban-description-editor"
                  className="mt-2 flex flex-col gap-2"
                >
                  <textarea
                    data-testid="kanban-description-input"
                    name="descriptionMarkdown"
                    aria-label="Описание (Markdown)"
                    aria-invalid={inlineError === null ? undefined : true}
                    value={inlineSession.draft}
                    maxLength={100_000}
                    autoFocus
                    disabled={busy}
                    onChange={(event) => {
                      onChangeInline(event.target.value);
                    }}
                    onKeyDown={saveDescriptionOnKey}
                    className={`${inlineEditorClass} min-h-32`}
                  />
                  {inlineError === null ? null : (
                    <p
                      role="alert"
                      data-testid="kanban-inline-error"
                      className="m-0 text-xs text-destructive"
                    >
                      {inlineError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="kanban-description-save"
                      disabled={busy}
                      onClick={onSaveInline}
                      className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                    >
                      Сохранить
                    </button>
                    <button
                      type="button"
                      data-testid="kanban-description-cancel"
                      disabled={busy}
                      onClick={onCancelInline}
                      className={actionClass}
                    >
                      Отмена
                    </button>
                  </div>
                  <p className="m-0 text-[11px] text-muted-foreground">
                    Ctrl/Cmd+Enter — сохранить, Escape — отменить. Markdown сохраняется как текст.
                  </p>
                </div>
              ) : (
                <div
                  ref={descriptionDisplayRef}
                  data-testid="kanban-modal-description"
                  role="button"
                  tabIndex={0}
                  title={inlineHint}
                  aria-label={`Описание задачи. ${inlineHint}`}
                  onDoubleClick={() => {
                    onStartInline("description");
                  }}
                  onPointerDown={startTouchTap}
                  onPointerMove={trackTouchTap}
                  onPointerUp={finishTouchTap("description")}
                  onPointerCancel={cancelTouchTap}
                  onKeyDown={openInlineOnKey("description")}
                  className="mt-2 min-h-16 cursor-text rounded-sm text-sm hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {task.descriptionMarkdown.length === 0 ? (
                    <span className="text-muted-foreground">Добавить описание…</span>
                  ) : (
                    <p className="m-0 whitespace-pre-wrap break-words">
                      {task.descriptionMarkdown}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section aria-label="Подзадачи" className={sectionClass}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Подзадачи
                </h3>
                {canCreateSubtask ? (
                  <button
                    type="button"
                    data-testid="kanban-subtask-create"
                    disabled={busy}
                    onClick={() => {
                      onSubtaskDraftChange({ open: !subtaskDraft.open });
                      setSubtaskError(null);
                    }}
                    className={actionClass}
                  >
                    {subtaskDraft.open ? "Скрыть форму" : "Добавить подзадачу"}
                  </button>
                ) : null}
              </div>

              {canCreateSubtask && subtaskDraft.open ? (
                <form
                  data-testid="kanban-subtask-form"
                  aria-label="Создание подзадачи"
                  className="mt-2 flex flex-col gap-2 rounded-md border border-border/70 bg-background p-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitSubtask();
                  }}
                >
                  <label className={labelClass}>
                    Название подзадачи
                    <input
                      data-testid="kanban-subtask-input"
                      name="title"
                      value={subtaskDraft.title}
                      maxLength={200}
                      disabled={busy}
                      onChange={(event) => {
                        onSubtaskDraftChange({ title: event.target.value });
                      }}
                      className={inputClass}
                    />
                  </label>
                  <label className={labelClass}>
                    Колонка подзадачи
                    <select
                      name="columnId"
                      value={subtaskDraft.columnId}
                      disabled={busy || columns.length === 0}
                      onChange={(event) => {
                        onSubtaskDraftChange({ columnId: event.target.value });
                      }}
                      className={inputClass}
                    >
                      {columns.length === 0 ? (
                        <option value="">Нет доступных колонок</option>
                      ) : (
                        columns.map((column) => (
                          <option key={column.id} value={column.id}>
                            {column.title}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  {subtaskError === null ? null : (
                    <p role="alert" className="m-0 text-xs text-destructive">
                      {subtaskError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="submit"
                      data-testid="kanban-subtask-submit"
                      disabled={
                        busy || subtaskDraft.title.trim().length === 0 || subtaskColumn === null
                      }
                      className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                    >
                      Создать подзадачу
                    </button>
                    <button
                      type="button"
                      data-testid="kanban-subtask-cancel"
                      disabled={busy}
                      onClick={() => {
                        onSubtaskDraftChange({ open: false });
                        setSubtaskError(null);
                      }}
                      className={actionClass}
                    >
                      Отмена
                    </button>
                  </div>
                </form>
              ) : null}

              {subtasksError === null ? null : (
                <p role="alert" className="mt-2 m-0 text-xs text-destructive">
                  Подзадачи: {subtasksError}
                </p>
              )}

              {subtasksLoading && subtasks.length === 0 ? (
                <p className="mt-2 m-0 text-xs text-muted-foreground">Загрузка подзадач…</p>
              ) : subtasks.length === 0 ? (
                <p
                  data-testid="kanban-subtasks-empty"
                  className="mt-2 m-0 text-xs text-muted-foreground"
                >
                  {canCreateSubtask ? "Подзадач пока нет" : "Это подзадача"}
                </p>
              ) : (
                <ul
                  data-testid="kanban-modal-subtasks"
                  className="mt-2 m-0 flex list-none flex-col gap-1 p-0"
                >
                  {subtasks.map((subtask) => (
                    <li key={subtask.id}>
                      <button
                        type="button"
                        data-testid={`kanban-subtask-${subtask.id}`}
                        disabled={busy}
                        onClick={() => {
                          onOpenTask(subtask.id);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                      >
                        <span className="min-w-0 break-words">{subtask.title}</span>
                        <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                          {columnTitleOf(subtask) ?? taskStatusLabel(subtask.status)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <aside aria-label="Действия с задачей" className="flex min-w-0 flex-col gap-3">
            <section className={sectionClass}>
              <h3 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Колонка и перемещение
              </h3>
              <label className={`${labelClass} mt-2`}>
                Переместить в
                <select
                  data-testid="kanban-modal-move-field"
                  value={nextColumnId}
                  disabled={busy || columns.length === 0}
                  onChange={(event) => {
                    onNextColumnChange(event.target.value);
                  }}
                  className={inputClass}
                >
                  {columns.length === 0 ? (
                    <option value="">Нет доступных колонок</option>
                  ) : (
                    columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.title}
                        {column.status === "done" ? " (Done)" : ""}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                data-testid="kanban-modal-move"
                disabled={busy || nextColumnId.length === 0 || nextColumnId === currentColumnId}
                onClick={() => {
                  onMove(nextColumnId);
                }}
                className={`${actionClass} mt-2 w-full`}
              >
                Переместить
              </button>
              {currentColumnDone ? null : (
                <button
                  type="button"
                  data-testid="kanban-modal-complete"
                  disabled={busy}
                  onClick={onComplete}
                  className="mt-2 w-full rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  Завершить
                </button>
              )}
            </section>

            <section className={sectionClass}>
              <label className={labelClass}>
                Приоритет
                <select
                  data-testid="kanban-modal-priority"
                  value={task.priority}
                  disabled={busy}
                  onChange={(event) => {
                    onPriority(event.target.value as TaskPriority);
                  }}
                  className={inputClass}
                >
                  {taskPriorities().map((priority) => (
                    <option key={priority} value={priority}>
                      {taskPriorityLabel(priority)}
                    </option>
                  ))}
                </select>
              </label>
            </section>

            <section className={sectionClass}>
              <label className={labelClass}>
                Срок
                <input
                  data-testid="kanban-modal-due"
                  type="date"
                  value={dueValue}
                  disabled={busy}
                  onChange={(event) => {
                    onDueValueChange(event.target.value);
                  }}
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                data-testid="kanban-modal-due-save"
                disabled={busy || !dueDirty}
                onClick={() => {
                  onDue(dueValue);
                }}
                className={`${actionClass} mt-2 w-full`}
              >
                Сохранить срок
              </button>
              <p className="mt-1 m-0 text-[11px] text-muted-foreground">
                Сейчас: {formatDueAt(task.dueAt)}
              </p>
            </section>

            <section className={sectionClass}>
              <label className={labelClass}>
                Теги через запятую
                <input
                  data-testid="kanban-modal-tags"
                  value={tagsValue}
                  disabled={busy}
                  placeholder="release, backend"
                  onChange={(event) => {
                    onTagsValueChange(event.target.value);
                  }}
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                data-testid="kanban-modal-tags-save"
                disabled={busy || !tagsDirty}
                onClick={() => {
                  onTags(tagsValue);
                }}
                className={`${actionClass} mt-2 w-full`}
              >
                Сохранить теги
              </button>
            </section>

            <section className="rounded-lg border border-destructive/30 p-3">
              {confirmingDelete ? (
                <div
                  role="group"
                  aria-label="Подтверждение удаления задачи"
                  data-testid="task-delete-confirm-panel"
                  className="flex flex-col gap-2"
                >
                  <p className="m-0 text-xs text-destructive">
                    Удалить задачу «{task.title}» безвозвратно? Действие нельзя отменить.
                  </p>
                  <button
                    type="button"
                    data-testid="task-delete-confirm"
                    disabled={busy}
                    onClick={onDelete}
                    className="rounded-md bg-destructive px-2.5 py-1.5 text-xs font-medium text-white hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 disabled:opacity-50"
                  >
                    Удалить задачу
                  </button>
                  <button
                    type="button"
                    data-testid="task-delete-cancel"
                    disabled={busy}
                    onClick={() => {
                      setConfirmingDelete(false);
                    }}
                    className={actionClass}
                  >
                    Отмена
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="task-delete"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingDelete(true);
                  }}
                  className={`${DESTRUCTIVE_BUTTON} w-full`}
                >
                  Удалить
                </button>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
