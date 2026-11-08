"use client";

import { useEffect, useRef, useState } from "react";

import type { Project, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import { taskStatusLabel } from "@kanbaner/task-ui";

export interface QuickCreateInput {
  readonly title: string;
  readonly projectId: string;
}

export type QuickCreateResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface QuickComposerDraft {
  readonly title: string;
  readonly projectId: string;
}

export interface KanbanQuickComposerProps {
  readonly status: TaskStatus;
  readonly projects: readonly Project[];
  /** Проект из активного фильтра; пустая строка — режим «Все проекты». */
  readonly activeProjectId: string;
  readonly disabled: boolean;
  readonly onCreate: (input: QuickCreateInput) => Promise<QuickCreateResult>;
  readonly onOpenDetails: (draft: QuickComposerDraft) => void;
}

const actionButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

/**
 * Trello-like быстрый composer внизу колонки.
 *
 * Enter создаёт задачу, Shift+Enter добавляет строку, Escape закрывает.
 * Проект берётся из активного фильтра, а в режиме «Все проекты» выбирается
 * inline — введённый заголовок при этом не теряется. После успеха composer
 * остаётся открытым и очищается для следующей карточки; при ошибке текст
 * сохраняется.
 */
export function KanbanQuickComposer({
  status,
  projects,
  activeProjectId,
  disabled,
  onCreate,
  onOpenDetails,
}: KanbanQuickComposerProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const guardRef = useRef(false);

  useEffect(() => {
    if (open) {
      textareaRef.current?.focus();
    }
  }, [open]);

  const selectedProjectId = activeProjectId.length > 0 ? activeProjectId : projectId;
  const needsProjectChoice = activeProjectId.length === 0;
  const canSubmit =
    !disabled && !submitting && title.trim().length > 0 && selectedProjectId.length > 0;

  const openComposer = (): void => {
    if (disabled) {
      return;
    }

    // В режиме «Все проекты» выбор начинается с пустого значения, чтобы
    // пользователь явно выбрал проект; активный фильтр уже задаёт контекст.
    setProjectId(activeProjectId.length > 0 ? activeProjectId : "");
    setOpen(true);
    setError(null);
  };

  const closeComposer = (): void => {
    setOpen(false);
    setTitle("");
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (guardRef.current || submitting || disabled) {
      return;
    }

    if (selectedProjectId.length === 0) {
      setError("Выберите проект");
      return;
    }

    if (title.trim().length === 0) {
      setError("Укажите название задачи");
      return;
    }

    guardRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const result = await onCreate({ title: title.trim(), projectId: selectedProjectId });

      if (result.ok) {
        setTitle("");
        textareaRef.current?.focus();
      } else {
        setError(result.message);
      }
    } finally {
      guardRef.current = false;
      setSubmitting(false);
    }
  };

  const label = taskStatusLabel(status);

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`kanban-quick-add-${status}`}
        aria-label={`Добавить карточку в колонку «${label}»`}
        title={disabled ? "Сначала создайте проект" : `Добавить карточку в колонку «${label}»`}
        disabled={disabled}
        onClick={openComposer}
        className={`${actionButtonClass} justify-start border border-transparent bg-transparent text-left text-muted-foreground hover:bg-background/80 hover:text-foreground`}
      >
        <span aria-hidden="true" className="mr-1 text-base leading-none">
          +
        </span>
        Добавить карточку
      </button>
    );
  }

  return (
    <form
      aria-label={`Быстрое добавление задачи в колонку «${label}»`}
      data-testid={`kanban-quick-add-form-${status}`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeComposer();
        }
      }}
    >
      <textarea
        ref={textareaRef}
        data-testid={`kanban-quick-add-input-${status}`}
        aria-label={`Название новой задачи в колонке «${label}»`}
        placeholder="Введите название задачи…"
        value={title}
        rows={2}
        disabled={submitting}
        onChange={(event) => {
          setTitle(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            closeComposer();
            return;
          }

          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
      />

      {needsProjectChoice ? (
        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          Проект
          <select
            name="quickProjectId"
            aria-label="Проект"
            value={projectId}
            disabled={submitting}
            onChange={(event) => {
              setProjectId(event.target.value);
              setError(null);
            }}
            className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:h-8"
          >
            <option value="">Выберите проект</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {error === null ? null : (
        <p
          role="alert"
          data-testid={`kanban-quick-add-error-${status}`}
          className="m-0 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="submit"
          data-testid={`kanban-quick-add-submit-${status}`}
          disabled={!canSubmit}
          aria-busy={submitting}
          className={`${actionButtonClass} bg-primary text-primary-foreground hover:bg-primary/90`}
        >
          {submitting ? "Добавление…" : "Добавить карточку"}
        </button>
        <button
          type="button"
          aria-label="Закрыть добавление карточки"
          onClick={closeComposer}
          disabled={submitting}
          className={`${actionButtonClass} border border-border bg-background text-foreground hover:bg-accent`}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <button
        type="button"
        data-testid={`kanban-quick-details-${status}`}
        onClick={() => {
          onOpenDetails({ title, projectId: selectedProjectId });
        }}
        disabled={submitting}
        className="min-h-10 w-fit rounded-md px-1 text-left text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-7"
      >
        Добавить с деталями
      </button>
    </form>
  );
}
