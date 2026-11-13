"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import { TASKS_COMMAND_IDS, type ProjectMutationOutput } from "@kanbaner/plugin-tasks/contract";
import {
  ProjectForm,
  useMediaQuery,
  type ProjectFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { errorMessage, invokeJson } from "./operations.ts";
import { ProjectSwitcher } from "./project-switcher.tsx";
import { useProjectsData } from "./use-projects.ts";
import {
  MOBILE_MEDIA_QUERY,
  bumpProjectsRevision,
  rememberProject,
  resolveProjectId,
  searchWithProject,
  useProjectCreateRequest,
  useWorkspaceView,
} from "./workspace.ts";

export interface ProjectSidebarProps {
  readonly invoke: UiOperationInvoker;
}

/**
 * Секция «Проекты» в `app.sidebar`.
 *
 * Показывается только когда смонтировано одно из представлений проектов:
 * настройки, plugin manager и обзор shell секцию не получают. Выбор меняет
 * `?project=` текущего представления без отдельного экрана.
 */
export function ProjectSidebar({ invoke }: ProjectSidebarProps) {
  const view = useWorkspaceView();

  if (view === null) {
    return null;
  }

  return <ProjectSidebarContent invoke={invoke} view={view} />;
}

function ProjectSidebarContent({
  invoke,
  view,
}: ProjectSidebarProps & {
  readonly view: NonNullable<ReturnType<typeof useWorkspaceView>>;
}) {
  const { projects, loading, error, reload } = useProjectsData(invoke);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const guardRef = useRef(false);
  const isMobileViewport = useMediaQuery(MOBILE_MEDIA_QUERY);
  const createRequest = useProjectCreateRequest();
  const lastCreateRequestRef = useRef(createRequest);

  useEffect(() => {
    if (createRequest === lastCreateRequestRef.current) {
      return;
    }

    lastCreateRequestRef.current = createRequest;

    // На мобильном форму открывает bottom sheet, иначе в скрытом sidebar
    // появился бы второй невидимый project-form.
    if (isMobileViewport) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFormError(null);
    setCreating(true);
  }, [createRequest, isMobileViewport]);

  useEffect(() => {
    if (loading || projects.length === 0 || view.projectId.length > 0) {
      return;
    }

    const resolved = resolveProjectId(projects, "", null);

    if (resolved !== null) {
      rememberProject(resolved);
      view.navigate(searchWithProject(view.search, resolved));
    }
  }, [loading, projects, view]);

  const select = (projectId: string): void => {
    rememberProject(projectId);
    view.navigate(searchWithProject(view.search, projectId));
  };

  const create = async (values: ProjectFormValues): Promise<void> => {
    if (guardRef.current) {
      return;
    }

    guardRef.current = true;
    setSubmitting(true);
    setFormError(null);

    try {
      const data = await invokeJson<ProjectMutationOutput>(
        invoke,
        TASKS_COMMAND_IDS.projectCreate,
        {
          title: values.title,
          descriptionMarkdown: values.descriptionMarkdown,
        } as unknown as JsonValue,
      );

      bumpProjectsRevision();
      await reload();
      rememberProject(data.project.id);
      view.navigate(searchWithProject(view.search, data.project.id));
      setCreating(false);
    } catch (commandError) {
      setFormError(errorMessage(commandError));
    } finally {
      guardRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section
      aria-labelledby="projects-sidebar-title"
      data-testid="projects-sidebar"
      data-active-project={view.projectId}
      className="flex min-h-0 flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="projects-sidebar-title"
          className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          Проекты
        </h2>
        <button
          type="button"
          data-testid="projects-create-button"
          aria-label="Создать проект"
          title="Создать проект"
          onClick={() => {
            setFormError(null);
            setCreating((current) => !current);
          }}
          className="flex size-8 items-center justify-center rounded-md border border-border bg-background text-base leading-none hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </div>

      {creating ? (
        <div data-testid="projects-create-panel">
          <ProjectForm
            submitting={submitting}
            error={formError}
            onSubmit={(values) => {
              void create(values);
            }}
            onCancel={() => {
              setCreating(false);
              setFormError(null);
            }}
          />
        </div>
      ) : null}

      <ProjectSwitcher
        projects={projects}
        activeProjectId={view.projectId}
        loading={loading}
        error={error}
        search={search}
        onSearchChange={setSearch}
        onSelect={select}
        testIdPrefix="projects-sidebar"
      />
    </section>
  );
}
