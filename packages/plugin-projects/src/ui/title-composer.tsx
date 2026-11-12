"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { taskStatusLabel } from "@kanbaner/task-ui";
import type { TaskStatus } from "@kanbaner/plugin-tasks/contract";

export type TitleCreateResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface TitleComposerProps {
  readonly status: TaskStatus;
  /** Фактический заголовок колонки; без него используется legacy-статус. */
  readonly columnTitle?: string | undefined;
  readonly projectId: string;
  readonly disabled?: boolean;
  readonly onCreate: (title: string) => Promise<TitleCreateResult>;
  readonly onCancel: () => void;
  readonly onSuccess?: (() => void) | undefined;
  readonly keepOpen?: boolean;
  readonly autoFocus?: boolean;
  readonly submitLabel?: string;
  readonly testIdPrefix: string;
  /** Увеличивается после создания из другой формы: очищает заголовок. */
  readonly resetToken?: number | undefined;
  /**
   * Начальное значение для повторного монтирования при смене layout.
   * Draft хранится у вызывающей стороны и переживает mobile ↔ desktop.
   */
  readonly initialTitle?: string | undefined;
  readonly onTitleChange?: ((title: string) => void) | undefined;
}

const actionButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

const GUARD_MESSAGE = "Выберите проект в списке проектов";

/**
 * Короткий composer создания карточки.
 *
 * Содержит только название: проект определяется текущей доской, статус —
 * колонкой или режимом общего composer-а. Позицию вычисляет доменный append.
 */
export function TitleComposer({
  status,
  columnTitle,
  projectId,
  disabled = false,
  onCreate,
  onCancel,
  onSuccess,
  keepOpen = false,
  autoFocus = true,
  submitLabel = "Добавить карточку",
  testIdPrefix,
  resetToken = 0,
  initialTitle = "",
  onTitleChange,
}: TitleComposerProps) {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const guardRef = useRef(false);
  const [seenResetToken, setSeenResetToken] = useState(resetToken);

  if (seenResetToken !== resetToken) {
    setSeenResetToken(resetToken);
    setTitle("");
    setError(null);
  }

  useEffect(() => {
    if (autoFocus && !submitting) {
      inputRef.current?.focus();
    }
  }, [autoFocus, submitting]);

  const submit = async (): Promise<void> => {
    if (guardRef.current || submitting || disabled) {
      return;
    }

    if (projectId.length === 0) {
      setError(GUARD_MESSAGE);
      return;
    }

    const value = title.trim();

    if (value.length === 0) {
      setError("Укажите название задачи");
      return;
    }

    guardRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const result = await onCreate(value);

      if (result.ok) {
        if (keepOpen) {
          setTitle("");
        } else {
          onSuccess?.();
          onCancel();
        }
      } else {
        setError(result.message);
      }
    } finally {
      guardRef.current = false;
      setSubmitting(false);
    }
  };

  const label = columnTitle ?? taskStatusLabel(status);

  return (
    <form
      aria-label={`Быстрое добавление задачи в колонку «${label}»`}
      data-testid={`${testIdPrefix}-form`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        name="title"
        data-testid={`${testIdPrefix}-input`}
        aria-label={`Название новой задачи в колонке «${label}»`}
        placeholder="Название задачи"
        value={title}
        disabled={submitting || disabled}
        onChange={(event) => {
          setTitle(event.target.value);
          setError(null);
          onTitleChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 xl:h-9"
      />

      {error === null ? null : (
        <p
          role="alert"
          data-testid={`${testIdPrefix}-error`}
          className="m-0 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="submit"
          data-testid={`${testIdPrefix}-submit`}
          disabled={disabled || submitting || title.trim().length === 0 || projectId.length === 0}
          aria-busy={submitting}
          className={`${actionButtonClass} gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90`}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {submitting ? "Добавление…" : submitLabel}
        </button>
        <button
          type="button"
          aria-label="Закрыть добавление карточки"
          onClick={onCancel}
          disabled={submitting}
          className={`${actionButtonClass} gap-1.5 border border-border bg-background text-foreground hover:bg-accent`}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </form>
  );
}
