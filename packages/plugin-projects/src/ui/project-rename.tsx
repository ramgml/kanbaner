"use client";

import { useEffect, useRef, useState } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  MAX_TITLE_LENGTH,
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type Project,
  type ProjectListOutput,
  type ProjectMutationOutput,
} from "@kanbaner/plugin-tasks/contract";
import { ModalDialog, type UiOperationInvoker } from "@kanbaner/task-ui";

import {
  PROJECT_VERSION_CONFLICT_MESSAGE,
  PROJECT_VERSION_REFRESH_FAILED_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "./operations.ts";
import { bumpProjectsRevision } from "./workspace.ts";

/** Те же границы страниц, что и у `useProjectsData`. */
const PROJECT_PAGE_SIZE = 200;
const MAX_PROJECT_PAGES = 100;

/**
 * Читает актуальный снапшот проекта через публичный `project.list`.
 *
 * После `VERSION_CONFLICT` нельзя показывать «данные перечитаны» и разрешать
 * повторную отправку, пока не получена свежая версия. Отдельный `project.get`
 * здесь не нужен: list уже используется остальными project selectors.
 */
async function loadCurrentProject(
  invoke: UiOperationInvoker,
  projectId: string,
): Promise<Project | null> {
  let offset = 0;

  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const data = await invokeJson<ProjectListOutput>(invoke, TASKS_QUERY_IDS.projectList, {
      limit: PROJECT_PAGE_SIZE,
      offset,
    } as unknown as JsonValue);
    const found = data.items.find((candidate) => candidate.id === projectId);

    if (found !== undefined) {
      return found;
    }

    if (
      data.nextOffset === null ||
      data.items.length === 0 ||
      data.nextOffset <= offset ||
      data.nextOffset >= data.total
    ) {
      break;
    }

    offset = data.nextOffset;
  }

  return null;
}

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
  const [refreshing, setRefreshing] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const guardRef = useRef(false);
  const versionRef = useRef(project.version);

  useEffect(() => {
    versionRef.current = project.version;
  }, [project.id, project.version]);

  const openDialog = (): void => {
    versionRef.current = project.version;
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
        expectedVersion: versionRef.current,
        title: value,
      } as unknown as JsonValue);

      bumpProjectsRevision();
      onRenamed?.();
      setOpen(false);
    } catch (commandError) {
      if (isVersionConflict(commandError)) {
        // Отправка остаётся заблокированной guard-ом, пока refresh не вернёт
        // свежую версию. Иначе повторный submit снова получил бы конфликт.
        setSubmitting(false);
        setRefreshing(true);

        try {
          const fresh = await loadCurrentProject(invoke, project.id);

          if (fresh === null) {
            setError(PROJECT_VERSION_REFRESH_FAILED_MESSAGE);
          } else {
            versionRef.current = fresh.version;
            bumpProjectsRevision();
            setError(PROJECT_VERSION_CONFLICT_MESSAGE);
          }
        } catch {
          // Ошибка refresh не должна выглядеть как успешное перечитывание.
          setError(PROJECT_VERSION_REFRESH_FAILED_MESSAGE);
        } finally {
          setRefreshing(false);
          setFocusRequest((current) => current + 1);
        }
      } else {
        setError(errorMessage(commandError));
        setFocusRequest((current) => current + 1);
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
          refreshing={refreshing}
          focusRequest={focusRequest}
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
  /** Команда уже завершилась, но ожидается свежая версия проекта. */
  readonly refreshing: boolean;
  readonly focusRequest: number;
  readonly onTitleChange: (title: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

function ProjectRenameForm({
  title,
  error,
  submitting,
  refreshing,
  focusRequest,
  onTitleChange,
  onSubmit,
  onCancel,
}: ProjectRenameFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = submitting || refreshing;

  useEffect(() => {
    const input = inputRef.current;

    if (input === null) {
      return;
    }

    input.focus();
    input.select();
  }, []);

  useEffect(() => {
    if (focusRequest === 0) {
      return;
    }

    // Ввод не теряется при ошибке: возвращаем фокус без повторного select,
    // чтобы пользователь мог продолжить редактирование с того же места.
    inputRef.current?.focus();
  }, [focusRequest]);

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
          disabled={busy}
          className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          data-testid="project-rename-submit"
          disabled={busy}
          aria-busy={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {submitting ? "Сохранение…" : refreshing ? "Обновление…" : "Сохранить"}
        </button>
      </div>
    </form>
  );
}
