"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

import type { Task, TaskPriority, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import { taskPriorityLabel, taskStatusLabel, taskStatuses } from "@kanbaner/task-ui";

import { describeDue, type DueTone } from "./due.ts";

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

const DUE_STYLES: Readonly<
  Record<DueTone, { readonly background: string; readonly color: string }>
> = {
  overdue: {
    background: "color-mix(in oklab, var(--destructive) 14%, transparent)",
    color: "var(--destructive)",
  },
  today: {
    background: "color-mix(in oklab, #f59e0b 18%, transparent)",
    color: "#a16207",
  },
  tomorrow: {
    background: "color-mix(in oklab, #3b82f6 14%, transparent)",
    color: "#1d4ed8",
  },
  later: { background: "transparent", color: "var(--muted-foreground)" },
  none: { background: "transparent", color: "var(--muted-foreground)" },
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
 * Компактная карточка доски.
 *
 * Заголовок — главный элемент. Теги ограничены двумя видимыми + `+N`, срок
 * получает семантический тон (просрочено/сегодня/завтра/дата) и текстовое
 * описание, а pending/conflict занимают строку только пока актуальны.
 * Перемещение доступно тремя путями: drag handle, меню «Переместить в…» и
 * кнопки порядка, поэтому DnD не является единственным способом.
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
  const due = describeDue(task.dueAt);
  const dueStyle = DUE_STYLES[due.tone];
  const visibleTags = task.tags.slice(0, 2);
  const extraTags = task.tags.length - visibleTags.length;

  return (
    <article
      data-testid={`kanban-card-${task.id}`}
      data-card-id={task.id}
      aria-current={selected ? "true" : undefined}
      aria-busy={pending}
      className="flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-card-foreground transition-shadow"
      style={{
        borderColor: selected ? "var(--ring)" : "var(--border)",
        opacity: dragging || pending ? 0.62 : 1,
        boxShadow: selected ? "0 0 0 2px var(--ring)" : "0 1px 2px rgb(0 0 0 / 0.10)",
      }}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-label={`Открыть карточку задачи ${task.title}`}
          data-testid={`kanban-open-${task.id}`}
          onClick={() => {
            onOpen(task);
          }}
          className="flex min-h-10 min-w-0 flex-1 items-center rounded-sm text-left text-[13px] leading-snug font-semibold break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-7"
        >
          {task.title}
        </button>

        <details data-testid={`kanban-menu-${task.id}`} className="relative shrink-0">
          <summary
            aria-label={`Действия карточки ${task.title}`}
            title="Действия карточки"
            className="flex min-h-10 min-w-10 cursor-pointer list-none items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7 xl:min-w-7"
          >
            <span aria-hidden="true">⋯</span>
          </summary>
          <div
            role="group"
            aria-label={`Перемещение задачи ${task.title}`}
            className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-popover p-1 shadow-md"
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
                  className="min-h-10 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
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
              className="min-h-10 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
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
              className="min-h-10 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
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
              className="min-h-10 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
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
              className="min-h-10 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
              style={actionButtonStyle}
            >
              В конец
            </button>
          </div>
        </details>

        <button
          type="button"
          aria-label={`Перетащить задачу ${task.title}`}
          data-testid={`kanban-drag-${task.id}`}
          onPointerDown={(event) => {
            onDragStart(task, event);
          }}
          title="Перетащить карточку"
          className="flex min-h-10 min-w-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing xl:min-h-7 xl:min-w-7"
        >
          <span aria-hidden="true">⠿</span>
        </button>
      </div>

      {visibleTags.length === 0 ? null : (
        <ul aria-label="Теги" className="flex flex-wrap items-center gap-1">
          {visibleTags.map((tag) => (
            <li
              key={tag}
              className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground"
            >
              {tag}
            </li>
          ))}
          {extraTags > 0 ? (
            <li
              aria-label={`Ещё тегов: ${String(extraTags)}`}
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              +{extraTags}
            </li>
          ) : null}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span
          className="rounded-full px-1.5 py-0.5 font-semibold"
          style={{ background: priorityStyle.background, color: priorityStyle.color }}
        >
          {taskPriorityLabel(task.priority)}
        </span>

        <span
          data-testid={`kanban-due-${task.id}`}
          aria-label={due.ariaLabel}
          title={due.title}
          className="rounded px-1 py-0.5 font-medium"
          style={{ background: dueStyle.background, color: dueStyle.color }}
        >
          {due.label}
        </span>

        <span data-testid={`kanban-subtasks-${task.id}`} className="whitespace-nowrap">
          Подзадачи: {subtaskCount ?? "—"}
        </span>
      </div>

      {pending || conflict ? (
        <div className="flex flex-wrap items-center gap-1">
          {pending ? (
            <span
              role="status"
              data-testid={`kanban-pending-${task.id}`}
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              Сохранение…
            </span>
          ) : null}

          {conflict ? (
            <span
              role="alert"
              data-testid={`kanban-conflict-${task.id}`}
              className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive"
            >
              Конфликт версий
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
