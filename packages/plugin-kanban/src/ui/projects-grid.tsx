"use client";

import type {
  ProjectSummary,
  ProjectSummaryTotals,
  TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import { TASK_STATUSES } from "@kanbaner/plugin-tasks/contract";
import { taskStatusLabel } from "@kanbaner/task-ui";

/** Маршрут списка задач: второй путь открытия проекта. */
const TASK_LIST_ROUTE = "/view/tasks";

export interface ProjectsGridProps {
  readonly items: readonly ProjectSummary[];
  readonly totals: ProjectSummaryTotals | null;
  readonly totalProjects: number;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly onCreateProject: () => void;
  readonly onOpenBoard: (projectId: string) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}

function listHref(projectId: string): string {
  return `${TASK_LIST_ROUTE}?project=${encodeURIComponent(projectId)}`;
}

function Counts({
  summary,
  testIdPrefix,
}: {
  readonly summary: ProjectSummary | ProjectSummaryTotals;
  readonly testIdPrefix: string;
}) {
  const counts = summary.counts;

  return (
    <dl
      data-testid={`${testIdPrefix}-counts`}
      aria-label="Счётчики задач по статусам"
      className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4"
    >
      {TASK_STATUSES.map((status: TaskStatus) => (
        <div key={status} className="flex min-w-0 flex-col">
          <dt className="order-2 truncate text-[11px] text-muted-foreground">
            {taskStatusLabel(status)}
          </dt>
          <dd
            data-testid={`${testIdPrefix}-count-${status}`}
            className="order-1 m-0 text-base font-semibold tabular-nums"
          >
            {counts[status]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Сетка проектов как досок.
 *
 * Компонент не выполняет запросов: точные сводки приходят из
 * `kanbaner.tasks.project.summary`, а действия делегируются `KanbanView`.
 * Карточка — основная кнопка открытия доски; второй путь (`Открыть список`)
 * ведёт на `/view/tasks?project=<id>`.
 */
export function ProjectsGrid({
  items,
  totals,
  totalProjects,
  loading,
  loadingMore,
  error,
  hasMore,
  onCreateProject,
  onOpenBoard,
  onLoadMore,
  onRetry,
}: ProjectsGridProps) {
  if (loading && items.length === 0) {
    return (
      <p data-testid="kanban-projects-loading" role="status" className="m-0 text-sm">
        Загрузка проектов…
      </p>
    );
  }

  if (error !== null && items.length === 0) {
    return (
      <div
        data-testid="kanban-projects-error"
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive"
      >
        <span>Проекты: {error}</span>
        <button
          type="button"
          data-testid="kanban-projects-retry"
          onClick={onRetry}
          className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
        >
          Повторить
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        data-testid="kanban-projects-empty"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-background/70 px-4 py-4"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="m-0 text-sm font-medium">Пока нет проектов</p>
          <p className="m-0 text-xs text-muted-foreground">
            Создайте первый проект, чтобы увидеть его доску и сводку.
          </p>
        </div>
        <button
          type="button"
          data-testid="kanban-projects-create-first"
          onClick={onCreateProject}
          className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
        >
          Создать первый проект
        </button>
      </div>
    );
  }

  return (
    <section
      data-testid="kanban-projects"
      aria-label="Проекты"
      className="flex min-h-0 flex-col gap-3"
    >
      {totals === null ? null : (
        <div
          data-testid="kanban-projects-totals"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground"
        >
          <span>
            Всего задач:{" "}
            <strong data-testid="kanban-projects-total" className="text-sm text-foreground">
              {totals.total}
            </strong>
          </span>
          <span>
            Просрочено:{" "}
            <strong
              data-testid="kanban-projects-overdue"
              className={
                totals.overdueCount > 0 ? "text-sm text-destructive" : "text-sm text-foreground"
              }
            >
              {totals.overdueCount}
            </strong>
          </span>
        </div>
      )}

      <ul
        data-testid="kanban-projects-grid"
        className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3"
      >
        {items.map((summary) => {
          const { project } = summary;

          return (
            <li key={project.id} className="min-w-0">
              <article
                data-testid={`kanban-project-card-${project.id}`}
                data-project-id={project.id}
                className="flex h-full flex-col gap-2 rounded-xl border border-border/70 bg-background p-3 shadow-sm"
              >
                <button
                  type="button"
                  data-testid={`kanban-project-open-${project.id}`}
                  aria-label={`Открыть доску проекта «${project.title}»`}
                  onClick={() => {
                    onOpenBoard(project.id);
                  }}
                  className="flex min-h-10 flex-col gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="text-sm font-semibold break-words">{project.title}</span>
                  {project.descriptionMarkdown.trim().length === 0 ? null : (
                    <span className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
                      {project.descriptionMarkdown}
                    </span>
                  )}
                  <span className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
                    <span>
                      Задач:{" "}
                      <strong
                        data-testid={`kanban-project-total-${project.id}`}
                        className="text-foreground tabular-nums"
                      >
                        {summary.total}
                      </strong>
                    </span>
                    <span
                      data-testid={`kanban-project-overdue-${project.id}`}
                      className={
                        summary.overdueCount > 0
                          ? "font-medium text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      Просрочено: {summary.overdueCount}
                    </span>
                  </span>
                  <Counts summary={summary} testIdPrefix={`kanban-project-${project.id}`} />
                </button>

                <a
                  data-testid={`kanban-project-list-${project.id}`}
                  href={listHref(project.id)}
                  className="inline-flex min-h-10 w-fit items-center rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
                >
                  Открыть список
                </a>
              </article>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Показано {items.length} из {totalProjects}
        </span>
        {hasMore ? (
          <button
            type="button"
            data-testid="kanban-projects-load-more"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={onLoadMore}
            className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8"
          >
            {loadingMore ? "Загрузка…" : "Показать ещё"}
          </button>
        ) : null}
      </div>

      {error === null ? null : (
        <p
          role="alert"
          data-testid="kanban-projects-inline-error"
          className="m-0 text-xs text-destructive"
        >
          Проекты: {error}
        </p>
      )}
    </section>
  );
}
