"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

import type { Task, TaskPriority, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import { formatDueAt, taskPriorityLabel, taskStatusLabel, taskStatuses } from "@kanbaner/task-ui";

export type KanbanReorderKind = "up" | "down" | "start" | "end";

const PRIORITY_STYLES: Readonly<
  Record<TaskPriority, { readonly background: string; readonly color: string }>
> = {
  low: { background: "var(--muted)", color: "var(--muted-foreground)" },
  medium: { background: "var(--secondary)", color: "var(--secondary-foreground)" },
  high: {
    background: "color-mix(in oklab, var(--destructive) 18%, transparent)",
    color: "var(--destructive)",
  },
};

const actionButtonStyle = {
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  borderRadius: "6px",
  padding: "4px 8px",
  fontSize: "12px",
  cursor: "pointer",
} as const;

export interface KanbanCardProps {
  readonly task: Task;
  readonly index: number;
  readonly columnSize: number;
  /** `null` — счётчик неизвестен из-за ошибки запроса, а не реальный ноль. */
  readonly subtaskCount: number | null;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly conflict: boolean;
  readonly dragging: boolean;
  readonly onOpen: (task: Task) => void;
  readonly onMoveTo: (task: Task, status: TaskStatus) => void;
  readonly onReorder: (task: Task, kind: KanbanReorderKind) => void;
  readonly onDragStart: (task: Task, event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Карточка доски.
 *
 * Перемещение доступно тремя путями: drag handle, меню «Переместить в…» и
 * кнопки порядка. Меню и кнопки работают с клавиатуры и на мобильных, поэтому
 * DnD не является единственным способом изменить статус или позицию.
 */
export function KanbanCard({
  task,
  index,
  columnSize,
  subtaskCount,
  selected,
  pending,
  conflict,
  dragging,
  onOpen,
  onMoveTo,
  onReorder,
  onDragStart,
}: KanbanCardProps) {
  const priorityStyle = PRIORITY_STYLES[task.priority];

  return (
    <article
      data-testid={`kanban-card-${task.id}`}
      data-card-id={task.id}
      aria-current={selected ? "true" : undefined}
      aria-busy={pending}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        border: selected ? "1px solid var(--ring)" : "1px solid var(--border)",
        background: "var(--card)",
        color: "var(--card-foreground)",
        borderRadius: "10px",
        padding: "10px",
        opacity: dragging || pending ? 0.6 : 1,
        boxShadow: selected ? "0 0 0 2px var(--ring)" : "0 1px 2px rgb(0 0 0 / 0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "6px" }}>
        <button
          type="button"
          aria-label={`Открыть карточку задачи ${task.title}`}
          data-testid={`kanban-open-${task.id}`}
          onClick={() => {
            onOpen(task);
          }}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            border: "none",
            background: "transparent",
            color: "inherit",
            padding: 0,
            textAlign: "left",
            fontSize: "14px",
            fontWeight: 600,
            lineHeight: 1.3,
            overflowWrap: "anywhere",
            cursor: "pointer",
          }}
        >
          {task.title}
        </button>

        <button
          type="button"
          aria-label={`Перетащить задачу ${task.title}`}
          data-testid={`kanban-drag-${task.id}`}
          onPointerDown={(event) => {
            onDragStart(task, event);
          }}
          title="Перетащить карточку"
          style={{
            flex: "0 0 auto",
            border: "1px solid var(--border)",
            background: "var(--background)",
            color: "var(--muted-foreground)",
            borderRadius: "6px",
            padding: "2px 6px",
            fontSize: "12px",
            lineHeight: 1,
            cursor: "grab",
            touchAction: "none",
          }}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
        <span
          style={{
            background: priorityStyle.background,
            color: priorityStyle.color,
            borderRadius: "999px",
            padding: "1px 8px",
            fontSize: "11px",
            fontWeight: 600,
          }}
        >
          {taskPriorityLabel(task.priority)}
        </span>
        <span style={{ fontSize: "11px", color: "var(--muted-foreground)" }}>
          {formatDueAt(task.dueAt)}
        </span>
      </div>

      {task.tags.length === 0 ? null : (
        <ul
          aria-label="Теги"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px",
            margin: 0,
            padding: 0,
            listStyle: "none",
          }}
        >
          {task.tags.map((tag) => (
            <li
              key={tag}
              style={{
                background: "var(--secondary)",
                color: "var(--secondary-foreground)",
                borderRadius: "4px",
                padding: "1px 5px",
                fontSize: "11px",
              }}
            >
              {tag}
            </li>
          ))}
        </ul>
      )}

      <p
        data-testid={`kanban-subtasks-${task.id}`}
        style={{ margin: 0, fontSize: "11px", color: "var(--muted-foreground)" }}
      >
        Подзадачи: {subtaskCount ?? "—"}
      </p>

      {pending ? (
        <p
          role="status"
          data-testid={`kanban-pending-${task.id}`}
          style={{ margin: 0, fontSize: "11px", color: "var(--muted-foreground)" }}
        >
          Сохранение…
        </p>
      ) : null}

      {conflict ? (
        <p
          role="alert"
          data-testid={`kanban-conflict-${task.id}`}
          style={{ margin: 0, fontSize: "11px", color: "var(--destructive)" }}
        >
          Конфликт версий
        </p>
      ) : null}

      <details data-testid={`kanban-menu-${task.id}`} style={{ fontSize: "12px" }}>
        <summary
          aria-label={`Действия карточки ${task.title}`}
          style={{
            cursor: "pointer",
            color: "var(--muted-foreground)",
            width: "fit-content",
          }}
        >
          Действия
        </summary>
        <div
          role="group"
          aria-label={`Перемещение задачи ${task.title}`}
          style={{ display: "flex", flexWrap: "wrap", gap: "4px", paddingTop: "6px" }}
        >
          {taskStatuses()
            .filter((status) => status !== task.status)
            .map((status) => (
              <button
                key={status}
                type="button"
                disabled={pending}
                onClick={() => {
                  onMoveTo(task, status);
                }}
                style={actionButtonStyle}
              >
                Переместить в {taskStatusLabel(status)}
              </button>
            ))}

          <button
            type="button"
            disabled={pending || index === 0}
            onClick={() => {
              onReorder(task, "up");
            }}
            style={actionButtonStyle}
          >
            Выше
          </button>
          <button
            type="button"
            disabled={pending || index >= columnSize - 1}
            onClick={() => {
              onReorder(task, "down");
            }}
            style={actionButtonStyle}
          >
            Ниже
          </button>
          <button
            type="button"
            disabled={pending || index === 0}
            onClick={() => {
              onReorder(task, "start");
            }}
            style={actionButtonStyle}
          >
            В начало
          </button>
          <button
            type="button"
            disabled={pending || index >= columnSize - 1}
            onClick={() => {
              onReorder(task, "end");
            }}
            style={actionButtonStyle}
          >
            В конец
          </button>
        </div>
      </details>
    </article>
  );
}
