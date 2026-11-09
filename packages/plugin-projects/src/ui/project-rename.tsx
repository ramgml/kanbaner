"use client";

import { useEffect, useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  MAX_TITLE_LENGTH,
  TASKS_COMMAND_IDS,
  type Project,
  type ProjectMutationOutput,
} from "@kanbaner/plugin-tasks/contract";
import { ModalDialog, type UiOperationInvoker } from "@kanbaner/task-ui";

import {
  PROJECT_VERSION_CONFLICT_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "./operations.ts";
import { bumpProjectsRevision } from "./workspace.ts";

export interface ProjectRenameButtonProps {
  readonly invoke: UiOperationInvoker;
  readonly project: Project;
  /** Вызывается после успешного сохранения: представление обновляет сводку. */
  readonly onRenamed?: (() => void) | undefined;
}

const actionButtonClass =
  "inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

/**
 * Кнопка и диалог переименования активного проекта.
 *
 * Доменной операции переименования нет: используется публичная
 * `kanbaner.tasks.project.update` с текущей версией проекта. После успеха
 * revision проектов перечитывает sidebar, mobile sheet, обзор и заголовок;
 * выбранный проект, маршрут и query-параметры не меняются.
 */
export function ProjectRenameButton({ invoke, project, onRenamed }: ProjectRenameButtonProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const guardRef = useRef(false);

  const openDialog = (): void => {
    setTitle(project.title);
    setError(null);
    setValidationError(null);
    setOpen(true);
  };

  const closeDialog = (): void => {
    // Пока запрос в полёте, Escape и отмена не должны закрыть диалог:
    // иначе двойной submit мог бы отправить команду повторно.
    if (guardRef.current) {
      return;
    }

    setOpen(false);
    setError(null);
    setValidationError(null);
  };

  const submit = async (): Promise<void> => {
    if (guardRef.current) {
      return;
    }

    const value = title.trim();

    if (value.length === 0) {
      setValidationError("Укажите название проекта");
      return;
    }

    if (value.length > MAX_TITLE_LENGTH) {
      setValidationError(`Название не может быть длиннее ${String(MAX_TITLE_LENGTH)} символов`);
      return;
    }

    guardRef.current = true;
    setSubmitting(true);
    setError(null);
    setValidationError(null);

    try {
      await invokeJson<ProjectMutationOutput>(invoke, TASKS_COMMAND_IDS.projectUpdate, {
        id: project.id,
        expectedVersion: project.version,
        title: value,
      } as unknown as JsonValue);

      bumpProjectsRevision();
      onRenamed?.();
      setOpen(false);
    } catch (commandError) {
      if (isVersionConflict(commandError)) {
        // Перечитываем проекты, чтобы следующая попытка использовала
        // актуальную версию, но введённое пользователем название сохраняем.
        bumpProjectsRevision();
        setError(PROJECT_VERSION_CONFLICT_MESSAGE);
      } else {
        setError(errorMessage(commandError));
      }
    } finally {
      guardRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid="project-rename-button"
        onClick={openDialog}
        className={actionButtonClass}
      >
        Переименовать
      </button>

      <ModalDialog
        open={open}
        label="Переименовать проект"
        testId="project-rename-dialog"
        onClose={closeDialog}
        restoreFocusSelector='[data-testid="project-rename-button"]'
      >
        <ProjectRenameForm
          title={title}
          error={validationError ?? error}
          submitting={submitting}
          onTitleChange={(next) => {
            setTitle(next);
            setValidationError(null);
          }}
          onSubmit={() => {
            void submit();
          }}
          onCancel={closeDialog}
        />
      </ModalDialog>
    </>
  );
}

interface ProjectRenameFormProps {
  readonly title: string;
  readonly error: string | null;
  readonly submitting: boolean;
  readonly onTitleChange: (title: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

function ProjectRenameForm({
  title,
  error,
  submitting,
  onTitleChange,
  onSubmit,
  onCancel,
}: ProjectRenameFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;

    if (input === null) {
      return;
    }

    input.focus();
    input.select();
  }, []);

  return (
    <form
      aria-label="Переименование проекта"
      data-testid="project-rename-form"
      className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 p-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <h2 className="m-0 text-base font-semibold">Переименовать проект</h2>

      <label
        className="flex flex-col gap-1 text-xs font-medium text-muted-foreground"
        htmlFor="project-rename-title"
      >
        Новое название проекта
        <input
          ref={inputRef}
          id="project-rename-title"
          name="title"
          type="text"
          data-testid="project-rename-input"
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          required
          disabled={submitting}
          onChange={(event) => {
            onTitleChange(event.target.value);
          }}
          className="h-10 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        />
      </label>

      {error === null ? null : (
        <p role="alert" data-testid="project-rename-error" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="project-rename-cancel"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          data-testid="project-rename-submit"
          disabled={submitting}
          aria-busy={submitting}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {submitting ? "Сохранение…" : "Сохранить"}
        </button>
      </div>
    </form>
  );
}
