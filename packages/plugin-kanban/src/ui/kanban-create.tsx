"use client";

import { useEffect } from "react";

import type { Project, Task } from "@kanbaner/plugin-tasks/contract";
import {
  ModalDialog,
  ProjectForm,
  TaskForm,
  useMediaQuery,
  type ProjectFormValues,
  type TaskFormValues,
} from "@kanbaner/task-ui";

import { KANBAN_ROUTE } from "../metadata.ts";

const DESKTOP_MEDIA_QUERY = "(min-width: 1280px)";

const MOBILE_DIALOG_CLASS =
  "m-0 h-full max-h-none w-full max-w-none overflow-y-auto border-0 bg-background p-4 xl:hidden";

export type KanbanCreateMode = "project" | "task";

export interface KanbanCreatePanelProps {
  readonly pathname?: string | undefined;
  readonly mode: KanbanCreateMode | null;
  /** Увеличивается при каждом открытии: форма начинает с новых значений. */
  readonly session: number;
  readonly projects: readonly Project[];
  readonly rootTasks: readonly Task[];
  /**
   * Draft хранится у вызывающей стороны и переживает размонтирование формы
   * при смене layout mobile ↔ desktop.
   */
  readonly taskValues: TaskFormValues | null;
  readonly projectValues: ProjectFormValues;
  readonly onTaskValuesChange: (values: TaskFormValues) => void;
  readonly onProjectValuesChange: (values: ProjectFormValues) => void;
  readonly openerSelector?: string | undefined;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmitProject: (values: ProjectFormValues) => void;
  readonly onSubmitTask: (values: TaskFormValues) => void;
}

/**
 * Панель создания проекта или задачи на доске.
 *
 * Компонент не содержит доменных запросов: команды выполняет `KanbanView`.
 * Формы и `ModalDialog` переиспользуются из `@kanbaner/task-ui`, поэтому
 * поведение совпадает со списком задач. Мобильный breakpoint открывает
 * нативный modal `<dialog>` с focus trap и возвратом фокуса; на desktop форма
 * показывается панелью над колонками.
 */
export function KanbanCreatePanel({
  pathname,
  mode,
  session,
  projects,
  rootTasks,
  taskValues,
  projectValues,
  onTaskValuesChange,
  onProjectValuesChange,
  openerSelector,
  submitting,
  error,
  onCancel,
  onSubmitProject,
  onSubmitTask,
}: KanbanCreatePanelProps) {
  const isDesktopViewport = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const onKanbanRoute = pathname === undefined || pathname === KANBAN_ROUTE;
  const open = mode !== null && onKanbanRoute;

  useEffect(() => {
    if (!open || !isDesktopViewport) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
      }
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
        onSubmit={onSubmitProject}
        onCancel={onCancel}
      />
    ) : taskValues !== null ? (
      <TaskForm
        key={`task-${String(session)}`}
        mode="create"
        projects={projects}
        rootTasks={rootTasks}
        values={taskValues}
        onValuesChange={onTaskValuesChange}
        submitting={submitting}
        error={error}
        onSubmit={onSubmitTask}
        onCancel={onCancel}
      />
    ) : null;

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
