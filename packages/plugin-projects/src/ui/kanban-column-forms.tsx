"use client";

import type { TaskColumn, TaskColumnType } from "@kanbaner/plugin-tasks/contract";
import { ModalDialog } from "@kanbaner/task-ui";

import { isLastColumnOfType } from "./board-state.ts";

export interface KanbanAddColumnFormProps {
  readonly title: string;
  readonly type: TaskColumnType;
  readonly error: string | null;
  readonly submitting: boolean;
  readonly onTitleChange: (value: string) => void;
  readonly onTypeChange: (value: TaskColumnType) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

const inputClass =
  "h-10 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:h-8";

/**
 * Форма новой колонки.
 *
 * Домен по умолчанию дописывает колонку в конец порядка, поэтому отдельное
 * поле позиции не нужно: пользователь всегда видит результат справа.
 */
export function KanbanAddColumnForm({
  title,
  type,
  error,
  submitting,
  onTitleChange,
  onTypeChange,
  onSubmit,
  onCancel,
}: KanbanAddColumnFormProps) {
  return (
    <section
      data-testid="kanban-add-column-panel"
      aria-label="Новая колонка"
      className="flex min-h-0 w-[85vw] max-w-[272px] shrink-0 snap-start flex-col gap-2 rounded-xl border border-dashed border-border bg-background/70 p-2.5 md:w-auto md:max-w-none md:min-w-[272px]"
    >
      <h2 className="m-0 px-0.5 text-sm font-semibold tracking-tight">Новая колонка</h2>

      <form
        data-testid="kanban-column-form"
        aria-label="Создание колонки"
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          Название
          <input
            autoFocus
            name="title"
            data-testid="kanban-column-title-input"
            aria-label="Название новой колонки"
            value={title}
            maxLength={200}
            disabled={submitting}
            onChange={(event) => {
              onTitleChange(event.target.value);
            }}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          Тип
          <select
            name="type"
            data-testid="kanban-column-type"
            aria-label="Тип новой колонки"
            value={type}
            disabled={submitting}
            onChange={(event) => {
              onTypeChange(event.target.value === "done" ? "done" : "open");
            }}
            className={inputClass}
          >
            <option value="open">Открытая</option>
            <option value="done">Done</option>
          </select>
        </label>

        <p className="m-0 text-[11px] text-muted-foreground">
          Колонка добавляется в конец порядка. Задачи в Done получают дату завершения.
        </p>

        {error === null ? null : (
          <p
            role="alert"
            data-testid="kanban-column-error"
            className="m-0 text-xs text-destructive"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          <button
            type="submit"
            data-testid="kanban-column-submit"
            disabled={submitting || title.trim().length === 0}
            aria-busy={submitting}
            className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 xl:min-h-8"
          >
            {submitting ? "Добавление…" : "Добавить колонку"}
          </button>
          <button
            type="button"
            data-testid="kanban-column-cancel"
            disabled={submitting}
            onClick={onCancel}
            className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 xl:min-h-8"
          >
            Отмена
          </button>
        </div>
      </form>
    </section>
  );
}

export interface KanbanDeleteColumnDialogProps {
  readonly column: TaskColumn;
  readonly columns: readonly TaskColumn[];
  /** Точное число задач из `task.list{columnId}` без tag-фильтра. */
  readonly taskCount: number | null;
  readonly taskCountError: string | null;
  readonly targetColumnId: string;
  readonly error: string | null;
  readonly submitting: boolean;
  readonly onTargetChange: (columnId: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

/**
 * Разрушительное подтверждение удаления колонки.
 *
 * Явно показывает, сколько задач будет перенесено и в какую колонку. Целевой
 * список строится только из колонок текущего проекта и всегда исключает
 * удаляемую, поэтому self-target и чужой проект недостижимы из UI.
 */
export function KanbanDeleteColumnDialog({
  column,
  columns,
  taskCount,
  taskCountError,
  targetColumnId,
  error,
  submitting,
  onTargetChange,
  onSubmit,
  onCancel,
}: KanbanDeleteColumnDialogProps) {
  const targets = columns.filter((candidate) => candidate.id !== column.id);
  const target = targets.find((candidate) => candidate.id === targetColumnId) ?? null;
  const lastOfType = isLastColumnOfType(columns, column.id);

  return (
    <ModalDialog
      open
      label={`Удалить колонку «${column.title}»`}
      testId="kanban-column-delete-dialog"
      onClose={onCancel}
      className="m-auto w-[calc(100vw-2rem)] max-w-[30rem] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/45"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-base font-semibold">Удалить колонку «{column.title}»?</h2>
          <p className="m-0 text-xs text-muted-foreground">
            Колонка удаляется безвозвратно. Действие нельзя отменить.
          </p>
        </div>

        <div
          data-testid="kanban-column-delete-consequences"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs"
        >
          {taskCountError !== null ? (
            <p
              role="alert"
              data-testid="kanban-column-delete-count-error"
              className="m-0 font-medium text-destructive"
            >
              Не удалось получить точное число задач: {taskCountError}
            </p>
          ) : (
            <p className="m-0 font-medium text-destructive">
              Будет перенесено задач:{" "}
              <span data-testid="kanban-column-delete-moved-count">
                {taskCount === null ? "…" : taskCount}
              </span>
            </p>
          )}
        </div>

        {lastOfType ? (
          <p
            role="alert"
            data-testid="kanban-column-delete-last"
            className="m-0 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          >
            Нельзя удалить последнюю {column.status === "done" ? "Done" : "открытую"} колонку
            проекта. Сначала добавьте или переименуйте другую колонку этого типа.
          </p>
        ) : (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Перенести задачи в колонку
            <select
              data-testid="kanban-column-delete-target"
              aria-label="Колонка для переноса задач"
              value={targetColumnId}
              disabled={submitting}
              onChange={(event) => {
                onTargetChange(event.target.value);
              }}
              className="h-10 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:h-8"
            >
              {targets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                  {candidate.status === "done" ? " (Done)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {target === null ? null : (
          <p className="m-0 text-xs text-muted-foreground">
            Задачи из «{column.title}» перейдут в «{target.title}»
            {target.status === "done"
              ? " и получат дату завершения."
              : "; дата завершения будет снята."}
          </p>
        )}

        {error === null ? null : (
          <p
            role="alert"
            data-testid="kanban-column-delete-error"
            className="m-0 text-xs text-destructive"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-testid="kanban-column-delete-cancel"
            disabled={submitting}
            onClick={onCancel}
            className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 xl:min-h-8"
          >
            Отмена
          </button>
          <button
            type="button"
            data-testid="kanban-column-delete-confirm"
            disabled={
              submitting ||
              lastOfType ||
              target === null ||
              taskCount === null ||
              taskCountError !== null
            }
            aria-busy={submitting}
            onClick={onSubmit}
            className="inline-flex min-h-10 items-center rounded-md bg-destructive px-3 text-sm font-medium text-white hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 disabled:opacity-50 xl:min-h-8"
          >
            {submitting ? "Удаление…" : "Удалить колонку"}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
