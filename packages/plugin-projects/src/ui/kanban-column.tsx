"use client";

import type { ReactNode } from "react";

import type { TaskStatus } from "@kanbaner/plugin-tasks/contract";
import { LoadingState, taskStatusLabel } from "@kanbaner/task-ui";

export interface KanbanColumnProps {
  readonly status: TaskStatus;
  readonly total: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly dragOver: boolean;
  /** В колонку сейчас будет вставлена карточка (placeholder уже в children). */
  readonly dropActive: boolean;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  /** Быстрый composer сразу под заголовком, вне прокручиваемого списка. */
  readonly quickComposer: ReactNode;
  readonly children: ReactNode;
}

const secondaryButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-md border border-border bg-background/70 px-2 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

/** Колонка доски: заголовок, счётчик, composer и прокручиваемый список. */
export function KanbanColumn({
  status,
  total,
  loading,
  error,
  hasMore,
  dragOver,
  dropActive,
  onLoadMore,
  onRetry,
  quickComposer,
  children,
}: KanbanColumnProps) {
  return (
    <section
      id={`kanban-column-${status}`}
      data-testid={`kanban-column-${status}`}
      data-kanban-column={status}
      aria-labelledby={`kanban-column-title-${status}`}
      className="flex max-h-full min-h-0 w-[85vw] max-w-[272px] shrink-0 snap-start flex-col gap-2 rounded-xl border bg-[#f1f5f9] p-2.5 transition-colors md:w-auto md:max-w-none md:min-w-[272px] md:flex-1 dark:bg-[#263244]"
      style={{
        ...(dragOver
          ? { background: "color-mix(in oklab, var(--accent) 70%, var(--background))" }
          : {}),
        borderColor: dragOver ? "var(--ring)" : "var(--border)",
        boxShadow: dragOver ? "0 0 0 2px var(--ring)" : "none",
      }}
    >
      <header
        data-kanban-drop-zone="top"
        className="flex shrink-0 items-center justify-between gap-2 px-0.5"
      >
        <h2
          id={`kanban-column-title-${status}`}
          className="truncate text-sm font-semibold tracking-tight"
        >
          {taskStatusLabel(status)}
        </h2>
        <span
          data-testid={`kanban-count-${status}`}
          aria-label={`Задач в колонке: ${String(total)}`}
          className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground"
        >
          {total}
        </span>
      </header>

      {/*
        Composer идёт сразу под заголовком и вне прокручиваемого списка:
        кнопка создания остаётся на месте при любой длине колонки.
      */}
      <div
        data-testid={`kanban-quick-composer-${status}`}
        data-kanban-drop-zone="top"
        className="flex shrink-0 flex-col gap-1"
      >
        {quickComposer}
      </div>

      {error === null ? null : (
        <div
          role="alert"
          data-testid={`kanban-column-error-${status}`}
          className="flex shrink-0 flex-col gap-1 text-xs text-destructive"
        >
          <p className="m-0">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-10 w-fit rounded-md border border-destructive/40 px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive xl:min-h-8"
          >
            Повторить
          </button>
        </div>
      )}

      {loading && total === 0 ? (
        <LoadingState label={`Загрузка: ${taskStatusLabel(status)}`} />
      ) : null}

      <div
        data-testid={`kanban-column-scroll-${status}`}
        className="min-h-0 flex-1 overflow-y-auto pr-0.5"
      >
        {!loading && total === 0 && error === null && !dropActive ? (
          <div
            data-testid={`kanban-column-empty-${status}`}
            className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border bg-background/40 p-4 text-center"
          >
            <p className="m-0 text-xs font-medium">Пусто</p>
            <p className="m-0 text-[11px] text-muted-foreground">
              Перетащите задачу сюда или создайте новую.
            </p>
          </div>
        ) : null}

        <ol
          data-testid={`kanban-cards-${status}`}
          className="flex flex-col gap-2"
          style={{ margin: 0, padding: 0, listStyle: "none" }}
        >
          {children}
        </ol>

        {hasMore ? (
          <button
            type="button"
            data-testid={`kanban-load-more-${status}`}
            disabled={loading}
            onClick={onLoadMore}
            className={`${secondaryButtonClass} mt-2 w-full`}
          >
            Показать ещё
          </button>
        ) : null}
      </div>
    </section>
  );
}
