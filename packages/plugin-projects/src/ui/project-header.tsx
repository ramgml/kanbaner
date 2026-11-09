"use client";

import {
  TASK_STATUSES,
  type Project,
  type ProjectSummary,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import { taskStatusLabel, type UiOperationInvoker } from "@kanbaner/task-ui";

import { PROJECTS_OVERVIEW_ROUTE, type ProjectRoute } from "../metadata.ts";
import { ProjectRenameButton } from "./project-rename.tsx";
import { ViewToggle } from "./view-toggle.tsx";

export type ProjectHeaderVariant = "kanban" | "list" | "overview";

export interface ProjectHeaderProps {
  readonly variant: ProjectHeaderVariant;
  readonly route: ProjectRoute;
  readonly project: Project | null;
  readonly summary: ProjectSummary | null;
  readonly search: string;
  readonly fallbackTitle: string;
  /** Инвокер для действия «Переименовать»; обзор без проекта его не получает. */
  readonly invoke?: UiOperationInvoker | undefined;
  /** Уведомляет представление об успешном переименовании. */
  readonly onProjectRenamed?: (() => void) | undefined;
  readonly actions?: React.ReactNode;
}

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
  invoke,
  onProjectRenamed,
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
        {project === null || invoke === undefined ? null : (
          <ProjectRenameButton invoke={invoke} project={project} onRenamed={onProjectRenamed} />
        )}

        {route === PROJECTS_OVERVIEW_ROUTE ? null : <ViewToggle route={route} search={search} />}

        {actions}
      </div>
    </header>
  );
}
