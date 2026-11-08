"use client";

import { useEffect, useRef, useState } from "react";

import type { Project, Task, TaskPriority, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import {
  TASK_STATUS_LABELS,
  TaskForm,
  dueAtToDateInput,
  formatDueAt,
  tagsToInput,
  taskPriorities,
  taskPriorityLabel,
  taskStatusLabel,
  taskStatuses,
  type TaskFormValues,
} from "@kanbaner/task-ui";

export interface SubtaskDraft {
  readonly title: string;
  readonly status: TaskStatus;
}

export interface SubtaskFormDraft extends SubtaskDraft {
  readonly open: boolean;
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
  readonly editing: boolean;
  readonly editOutdated: boolean;
  readonly editValues: TaskFormValues | null;
  readonly editRootTasks: readonly Task[];
  readonly closeConfirm: boolean;
  readonly nextStatus: TaskStatus;
  readonly dueValue: string;
  readonly tagsValue: string;
  readonly subtaskDraft: SubtaskFormDraft;
  readonly onChangeEditValues: (values: TaskFormValues) => void;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onCancelStaleEdit: () => void;
  readonly onSubmitEdit: (values: TaskFormValues) => void;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onCreateSubtask: (draft: SubtaskDraft) => Promise<boolean>;
  readonly onComplete: () => void;
  readonly onMove: (status: TaskStatus) => void;
  readonly onNextStatusChange: (status: TaskStatus) => void;
  readonly onPriority: (priority: TaskPriority) => void;
  readonly onDue: (value: string) => void;
  readonly onDueValueChange: (value: string) => void;
  readonly onTags: (value: string) => void;
  readonly onTagsValueChange: (value: string) => void;
  readonly onSubtaskDraftChange: (patch: Partial<SubtaskFormDraft>) => void;
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
 * Черновики быстрых действий (статус, срок, теги, форма подзадачи) хранятся
 * снаружи, в `TaskOverlay`, поэтому успешная команда по другому полю и смена
 * layout не стирают несохранённые значения.
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
  editing,
  editOutdated,
  editValues,
  editRootTasks,
  closeConfirm,
  nextStatus,
  dueValue,
  tagsValue,
  subtaskDraft,
  onChangeEditValues,
  onStartEdit,
  onCancelEdit,
  onCancelStaleEdit,
  onSubmitEdit,
  onClose,
  onOpenTask,
  onCreateSubtask,
  onComplete,
  onMove,
  onNextStatusChange,
  onPriority,
  onDue,
  onDueValueChange,
  onTags,
  onTagsValueChange,
  onSubtaskDraftChange,
  onDelete,
  onDiscardDraft,
  onKeepEditing,
}: TaskModalProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [subtaskError, setSubtaskError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const canCreateSubtask = task.parentTaskId === null;
  const completed = completedLabel(task.completedAt);
  const dueDirty = dueValue !== dueAtToDateInput(task.dueAt);
  const tagsDirty = tagsValue !== tagsToInput(task.tags);
  const isMobile = variant === "mobile";

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

  const focusDraftOrigin = (): void => {
    const root = rootRef.current;

    if (root === null) {
      return;
    }

    const form = root.querySelector<HTMLElement>('[data-testid="task-form-edit"]');

    if (form !== null) {
      form.querySelector<HTMLElement>('input[name="title"]')?.focus();

      return;
    }

    const target = dueDirty
      ? root.querySelector<HTMLElement>('[data-testid="kanban-modal-due"]')
      : tagsDirty
        ? root.querySelector<HTMLElement>('[data-testid="kanban-modal-tags"]')
        : nextStatus !== task.status
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
    await onCreateSubtask({ title, status: subtaskDraft.status });
  };

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
          <h2
            data-testid="kanban-modal-title"
            className="m-0 text-lg leading-tight font-semibold break-words sm:text-xl"
          >
            {task.title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="kanban-modal-project">{project?.title ?? "—"}</span>
            <span
              data-testid="kanban-modal-status"
              className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground"
            >
              {taskStatusLabel(task.status)}
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

      {editing && editOutdated ? (
        <div
          role="alert"
          data-testid="kanban-edit-stale"
          className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive sm:mx-5"
        >
          <span>
            Задача изменена на сервере. Черновик сохранён; сохранение будет отклонено с конфликтом
            версий.
          </span>
          <button
            type="button"
            data-testid="kanban-edit-stale-cancel"
            disabled={busy}
            onClick={onCancelStaleEdit}
            className={actionClass}
          >
            Отменить правки
          </button>
        </div>
      ) : null}

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
        {editing && editValues !== null ? (
          <div className="p-4 sm:p-5">
            <TaskForm
              key={`edit-${task.id}`}
              mode="edit"
              projects={project === null ? [] : [project]}
              rootTasks={editRootTasks}
              values={editValues}
              onValuesChange={onChangeEditValues}
              excludeTaskId={task.id}
              lockParent
              submitting={busy}
              error={null}
              onSubmit={onSubmitEdit}
              onCancel={onCancelEdit}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_270px]">
            <div className="flex min-w-0 flex-col gap-4">
              <section aria-label="Описание задачи" className={sectionClass}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Описание (Markdown)
                  </h3>
                  <button
                    type="button"
                    data-testid="kanban-modal-edit"
                    disabled={busy}
                    onClick={onStartEdit}
                    className={actionClass}
                  >
                    Редактировать
                  </button>
                </div>
                <p
                  data-testid="kanban-modal-description"
                  className="mt-2 m-0 text-sm whitespace-pre-wrap break-words"
                >
                  {task.descriptionMarkdown.length === 0
                    ? "Без описания"
                    : task.descriptionMarkdown}
                </p>
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
                      Статус подзадачи
                      <select
                        name="status"
                        value={subtaskDraft.status}
                        disabled={busy}
                        onChange={(event) => {
                          onSubtaskDraftChange({ status: event.target.value as TaskStatus });
                        }}
                        className={inputClass}
                      >
                        {taskStatuses().map((status) => (
                          <option key={status} value={status}>
                            {TASK_STATUS_LABELS[status]}
                          </option>
                        ))}
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
                        disabled={busy || subtaskDraft.title.trim().length === 0}
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
                            {taskStatusLabel(subtask.status)}
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
                  Статус и перемещение
                </h3>
                <label className={`${labelClass} mt-2`}>
                  Переместить в
                  <select
                    data-testid="kanban-modal-move-field"
                    value={nextStatus}
                    disabled={busy}
                    onChange={(event) => {
                      onNextStatusChange(event.target.value as TaskStatus);
                    }}
                    className={inputClass}
                  >
                    {taskStatuses().map((status) => (
                      <option key={status} value={status}>
                        {taskStatusLabel(status)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  data-testid="kanban-modal-move"
                  disabled={busy || nextStatus === task.status}
                  onClick={() => {
                    onMove(nextStatus);
                  }}
                  className={`${actionClass} mt-2 w-full`}
                >
                  Переместить
                </button>
                {task.status === "done" ? null : (
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
        )}
      </div>
    </div>
  );
}
