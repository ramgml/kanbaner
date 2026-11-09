"use client";

import { useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import { TASKS_COMMAND_IDS, type ProjectMutationOutput } from "@kanbaner/plugin-tasks/contract";
import {
  ModalDialog,
  ProjectForm,
  type ProjectFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { errorMessage, invokeJson } from "./operations.ts";
import { ProjectSwitcher } from "./project-switcher.tsx";
import { useProjectsData } from "./use-projects.ts";
import {
  bumpProjectsRevision,
  rememberProject,
  searchWithProject,
  useWorkspaceView,
} from "./workspace.ts";

/**
 * Мобильная точка входа в список проектов.
 *
 * Shell-навигация не содержит доменных пунктов, поэтому плагин публикует
 * собственный trigger в overlay-слое. Он виден только на представлениях
 * проектов и открывает bottom sheet с тем же списком, поиском и созданием,
 * что и desktop sidebar. Выбор закрывает sheet.
 */
export function ProjectsMobileSheet({ invoke }: { readonly invoke: UiOperationInvoker }) {
  const view = useWorkspaceView();

  if (view === null) {
    return null;
  }

  return <MobileSheetContent invoke={invoke} view={view} />;
}

function MobileSheetContent({
  invoke,
  view,
}: {
  readonly invoke: UiOperationInvoker;
  readonly view: NonNullable<ReturnType<typeof useWorkspaceView>>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const guardRef = useRef(false);
  const { projects, loading, error, reload } = useProjectsData(invoke);

  const select = (projectId: string): void => {
    rememberProject(projectId);
    view.navigate(searchWithProject(view.search, projectId));
    setOpen(false);
    setCreating(false);
    setSearch("");
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
      select(data.project.id);
    } catch (commandError) {
      setFormError(errorMessage(commandError));
    } finally {
      guardRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="pointer-events-auto fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] z-30 flex justify-end px-3 md:hidden">
        <button
          type="button"
          data-testid="projects-mobile-trigger"
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(true);
          }}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-semibold shadow-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span aria-hidden="true">▤</span>
          Проекты
        </button>
      </div>

      <ModalDialog
        open={open}
        label="Проекты"
        testId="projects-mobile-sheet"
        onClose={() => {
          setOpen(false);
          setCreating(false);
          setSearch("");
        }}
        restoreFocusSelector='[data-testid="projects-mobile-trigger"]'
        className="m-0 mt-auto h-auto max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border-t bg-background p-4 text-foreground"
      >
        <div className="flex flex-col gap-3" data-testid="projects-mobile-sheet-content">
          <div className="flex items-center justify-between gap-2">
            <h2 className="m-0 text-base font-semibold">Проекты</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="projects-mobile-create"
                onClick={() => {
                  setFormError(null);
                  setCreating((current) => !current);
                }}
                className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                + Новый проект
              </button>
              <button
                type="button"
                aria-label="Закрыть список проектов"
                onClick={() => {
                  setOpen(false);
                  setCreating(false);
                  setSearch("");
                }}
                className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border border-border text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </div>

          {creating ? (
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
          ) : null}

          <ProjectSwitcher
            projects={projects}
            activeProjectId={view.projectId}
            loading={loading}
            error={error}
            search={search}
            onSearchChange={setSearch}
            onSelect={select}
            testIdPrefix="projects-mobile"
          />
        </div>
      </ModalDialog>
    </>
  );
}
