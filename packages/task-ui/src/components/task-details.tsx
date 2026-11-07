import { useState } from "react";

import type { Project, Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";

import {
  TASK_STATUS_LABELS,
  formatDueAt,
  taskPriorityLabel,
  taskStatusLabel,
  taskStatuses,
} from "../format.ts";

export interface TaskDetailsProps {
  readonly task: Task;
  readonly project: Project | null;
  readonly parentTask: Task | null;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onComplete: () => void;
  readonly onMove: (status: TaskStatus) => void;
  readonly onDelete: () => void;
}

const actionClass =
  "rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

/**
 * Содержимое панели деталей задачи.
 *
 * Удаление требует явного inline-подтверждения: `window.confirm` не
 * используется ни как основной, ни как единственный способ подтвердить
 * разрушительную операцию.
 */
export function TaskDetails({
  task,
  project,
  parentTask,
  busy = false,
  error = null,
  onClose,
  onEdit,
  onComplete,
  onMove,
  onDelete,
}: TaskDetailsProps) {
  // Подтверждение привязано к ID задачи: при переходе к другой задаче
  // панель подтверждения не переносится, отдельный эффект не нужен.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const confirmingDelete = confirmingDeleteId === task.id;
  const [nextStatus, setNextStatus] = useState<TaskStatus>("todo");

  return (
    <section
      data-testid="task-details"
      aria-label={`Детали задачи ${task.title}`}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">{task.title}</h2>
          <p className="text-xs text-muted-foreground">Проект: {project?.title ?? "—"}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть детали"
          className="shrink-0 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Закрыть
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Статус</dt>
          <dd className="font-medium">{taskStatusLabel(task.status)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Приоритет</dt>
          <dd className="font-medium">{taskPriorityLabel(task.priority)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Срок</dt>
          <dd className="font-medium">{formatDueAt(task.dueAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Версия</dt>
          <dd className="font-medium">{task.version}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Родительская задача</dt>
          <dd className="font-medium">{parentTask?.title ?? "Нет"}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Теги</dt>
          <dd>
            {task.tags.length === 0 ? (
              <span className="text-muted-foreground">Нет тегов</span>
            ) : (
              <ul aria-label="Теги" className="flex flex-wrap gap-1">
                {task.tags.map((tag) => (
                  <li key={tag} className="rounded-md bg-secondary px-1.5 py-0.5">
                    {tag}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">Описание</h3>
        <p className="mt-1 text-sm whitespace-pre-wrap break-words">
          {task.descriptionMarkdown.length === 0 ? "Без описания" : task.descriptionMarkdown}
        </p>
      </div>

      {error === null ? null : (
        <p role="alert" data-testid="task-details-error" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} disabled={busy} className={actionClass}>
          Редактировать
        </button>
        {task.status === "done" ? null : (
          <button
            type="button"
            onClick={onComplete}
            disabled={busy}
            className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          >
            Завершить
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Переместить в
          <select
            value={nextStatus}
            disabled={busy}
            onChange={(event) => {
              setNextStatus(event.target.value as TaskStatus);
            }}
            className="h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {taskStatuses().map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            onMove(nextStatus);
          }}
          disabled={busy || nextStatus === task.status}
          className={actionClass}
        >
          Переместить
        </button>
      </div>

      <div className="mt-2 border-t pt-3">
        {confirmingDelete ? (
          <div
            role="group"
            aria-label="Подтверждение удаления задачи"
            data-testid="task-delete-confirm-panel"
            className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2"
          >
            <p className="text-sm text-destructive">
              Удалить задачу «{task.title}» безвозвратно? Действие нельзя отменить.
            </p>
            <div className="flex flex-wrap gap-2">
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
                  setConfirmingDeleteId(null);
                }}
                className={actionClass}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid="task-delete"
            disabled={busy}
            onClick={() => {
              setConfirmingDeleteId(task.id);
            }}
            className="rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 disabled:opacity-50"
          >
            Удалить
          </button>
        )}
      </div>
    </section>
  );
}
