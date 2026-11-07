import type { ReactNode } from "react";

import type { Project, Task } from "@kanbaner/plugin-tasks/contract";

import { formatDueAt, taskPriorityLabel, taskStatusLabel } from "../format.ts";

export interface TaskCardProps {
  readonly task: Task;
  readonly project: Project | null;
  readonly selected?: boolean;
  readonly onSelect: (task: Task) => void;
}

function MetaRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** Мобильная карточка задачи. */
export function TaskCard({ task, project, selected = false, onSelect }: TaskCardProps) {
  return (
    <article
      data-testid={`task-card-${task.id}`}
      aria-current={selected ? "true" : undefined}
      className={`rounded-lg border bg-card p-3 text-card-foreground shadow-sm ${
        selected ? "border-primary ring-1 ring-primary" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => {
          onSelect(task);
        }}
        className="w-full rounded-md text-left text-base font-semibold break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`Открыть карточку задачи ${task.title}`}
      >
        {task.title}
      </button>

      <dl className="mt-2 flex flex-col gap-1">
        <MetaRow label="Проект">{project?.title ?? "—"}</MetaRow>
        <MetaRow label="Статус">{taskStatusLabel(task.status)}</MetaRow>
        <MetaRow label="Приоритет">{taskPriorityLabel(task.priority)}</MetaRow>
        <MetaRow label="Срок">{formatDueAt(task.dueAt)}</MetaRow>
      </dl>

      {task.tags.length === 0 ? null : (
        <ul aria-label="Теги" className="mt-2 flex flex-wrap gap-1">
          {task.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
