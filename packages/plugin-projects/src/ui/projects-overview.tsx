"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_QUERY_IDS,
  TASK_STATUSES,
  type ProjectSummary,
  type ProjectSummaryOutput,
  type ProjectSummaryTotals,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import {
  ErrorState,
  LoadingState,
  taskStatusLabel,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { KANBAN_ROUTE, PROJECTS_OVERVIEW_ROUTE, TASK_LIST_ROUTE } from "../metadata.ts";
import { ProjectHeader } from "./project-header.tsx";
import { invokeJson } from "./operations.ts";
import { useProjectsData } from "./use-projects.ts";
import {
  readLastProjectId,
  registerWorkspaceView,
  rememberProject,
  rememberProjectView,
  resolveProjectId,
  useProjectsRevision,
} from "./workspace.ts";

/** Стабильный размер страницы обзора: те же проекты, что и на доске. */
const OVERVIEW_PAGE_SIZE = 12;

const secondaryButton =
  "inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8";

function boardHref(projectId: string): string {
  return `${KANBAN_ROUTE}?project=${encodeURIComponent(projectId)}`;
}

function listHref(projectId: string): string {
  return `${TASK_LIST_ROUTE}?project=${encodeURIComponent(projectId)}`;
}

function projectIdFromSearch(search: string): string {
  return (
    new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("project")?.trim() ??
    ""
  );
}

function countsOf(summary: ProjectSummary): Record<TaskStatus, number> {
  return summary.counts;
}

/**
 * Необязательный обзор всех проектов.
 *
 * Экран не является обязательным путём переключения: проекты выбираются в
 * sidebar, а карточка обзора открывает доску или список конкретного проекта.
 * Сводки читаются публичным `kanbaner.tasks.project.summary`.
 */
export function ProjectsOverview({
  invoke,
  search,
  replaceSearch,
}: {
  readonly invoke: UiOperationInvoker;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
}) {
  const revision = useProjectsRevision();
  const { projects, loading: projectsLoading } = useProjectsData(invoke);
  const [items, setItems] = useState<readonly ProjectSummary[]>([]);
  const [totals, setTotals] = useState<ProjectSummaryTotals | null>(null);
  const [totalProjects, setTotalProjects] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialSearch = search ?? "";
  const [localSearch, setLocalSearch] = useState(initialSearch);
  const [lastSearch, setLastSearch] = useState(initialSearch);
  const sequenceRef = useRef(0);

  if (lastSearch !== initialSearch) {
    setLastSearch(initialSearch);
    setLocalSearch(initialSearch);
  }

  const navigate = useCallback(
    (next: string): void => {
      setLocalSearch(next);

      if (replaceSearch !== undefined) {
        replaceSearch(next);

        return;
      }

      if (typeof window !== "undefined") {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${next.length === 0 ? "" : next}`,
        );
      }
    },
    [replaceSearch],
  );

  const requestedProjectId = projectIdFromSearch(localSearch);
  const effectiveProjectId = useMemo(() => {
    if (projectsLoading) {
      return requestedProjectId;
    }

    return resolveProjectId(projects, requestedProjectId, readLastProjectId()) ?? "";
  }, [projects, projectsLoading, requestedProjectId]);

  useEffect(
    () =>
      registerWorkspaceView({
        route: PROJECTS_OVERVIEW_ROUTE,
        projectId: effectiveProjectId,
        search: localSearch,
        navigate,
      }),
    [effectiveProjectId, localSearch, navigate],
  );

  useEffect(() => {
    if (effectiveProjectId.length > 0) {
      rememberProject(effectiveProjectId);
    }
  }, [effectiveProjectId]);

  const load = useCallback(
    async (offset: number): Promise<void> => {
      const sequence = sequenceRef.current + 1;

      sequenceRef.current = sequence;

      if (offset === 0) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }

      try {
        const data = await invokeJson<ProjectSummaryOutput>(
          invoke,
          TASKS_QUERY_IDS.projectSummary,
          { limit: OVERVIEW_PAGE_SIZE, offset } as unknown as JsonValue,
        );

        if (sequenceRef.current !== sequence) {
          return;
        }

        setItems((current) => (offset === 0 ? data.items : [...current, ...data.items]));
        setTotals(data.totals);
        setTotalProjects(data.total);
        setNextOffset(data.nextOffset);
        setError(null);
      } catch (loadError) {
        if (sequenceRef.current === sequence) {
          setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить проекты");
        }
      } finally {
        if (sequenceRef.current === sequence) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [invoke],
  );

  useEffect(() => {
    // Загрузка первой страницы обзора: setLoading внутри load синхронный,
    // поэтому правило отключено осознанно.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(0);
  }, [load, revision]);

  return (
    <div data-testid="projects-overview" className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <ProjectHeader
        variant="overview"
        route={PROJECTS_OVERVIEW_ROUTE}
        project={null}
        summary={null}
        search={localSearch}
        fallbackTitle="Проекты"
      />

      {totals === null ? null : (
        <dl
          data-testid="projects-overview-totals"
          aria-label="Сводка по всем проектам"
          className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground"
        >
          <div className="flex items-baseline gap-1">
            <dt>Всего задач:</dt>
            <dd
              data-testid="projects-overview-total-tasks"
              className="m-0 font-semibold text-foreground"
            >
              {totals.total}
            </dd>
          </div>
          <div className="flex items-baseline gap-1">
            <dt>Просрочено:</dt>
            <dd
              data-testid="projects-overview-overdue"
              className={
                totals.overdueCount > 0
                  ? "m-0 font-semibold text-destructive"
                  : "m-0 font-semibold text-foreground"
              }
            >
              {totals.overdueCount}
            </dd>
          </div>
        </dl>
      )}

      {loading && items.length === 0 ? <LoadingState label="Загрузка проектов…" /> : null}

      {error !== null && items.length === 0 ? (
        <ErrorState
          message={`Проекты: ${error}`}
          onRetry={() => {
            void load(0);
          }}
        />
      ) : null}

      {!loading && error === null && items.length === 0 ? (
        <div
          data-testid="projects-overview-empty"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-background/70 px-4 py-4"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="m-0 text-sm font-medium">Пока нет проектов</p>
            <p className="m-0 text-xs text-muted-foreground">
              Создайте первый проект кнопкой «+» в разделе «Проекты».
            </p>
          </div>
        </div>
      ) : null}

      {items.length === 0 ? null : (
        <ul
          data-testid="projects-overview-grid"
          className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3"
        >
          {items.map((summary) => {
            const { project } = summary;
            const active = project.id === effectiveProjectId;

            return (
              <li key={project.id} className="min-w-0">
                <article
                  data-testid={`projects-overview-card-${project.id}`}
                  data-project-id={project.id}
                  aria-current={active ? "true" : undefined}
                  className={`flex h-full flex-col gap-2 rounded-xl border p-3 shadow-sm ${
                    active ? "border-primary bg-secondary/40" : "border-border/70 bg-background"
                  }`}
                >
                  <a
                    data-testid={`projects-overview-open-${project.id}`}
                    href={boardHref(project.id)}
                    aria-label={`Открыть доску проекта «${project.title}»`}
                    onClick={() => {
                      rememberProject(project.id);
                      rememberProjectView(KANBAN_ROUTE);
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
                          data-testid={`projects-overview-total-${project.id}`}
                          className="text-foreground tabular-nums"
                        >
                          {summary.total}
                        </strong>
                      </span>
                      <span
                        data-testid={`projects-overview-overdue-${project.id}`}
                        className={
                          summary.overdueCount > 0
                            ? "font-medium text-destructive"
                            : "text-muted-foreground"
                        }
                      >
                        Просрочено: {summary.overdueCount}
                      </span>
                    </span>
                    <dl
                      data-testid={`projects-overview-counts-${project.id}`}
                      aria-label="Счётчики задач по статусам"
                      className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-xs"
                    >
                      {TASK_STATUSES.map((status) => (
                        <div key={status} className="flex items-baseline gap-1">
                          <dt className="text-[11px] text-muted-foreground">
                            {taskStatusLabel(status)}:
                          </dt>
                          <dd
                            data-testid={`projects-overview-count-${project.id}-${status}`}
                            className="m-0 font-semibold tabular-nums"
                          >
                            {countsOf(summary)[status]}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </a>

                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      data-testid={`projects-overview-board-${project.id}`}
                      href={boardHref(project.id)}
                      onClick={() => {
                        rememberProject(project.id);
                        rememberProjectView(KANBAN_ROUTE);
                      }}
                      className={secondaryButton}
                    >
                      Открыть доску
                    </a>
                    <a
                      data-testid={`projects-overview-list-${project.id}`}
                      href={listHref(project.id)}
                      onClick={() => {
                        rememberProject(project.id);
                        rememberProjectView(TASK_LIST_ROUTE);
                      }}
                      className={secondaryButton}
                    >
                      Открыть список
                    </a>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Показано {items.length} из {totalProjects}
        </span>
        {nextOffset === null ? null : (
          <button
            type="button"
            data-testid="projects-overview-load-more"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={() => {
              void load(nextOffset);
            }}
            className={secondaryButton}
          >
            {loadingMore ? "Загрузка…" : "Показать ещё"}
          </button>
        )}
      </div>

      {error === null || items.length === 0 ? null : (
        <p role="alert" className="m-0 text-xs text-destructive">
          Проекты: {error}
        </p>
      )}
    </div>
  );
}
