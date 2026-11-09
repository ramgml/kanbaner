"use client";

import { useMemo } from "react";

import type { Project } from "@kanbaner/plugin-tasks/contract";
import { LoadingState } from "@kanbaner/task-ui";

export interface ProjectSwitcherProps {
  readonly projects: readonly Project[];
  readonly activeProjectId: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly onSelect: (projectId: string) => void;
  readonly testIdPrefix: string;
}

const SEARCH_THRESHOLD = 6;

/**
 * Список проектов с поиском и активным элементом.
 *
 * Используется и desktop sidebar, и mobile bottom sheet, поэтому оба пути
 * переключения показывают одинаковый набор проектов и доступны с клавиатуры.
 */
export function ProjectSwitcher({
  projects,
  activeProjectId,
  loading,
  error,
  search,
  onSearchChange,
  onSelect,
  testIdPrefix,
}: ProjectSwitcherProps) {
  const normalized = search.trim().toLocaleLowerCase("ru");
  const visible = useMemo(
    () =>
      normalized.length === 0
        ? projects
        : projects.filter((project) => project.title.toLocaleLowerCase("ru").includes(normalized)),
    [projects, normalized],
  );

  if (loading && projects.length === 0) {
    return <LoadingState label="Загрузка проектов…" />;
  }

  if (error !== null && projects.length === 0) {
    return (
      <p
        role="alert"
        data-testid={`${testIdPrefix}-error`}
        className="m-0 text-xs text-destructive"
      >
        Проекты: {error}
      </p>
    );
  }

  if (projects.length === 0) {
    return (
      <p
        data-testid={`${testIdPrefix}-empty`}
        className="m-0 rounded-md border border-dashed border-border px-2 py-2 text-xs text-muted-foreground"
      >
        Проектов пока нет. Создайте первый проект.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      {projects.length > SEARCH_THRESHOLD ? (
        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          Поиск проектов
          <input
            type="search"
            value={search}
            data-testid={`${testIdPrefix}-search`}
            aria-label="Поиск проектов"
            placeholder="Название проекта"
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </label>
      ) : null}

      {visible.length === 0 ? (
        <p
          role="status"
          data-testid={`${testIdPrefix}-no-results`}
          className="m-0 px-1 text-xs text-muted-foreground"
        >
          Ничего не найдено
        </p>
      ) : (
        <ul
          aria-label="Проекты"
          data-testid={`${testIdPrefix}-list`}
          className="m-0 flex max-h-64 list-none flex-col gap-0.5 overflow-y-auto p-0"
        >
          {visible.map((project) => {
            const active = project.id === activeProjectId;

            return (
              <li key={project.id}>
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-item-${project.id}`}
                  data-project-id={project.id}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    onSelect(project.id);
                  }}
                  className={`flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    active
                      ? "bg-secondary font-semibold text-secondary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-2 shrink-0 rounded-full ${
                      active ? "bg-primary" : "border border-border bg-background"
                    }`}
                  />
                  <span className="min-w-0 truncate">{project.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
