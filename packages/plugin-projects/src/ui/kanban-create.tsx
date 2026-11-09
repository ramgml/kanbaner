"use client";

import { useEffect } from "react";

import type { TaskStatus } from "@kanbaner/plugin-tasks/contract";
import { ModalDialog, ProjectForm, useMediaQuery, type ProjectFormValues } from "@kanbaner/task-ui";

import { KANBAN_ROUTE } from "../metadata.ts";
import { TitleComposer, type TitleCreateResult } from "./title-composer.tsx";

const DESKTOP_MEDIA_QUERY = "(min-width: 1280px)";

const MOBILE_DIALOG_CLASS =
  "m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-background p-4 xl:hidden";

export type KanbanCreateMode = "project" | "task";

export interface KanbanCreatePanelProps {
  readonly pathname?: string | undefined;
  readonly mode: KanbanCreateMode | null;
  /** Увеличивается при каждом открытии: форма начинает с новых значений. */
  readonly session: number;
  readonly projectId: string;
  readonly status: TaskStatus;
  readonly projectValues: ProjectFormValues;
  readonly onProjectValuesChange: (values: ProjectFormValues) => void;
  /** Draft названия переживает размонтирование composer-а при смене layout. */
  readonly taskDraftTitle: string;
  readonly onTaskDraftTitleChange: (title: string) => void;
  readonly openerSelector?: string | undefined;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onCreateProject: (values: ProjectFormValues) => void;
  readonly onCreateTask: (title: string) => Promise<TitleCreateResult>;
}

/**
 * Панель создания проекта или карточки на доске.
 *
 * Создание карточки — короткий composer с одним названием: проект уже
 * определяется доской, статус — колонкой. Полная `TaskForm` используется
 * только для редактирования открытой карточки.
 */
export function KanbanCreatePanel({
  pathname,
  mode,
  session,
  projectId,
  status,
  projectValues,
  onProjectValuesChange,
  taskDraftTitle,
  onTaskDraftTitleChange,
  openerSelector,
  submitting,
  error,
  onCancel,
  onCreateProject,
  onCreateTask,
}: KanbanCreatePanelProps) {
  const isDesktopViewport = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const onKanbanRoute = pathname === undefined || pathname === KANBAN_ROUTE;
  const open = mode !== null && onKanbanRoute;

  useEffect(() => {
    if (!open || !isDesktopViewport) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // Вложенный modal уже закрыл себя по Escape и вызвал preventDefault.
      // Иначе Escape поверх переименования сбрасывал бы черновик создания.
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      onCancel();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, isDesktopViewport, onCancel]);

  if (!open || mode === null) {
    return null;
  }

  const content =
    mode === "project" ? (
      <ProjectForm
        key={`project-${String(session)}`}
        values={projectValues}
        onValuesChange={onProjectValuesChange}
        submitting={submitting}
        error={error}
        onSubmit={onCreateProject}
        onCancel={onCancel}
      />
    ) : (
      <TitleComposer
        key={`task-${String(session)}`}
        status={status}
        projectId={projectId}
        onCreate={onCreateTask}
        onCancel={onCancel}
        submitLabel="Создать задачу"
        testIdPrefix="kanban-create"
        resetToken={session}
        initialTitle={taskDraftTitle}
        onTitleChange={onTaskDraftTitleChange}
      />
    );

  if (!isDesktopViewport) {
    return (
      <ModalDialog
        open
        label={mode === "project" ? "Новый проект" : "Новая задача"}
        testId="kanban-create-dialog"
        onClose={onCancel}
        {...(openerSelector === undefined ? {} : { restoreFocusSelector: openerSelector })}
        className={MOBILE_DIALOG_CLASS}
      >
        {content}
      </ModalDialog>
    );
  }

  return (
    <section
      data-testid="kanban-create-panel"
      aria-label={mode === "project" ? "Новый проект" : "Новая задача"}
      style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }}
    >
      {content}
    </section>
  );
}
