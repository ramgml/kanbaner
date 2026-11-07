import type { Project, Task } from "@kanbaner/plugin-tasks/contract";

import { formatDueAt, taskPriorityLabel, taskStatusLabel } from "../format.ts";
import { TaskCard } from "./task-card.tsx";

export interface TaskTableProps {
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly selectedTaskId?: string | null;
  readonly onSelect: (task: Task) => void;
  readonly className?: string;
}

function projectTitle(projects: readonly Project[], projectId: string): string {
  return projects.find((project) => project.id === projectId)?.title ?? "—";
}

function Tags({ tags }: { readonly tags: readonly string[] }) {
  if (tags.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <ul aria-label="Теги" className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <li
          key={tag}
          className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}

/**
 * Адаптивный список: таблица на десктопе и карточки на узких экранах.
 * Обе раскладки используют один и тот же набор задач и доступны с клавиатуры.
 */
export function TaskTable({
  tasks,
  projects,
  selectedTaskId = null,
  onSelect,
  className = "",
}: TaskTableProps) {
  return (
    <div className={className}>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <table data-testid="task-table" className="w-full text-sm">
          <caption className="sr-only">Список задач</caption>
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Название
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Проект
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Статус
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Приоритет
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Срок
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Теги
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const selected = task.id === selectedTaskId;

              return (
                <tr
                  key={task.id}
                  data-testid={`task-row-${task.id}`}
                  aria-selected={selected}
                  className={`border-t align-top ${selected ? "bg-accent/60" : ""}`}
                >
                  <th scope="row" className="min-w-48 px-3 py-2 text-left font-medium">
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(task);
                      }}
                      className="rounded-md text-left break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      aria-label={`Открыть задачу ${task.title}`}
                    >
                      {task.title}
                    </button>
                  </th>
                  <td className="px-3 py-2">{projectTitle(projects, task.projectId)}</td>
                  <td className="px-3 py-2">{taskStatusLabel(task.status)}</td>
                  <td className="px-3 py-2">{taskPriorityLabel(task.priority)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDueAt(task.dueAt)}</td>
                  <td className="px-3 py-2">
                    <Tags tags={task.tags} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul
        data-testid="task-cards"
        aria-label="Карточки задач"
        className="flex flex-col gap-2 md:hidden"
      >
        {tasks.map((task) => (
          <li key={task.id}>
            <TaskCard
              task={task}
              project={projects.find((project) => project.id === task.projectId) ?? null}
              selected={task.id === selectedTaskId}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
