"use client";

import {
  TASK_STATUSES,
  type Project,
  type ProjectSummary,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import { taskStatusLabel } from "@kanbaner/task-ui";

import {
  KANBAN_ROUTE,
  PROJECTS_OVERVIEW_ROUTE,
  TASK_LIST_ROUTE,
  type ProjectRoute,
} from "../metadata.ts";
import { rememberProjectView } from "./workspace.ts";

export type ProjectHeaderVariant = "kanban" | "list" | "overview";

export interface ProjectHeaderProps {
  readonly variant: ProjectHeaderVariant;
  readonly route: ProjectRoute;
  readonly project: Project | null;
  readonly summary: ProjectSummary | null;
  readonly search: string;
  readonly fallbackTitle: string;
  readonly actions?: React.ReactNode;
}

function withSearch(pathname: string, search: string): string {
  const normalized = search.startsWith("?") ? search : search.length === 0 ? "" : `?${search}`;

  return `${pathname}${normalized}`;
}

const toggleClass = (active: boolean): string =>
  `inline-flex min-h-10 items-center px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8 ${
    active ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"
  }`;

/**
 * Заголовок проекта с переключателем `Список / Канбан`.
 *
 * Оба представления получают project, tag и остальные query-параметры из
 * текущего адреса. Переключение — настоящая навигация, поэтому выбранная
 * карточка и фильтры не теряются.
 */
export function ProjectHeader({
  variant,
  route,
  project,
  summary,
  search,
  fallbackTitle,
  actions,
}: ProjectHeaderProps) {
  const counts = summary?.counts ?? null;
  const titleId = `project-header-title-${variant}`;
  const description = project?.descriptionMarkdown.trim() ?? "";

  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1
          id={titleId}
          data-testid={variant === "kanban" ? "kanban-board-title" : "project-board-title"}
          className="m-0 truncate text-xl font-semibold tracking-tight sm:text-2xl"
        >
          {project?.title ?? fallbackTitle}
        </h1>

        {description.length > 0 ? (
          <p
            data-testid={
              variant === "kanban" ? "kanban-board-description" : "project-board-description"
            }
            className="m-0 max-w-2xl text-xs whitespace-pre-wrap text-muted-foreground sm:text-sm"
          >
            {description}
          </p>
        ) : null}

        {summary === null ? null : (
          <dl
            data-testid={variant === "kanban" ? "kanban-board-summary" : "project-board-summary"}
            aria-label="Сводка задач"
            className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground"
          >
            <div className="flex items-baseline gap-1">
              <dt>Всего:</dt>
              <dd
                data-testid={
                  variant === "kanban" ? "kanban-summary-total" : "project-summary-total"
                }
                className="m-0 font-semibold text-foreground"
              >
                {summary.total}
              </dd>
            </div>
            {TASK_STATUSES.map((status: TaskStatus) => (
              <div key={status} className="flex items-baseline gap-1">
                <dt>{taskStatusLabel(status)}:</dt>
                <dd
                  data-testid={
                    variant === "kanban" ? `kanban-summary-${status}` : `project-summary-${status}`
                  }
                  className="m-0 font-semibold text-foreground"
                >
                  {counts?.[status] ?? 0}
                </dd>
              </div>
            ))}
            <div className="flex items-baseline gap-1">
              <dt>Просрочено:</dt>
              <dd
                data-testid={
                  variant === "kanban" ? "kanban-summary-overdue" : "project-summary-overdue"
                }
                className={
                  summary.overdueCount > 0
                    ? "m-0 font-semibold text-destructive"
                    : "m-0 font-semibold text-foreground"
                }
              >
                {summary.overdueCount}
              </dd>
            </div>
          </dl>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {route === PROJECTS_OVERVIEW_ROUTE ? null : (
          <div
            role="group"
            aria-label="Представление проекта"
            className="inline-flex overflow-hidden rounded-md border border-border"
          >
            <a
              href={withSearch(TASK_LIST_ROUTE, search)}
              data-testid="project-view-list"
              aria-current={route === TASK_LIST_ROUTE ? "page" : undefined}
              onClick={() => {
                rememberProjectView(TASK_LIST_ROUTE);
              }}
              className={toggleClass(route === TASK_LIST_ROUTE)}
            >
              Список
            </a>
            <a
              href={withSearch(KANBAN_ROUTE, search)}
              data-testid="project-view-kanban"
              aria-current={route === KANBAN_ROUTE ? "page" : undefined}
              onClick={() => {
                rememberProjectView(KANBAN_ROUTE);
              }}
              className={`${toggleClass(route === KANBAN_ROUTE)} border-l border-border`}
            >
              Канбан
            </a>
          </div>
        )}

        {actions}
      </div>
    </header>
  );
}
