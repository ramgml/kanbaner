"use client";

import type { ReactNode } from "react";

import type { TaskStatus } from "@kanbaner/plugin-tasks/contract";
import { EmptyState, LoadingState, taskStatusLabel } from "@kanbaner/task-ui";

export interface KanbanColumnProps {
  readonly status: TaskStatus;
  readonly total: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly dragOver: boolean;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}

/** Колонка доски: заголовок, счётчик, состояние загрузки и догрузка. */
export function KanbanColumn({
  status,
  total,
  loading,
  error,
  hasMore,
  dragOver,
  onLoadMore,
  onRetry,
  children,
}: KanbanColumnProps) {
  return (
    <section
      data-testid={`kanban-column-${status}`}
      data-kanban-column={status}
      aria-labelledby={`kanban-column-title-${status}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        flex: "0 0 264px",
        width: "264px",
        minWidth: "264px",
        border: dragOver ? "2px solid var(--ring)" : "1px solid var(--border)",
        background: "var(--muted)",
        borderRadius: "12px",
        padding: "10px",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <h2
          id={`kanban-column-title-${status}`}
          style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}
        >
          {taskStatusLabel(status)}
        </h2>
        <span
          data-testid={`kanban-count-${status}`}
          aria-label={`Задач в колонке: ${String(total)}`}
          style={{
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: "999px",
            padding: "0 8px",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          {total}
        </span>
      </header>

      {error === null ? null : (
        <div
          role="alert"
          data-testid={`kanban-column-error-${status}`}
          style={{ fontSize: "12px", color: "var(--destructive)" }}
        >
          <p style={{ margin: "0 0 4px" }}>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            style={{
              border: "1px solid var(--destructive)",
              background: "transparent",
              color: "var(--destructive)",
              borderRadius: "6px",
              padding: "2px 8px",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            Повторить
          </button>
        </div>
      )}

      {loading && total === 0 ? (
        <LoadingState label={`Загрузка: ${taskStatusLabel(status)}`} />
      ) : null}

      {!loading && total === 0 && error === null ? (
        <EmptyState
          title="Пусто"
          description={`В колонке «${taskStatusLabel(status)}» нет задач.`}
        />
      ) : null}

      {total === 0 ? null : (
        <ol
          data-testid={`kanban-cards-${status}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            margin: 0,
            padding: 0,
            listStyle: "none",
          }}
        >
          {children}
        </ol>
      )}

      {hasMore ? (
        <button
          type="button"
          data-testid={`kanban-load-more-${status}`}
          disabled={loading}
          onClick={onLoadMore}
          style={{
            border: "1px solid var(--border)",
            background: "var(--background)",
            color: "var(--foreground)",
            borderRadius: "6px",
            padding: "4px 8px",
            fontSize: "12px",
            cursor: "pointer",
          }}
        >
          Показать ещё
        </button>
      ) : null}
    </section>
  );
}
