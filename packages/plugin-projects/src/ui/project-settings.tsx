"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  MAX_TITLE_LENGTH,
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type ColumnMutationOutput,
  type Project,
  type ProjectListOutput,
  type ProjectMutationOutput,
  type TaskColumn,
} from "@kanbaner/plugin-tasks/contract";
import { LoadingState, ModalDialog, type UiOperationInvoker } from "@kanbaner/task-ui";

import { fetchProjectColumns } from "./load-columns.ts";
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

const COLUMN_VERSION_CONFLICT_MESSAGE =
  "Колонка уже изменена в другом месте. Список обновлён — проверьте название или порядок и повторите действие.";
const COLUMN_REFRESH_FAILED_MESSAGE =
  "Команда выполнена, но список колонок не обновлён. Проверьте соединение и повторите загрузку.";

type ColumnsRefreshResult =
  | { readonly kind: "ok"; readonly columns: readonly TaskColumn[] }
  | { readonly kind: "stale" }
  | { readonly kind: "error" };

/** Сколько нужно сдвинуть указатель, чтобы начать перетаскивание строки. */
const DRAG_THRESHOLD = 8;

const actionButtonClass =
  "inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

const primaryButtonClass =
  "inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

const inputClass =
  "h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 xl:h-8";

/**
 * Читает актуальный снапшот проекта через публичный `project.list`.
 *
 * После `VERSION_CONFLICT` нельзя разрешать повторную отправку на старой
 * версии. Если снапшот не найден, вызывающая сторона показывает отдельную
 * ошибку refresh и оставляет ввод пользователя.
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

/** Переставляет элемент массива на целевой индекс итогового порядка. */
export function reorderColumnEntries(
  columns: readonly TaskColumn[],
  columnId: string,
  targetIndex: number,
): readonly TaskColumn[] {
  const currentIndex = columns.findIndex((column) => column.id === columnId);

  if (currentIndex === -1) {
    return columns;
  }

  const next = columns.filter((column) => column.id !== columnId);
  const index = Math.max(0, Math.min(targetIndex, next.length));

  next.splice(index, 0, columns[currentIndex] as TaskColumn);

  return next;
}

/** Восстанавливает снимок порядка, сохраняя актуальные данные версий. */
export function restoreColumnOrderEntries(
  columns: readonly TaskColumn[],
  snapshotIds: readonly string[],
): readonly TaskColumn[] {
  const byId = new Map(columns.map((column) => [column.id, column]));
  const restored: TaskColumn[] = [];

  for (const id of snapshotIds) {
    const column = byId.get(id);

    if (column !== undefined) {
      restored.push(column);
      byId.delete(id);
    }
  }

  for (const column of columns) {
    if (byId.has(column.id)) {
      restored.push(column);
      byId.delete(column.id);
    }
  }

  return restored;
}

export interface ProjectSettingsButtonProps {
  readonly invoke: UiOperationInvoker;
  readonly project: Project;
  /** Уведомляет представление об успешном `project.update`. */
  readonly onProjectUpdated?: (() => void) | undefined;
  /** Уведомляет представление об успешном `column.update`/`column.move`. */
  readonly onColumnsChanged?: (() => void) | undefined;
}

/**
 * Кнопка «Настроить» и модалка «Настройки доски».
 *
 * Название проекта и каждая колонка сохраняются независимо существующими
 * командами `project.update`, `column.update` и `column.move`. Общего
 * пакетного сохранения нет: каждая операция имеет собственный pending,
 * актуальный `expectedVersion` и awaited refresh. Порядок меняется drag
 * handle или кнопками выше/ниже; создание, удаление и тип колонок здесь
 * намеренно отсутствуют.
 */
export function ProjectSettingsButton({
  invoke,
  project,
  onProjectUpdated,
  onColumnsChanged,
}: ProjectSettingsButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [projectTitle, setProjectTitle] = useState(project.title);
  const [savedProjectTitle, setSavedProjectTitle] = useState(project.title);
  const [projectValidation, setProjectValidation] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [projectSubmitting, setProjectSubmitting] = useState(false);
  const [projectRefreshing, setProjectRefreshing] = useState(false);

  const [columns, setColumns] = useState<readonly TaskColumn[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [columnPending, setColumnPending] = useState<ReadonlySet<string>>(() => new Set());
  const [columnErrors, setColumnErrors] = useState<Readonly<Record<string, string | null>>>({});
  const [columnNotices, setColumnNotices] = useState<Readonly<Record<string, string | null>>>({});

  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);
  const [reorderPending, setReorderPending] = useState(false);
  const [movingColumnId, setMovingColumnId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{
    readonly columnId: string;
    readonly after: boolean;
  } | null>(null);

  const [dirtyConfirm, setDirtyConfirm] = useState(false);
  const [projectFocusRequest, setProjectFocusRequest] = useState(0);

  const projectVersionRef = useRef(project.version);
  const projectGuardRef = useRef(false);
  const projectOperationRef = useRef(0);
  const projectIdRef = useRef(project.id);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const columnOperationRef = useRef<Map<string, number>>(new Map());
  const reorderOperationRef = useRef(0);
  const reorderPendingRef = useRef(false);
  const movingColumnIdRef = useRef<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  // После успешного сохранения родитель перечитывает проект и присылает новую
  // версию. Используем её только когда модалка закрыта или операция не идёт,
  // чтобы не перетереть версию, полученную из ответа команды.
  useEffect(() => {
    projectVersionRef.current = project.version;
  }, [project.id, project.version]);

  const setColumnPendingValue = (columnId: string, value: boolean): void => {
    const next = new Set(pendingRef.current);

    if (value) {
      next.add(columnId);
    } else {
      next.delete(columnId);
    }

    pendingRef.current = next;
    setColumnPending(next);
  };

  const setColumnError = (columnId: string, message: string | null): void => {
    setColumnErrors((current) => ({ ...current, [columnId]: message }));
  };

  const setColumnNotice = (columnId: string, message: string | null): void => {
    setColumnNotices((current) => ({ ...current, [columnId]: message }));
  };

  const applyProjectSnapshot = (snapshot: Project): void => {
    projectVersionRef.current = snapshot.version;
    setSavedProjectTitle(snapshot.title);
    setProjectTitle(snapshot.title);
  };

  const applyColumnsSnapshot = (
    fresh: readonly TaskColumn[],
    options: { readonly resetDrafts: boolean } = { resetDrafts: false },
  ): void => {
    setColumns(fresh);
    setDrafts((current) => {
      if (options.resetDrafts) {
        return Object.fromEntries(fresh.map((column) => [column.id, column.title]));
      }

      const next: Record<string, string> = {};

      for (const column of fresh) {
        next[column.id] = current[column.id] ?? column.title;
      }

      return next;
    });
  };

  const isCurrent = (projectId: string, generation: number): boolean =>
    mountedRef.current &&
    projectIdRef.current === projectId &&
    generationRef.current === generation;

  /**
   * Перечитывает колонки и применяет только самый свежий ответ.
   *
   * `column.list` может завершиться в обратном порядке: например, rename и
   * reorder идут параллельно. Монотонный sequence не даёт старому ответу
   * перетереть новый порядок/версии. `stale` никогда не превращается в ошибку.
   */
  const refreshColumns = async (
    projectId: string,
    generation: number,
    options: { readonly resetDrafts?: boolean } = {},
  ): Promise<ColumnsRefreshResult> => {
    const sequence = refreshSequenceRef.current + 1;

    refreshSequenceRef.current = sequence;

    try {
      const fresh = await fetchProjectColumns(invoke, projectId);

      if (!isCurrent(projectId, generation) || refreshSequenceRef.current !== sequence) {
        return { kind: "stale" };
      }

      applyColumnsSnapshot(fresh, { resetDrafts: options.resetDrafts ?? false });

      return { kind: "ok", columns: fresh };
    } catch {
      if (!isCurrent(projectId, generation) || refreshSequenceRef.current !== sequence) {
        return { kind: "stale" };
      }

      return { kind: "error" };
    }
  };

  const resetState = (): void => {
    setLoading(false);
    setLoadError(null);
    setProjectValidation(null);
    setProjectError(null);
    setProjectNotice(null);
    setProjectSubmitting(false);
    setProjectRefreshing(false);
    setColumns([]);
    setDrafts({});
    setColumnPending(new Set());
    pendingRef.current = new Set();
    setReorderPending(false);
    setMovingColumnId(null);
    reorderPendingRef.current = false;
    setColumnErrors({});
    setColumnNotices({});
    setDraggingColumnId(null);
    setDragOver(null);
    setDirtyConfirm(false);
  };

  const loadSettings = async (projectId: string, generation: number): Promise<void> => {
    setLoading(true);
    setLoadError(null);

    const sequence = refreshSequenceRef.current + 1;

    refreshSequenceRef.current = sequence;

    try {
      const [freshProject, freshColumns] = await Promise.all([
        loadCurrentProject(invoke, projectId),
        fetchProjectColumns(invoke, projectId),
      ]);

      if (!isCurrent(projectId, generation) || refreshSequenceRef.current !== sequence) {
        return;
      }

      if (freshProject === null) {
        setLoadError("Проект не найден. Возможно, он удалён в другом месте.");
        setLoading(false);

        return;
      }

      applyProjectSnapshot(freshProject);
      applyColumnsSnapshot(freshColumns, { resetDrafts: true });
      setLoading(false);
    } catch (loadFailure) {
      if (isCurrent(projectId, generation) && refreshSequenceRef.current === sequence) {
        setLoadError(errorMessage(loadFailure));
        setLoading(false);
      }
    }
  };

  const isDirty = (): boolean => {
    if (projectTitle !== savedProjectTitle) {
      return true;
    }

    return columns.some((column) => (drafts[column.id] ?? column.title) !== column.title);
  };

  const closeNow = (): void => {
    generationRef.current += 1;
    refreshSequenceRef.current += 1;
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    projectGuardRef.current = false;
    projectOperationRef.current += 1;
    columnOperationRef.current.clear();
    reorderOperationRef.current += 1;
    reorderPendingRef.current = false;
    setOpen(false);
    resetState();
  };

  const isBusy = (): boolean =>
    projectGuardRef.current || pendingRef.current.size > 0 || reorderPendingRef.current;

  const requestClose = (): void => {
    // Пока команда или refresh в полёте, закрытие заблокировано: иначе
    // повторная отправка могла бы уйти со старым expectedVersion.
    if (isBusy()) {
      return;
    }

    if (dirtyConfirm) {
      setDirtyConfirm(false);
      doneButtonRef.current?.focus();

      return;
    }

    if (isDirty()) {
      setDirtyConfirm(true);

      return;
    }

    closeNow();
  };

  const requestDiscard = (): void => {
    // «Закрыть без сохранения» проходит тот же общий guard, что и «Готово».
    if (isBusy()) {
      return;
    }

    closeNow();
  };

  const openSettings = (): void => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const projectId = project.id;

    resetState();
    setOpen(true);
    setProjectTitle(project.title);
    setSavedProjectTitle(project.title);
    projectVersionRef.current = project.version;
    void loadSettings(projectId, generation);
  };

  // Смена проекта закрывает старую модалку: её состояние и ответы больше не
  // относятся к текущей доске.
  useEffect(() => {
    projectIdRef.current = project.id;

    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      closeNow();
    }
    // closeNow очищает всё состояние открытия; зависимость — только проект.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    if (!open || loading || loadError !== null) {
      return;
    }

    const input = titleInputRef.current;

    if (input === null) {
      return;
    }

    input.focus();
    input.select();
  }, [open, loading, loadError]);

  useEffect(() => {
    if (projectFocusRequest === 0) {
      return;
    }

    titleInputRef.current?.focus();
  }, [projectFocusRequest]);

  useEffect(() => {
    if (!dirtyConfirm) {
      return;
    }

    if (typeof requestAnimationFrame !== "function") {
      return;
    }

    const frame = requestAnimationFrame(() => {
      doneButtonRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [dirtyConfirm]);

  const submitProject = async (): Promise<void> => {
    if (
      projectGuardRef.current ||
      projectSubmitting ||
      projectRefreshing ||
      loading ||
      loadError !== null
    ) {
      return;
    }

    const value = projectTitle.trim();

    if (value.length === 0) {
      setProjectValidation("Укажите название проекта");

      return;
    }

    if (value.length > MAX_TITLE_LENGTH) {
      setProjectValidation(`Название не может быть длиннее ${String(MAX_TITLE_LENGTH)} символов`);

      return;
    }

    if (value === savedProjectTitle) {
      setProjectValidation(null);
      setProjectTitle(savedProjectTitle);
      setProjectNotice(null);

      return;
    }

    const projectId = project.id;
    const generation = generationRef.current;
    const operation = projectOperationRef.current + 1;

    projectOperationRef.current = operation;
    projectGuardRef.current = true;
    setDirtyConfirm(false);
    setProjectSubmitting(true);
    setProjectValidation(null);
    setProjectError(null);
    setProjectNotice(null);

    try {
      if (!isCurrent(projectId, generation)) {
        return;
      }

      const data = await invokeJson<ProjectMutationOutput>(
        invoke,
        TASKS_COMMAND_IDS.projectUpdate,
        {
          id: projectId,
          expectedVersion: projectVersionRef.current,
          title: value,
        } as unknown as JsonValue,
      );

      if (!isCurrent(projectId, generation)) {
        return;
      }

      projectVersionRef.current = data.project.version;
      setSavedProjectTitle(data.project.title);
      setProjectTitle(data.project.title);
      setProjectNotice("Название проекта сохранено");
      bumpProjectsRevision();
      onProjectUpdated?.();
    } catch (commandError) {
      if (!isCurrent(projectId, generation)) {
        return;
      }

      if (isVersionConflict(commandError)) {
        // Пока не получена свежая версия, повторная отправка не должна уйти
        // на старом expectedVersion.
        setProjectSubmitting(false);
        setProjectRefreshing(true);

        try {
          const fresh = await loadCurrentProject(invoke, projectId);

          if (!isCurrent(projectId, generation)) {
            return;
          }

          if (fresh === null) {
            setProjectError(PROJECT_VERSION_REFRESH_FAILED_MESSAGE);
          } else {
            projectVersionRef.current = fresh.version;
            setSavedProjectTitle(fresh.title);
            bumpProjectsRevision();
            setProjectError(PROJECT_VERSION_CONFLICT_MESSAGE);
          }
        } catch {
          if (isCurrent(projectId, generation)) {
            setProjectError(PROJECT_VERSION_REFRESH_FAILED_MESSAGE);
          }
        } finally {
          if (isCurrent(projectId, generation) && projectOperationRef.current === operation) {
            setProjectRefreshing(false);
            setProjectFocusRequest((current) => current + 1);
          }
        }
      } else {
        setProjectError(errorMessage(commandError));
        setProjectFocusRequest((current) => current + 1);
      }
    } finally {
      if (projectOperationRef.current === operation) {
        projectGuardRef.current = false;

        if (isCurrent(projectId, generation)) {
          setProjectSubmitting(false);
        }
      }
    }
  };

  const submitColumn = async (columnId: string): Promise<void> => {
    if (
      columnOperationRef.current.has(columnId) ||
      (reorderPendingRef.current && movingColumnIdRef.current === columnId) ||
      loading
    ) {
      return;
    }

    const column = columns.find((candidate) => candidate.id === columnId);

    if (column === undefined) {
      return;
    }

    const draft = drafts[columnId] ?? column.title;
    const value = draft.trim();

    if (value.length === 0) {
      setColumnError(columnId, "Укажите название колонки");

      return;
    }

    if (value.length > MAX_TITLE_LENGTH) {
      setColumnError(
        columnId,
        `Название не может быть длиннее ${String(MAX_TITLE_LENGTH)} символов`,
      );

      return;
    }

    if (value === column.title) {
      setColumnError(columnId, null);
      setDrafts((current) => ({ ...current, [columnId]: column.title }));

      return;
    }

    const projectId = project.id;
    const generation = generationRef.current;
    const operation = (columnOperationRef.current.get(columnId) ?? 0) + 1;

    columnOperationRef.current.set(columnId, operation);
    setDirtyConfirm(false);
    setColumnPendingValue(columnId, true);
    setColumnError(columnId, null);
    setColumnNotice(columnId, null);

    try {
      if (!isCurrent(projectId, generation)) {
        return;
      }

      const data = await invokeJson<ColumnMutationOutput>(invoke, TASKS_COMMAND_IDS.columnUpdate, {
        id: column.id,
        expectedVersion: column.version,
        title: value,
      } as unknown as JsonValue);

      if (!isCurrent(projectId, generation)) {
        return;
      }

      // Локально фиксируем версию сразу: повторная отправка после неудачного
      // refresh не должна снова получить конфликт.
      setColumns((current) =>
        current.map((candidate) =>
          candidate.id === data.column.id ? { ...candidate, ...data.column } : candidate,
        ),
      );
      setDrafts((current) => ({ ...current, [columnId]: data.column.title }));

      const refreshed = await refreshColumns(projectId, generation);

      if (!isCurrent(projectId, generation)) {
        return;
      }

      if (refreshed.kind === "error") {
        setColumnError(columnId, COLUMN_REFRESH_FAILED_MESSAGE);
      } else if (refreshed.kind === "ok") {
        setColumnNotice(columnId, "Название колонки сохранено");
        onColumnsChanged?.();
      }
    } catch (commandError) {
      if (!isCurrent(projectId, generation)) {
        return;
      }

      if (isVersionConflict(commandError)) {
        const refreshed = await refreshColumns(projectId, generation);

        if (!isCurrent(projectId, generation)) {
          return;
        }

        setColumnError(
          columnId,
          refreshed.kind === "error"
            ? "Колонка изменена в другом месте, но обновить список не удалось. Проверьте соединение и повторите."
            : COLUMN_VERSION_CONFLICT_MESSAGE,
        );
      } else {
        setColumnError(columnId, errorMessage(commandError));
      }
    } finally {
      if (columnOperationRef.current.get(columnId) === operation) {
        columnOperationRef.current.delete(columnId);

        if (isCurrent(projectId, generation)) {
          setColumnPendingValue(columnId, false);
        }
      }
    }
  };

  const applyReorder = async (columnId: string, targetIndex: number): Promise<void> => {
    if (reorderPendingRef.current || columnOperationRef.current.has(columnId) || loading) {
      return;
    }

    const column = columns.find((candidate) => candidate.id === columnId);

    if (column === undefined) {
      return;
    }

    const currentIndex = columns.findIndex((candidate) => candidate.id === columnId);
    const clamped = Math.max(0, Math.min(targetIndex, columns.length));

    if (currentIndex === -1 || clamped === currentIndex) {
      return;
    }

    const projectId = project.id;
    const generation = generationRef.current;
    const snapshotIds = columns.map((candidate) => candidate.id);
    const operation = reorderOperationRef.current + 1;

    reorderOperationRef.current = operation;
    reorderPendingRef.current = true;
    movingColumnIdRef.current = columnId;
    setReorderPending(true);
    setMovingColumnId(columnId);
    setDirtyConfirm(false);
    setColumns((current) => reorderColumnEntries(current, columnId, clamped));
    setColumnPendingValue(columnId, true);
    setColumnError(columnId, null);
    setColumnNotice(columnId, null);
    setDragOver(null);

    try {
      if (!isCurrent(projectId, generation)) {
        return;
      }

      const data = await invokeJson<ColumnMutationOutput>(invoke, TASKS_COMMAND_IDS.columnMove, {
        id: column.id,
        expectedVersion: column.version,
        position: clamped,
      } as unknown as JsonValue);

      if (!isCurrent(projectId, generation)) {
        return;
      }

      // Даже если refresh упадёт, версия перемещённой колонки уже свежая.
      setColumns((current) =>
        current.map((candidate) =>
          candidate.id === data.column.id ? { ...candidate, ...data.column } : candidate,
        ),
      );

      const refreshed = await refreshColumns(projectId, generation);

      if (!isCurrent(projectId, generation)) {
        return;
      }

      if (refreshed.kind === "error") {
        setColumnError(columnId, COLUMN_REFRESH_FAILED_MESSAGE);
      } else if (refreshed.kind === "ok") {
        setColumnNotice(columnId, "Порядок колонок сохранён");
        onColumnsChanged?.();
      }
    } catch (commandError) {
      if (!isCurrent(projectId, generation)) {
        return;
      }

      // Откатываем только порядок этой операции, сохраняя актуальные данные
      // колонок (включая параллельный rename другой колонки).
      setColumns((current) => restoreColumnOrderEntries(current, snapshotIds));

      if (isVersionConflict(commandError)) {
        const refreshed = await refreshColumns(projectId, generation);

        if (!isCurrent(projectId, generation)) {
          return;
        }

        setColumnError(
          columnId,
          refreshed.kind === "error"
            ? "Колонка изменена в другом месте, но обновить порядок не удалось. Проверьте соединение и повторите."
            : COLUMN_VERSION_CONFLICT_MESSAGE,
        );
      } else {
        setColumnError(columnId, errorMessage(commandError));
      }
    } finally {
      if (reorderOperationRef.current === operation) {
        reorderPendingRef.current = false;
        movingColumnIdRef.current = null;

        if (isCurrent(projectId, generation)) {
          setReorderPending(false);
          setMovingColumnId(null);
          setColumnPendingValue(columnId, false);
        }
      }
    }
  };

  const moveColumn = (columnId: string, delta: -1 | 1): void => {
    const index = columns.findIndex((column) => column.id === columnId);
    const target = index + delta;

    if (index === -1 || target < 0 || target >= columns.length) {
      return;
    }

    void applyReorder(columnId, target);
  };

  const startColumnDrag = (columnId: string, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    if (reorderPendingRef.current || columnOperationRef.current.has(columnId)) {
      return;
    }

    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let target: { readonly columnId: string; readonly after: boolean } | null = null;

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (
        !active &&
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD
      ) {
        return;
      }

      active = true;
      moveEvent.preventDefault();

      if (typeof document.elementFromPoint !== "function") {
        return;
      }

      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const row = element?.closest<HTMLElement>("[data-settings-column-id]") ?? null;
      const targetId = row?.getAttribute("data-settings-column-id") ?? null;

      if (row === null || targetId === null || targetId === columnId) {
        target = null;
        setDragOver(null);

        return;
      }

      const rect = row.getBoundingClientRect();

      target = { columnId: targetId, after: moveEvent.clientY > rect.top + rect.height / 2 };
      setDraggingColumnId(columnId);
      setDragOver(target);
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      setDraggingColumnId(null);
      setDragOver(null);

      if (dragCleanupRef.current === cleanup) {
        dragCleanupRef.current = null;
      }
    };

    dragCleanupRef.current = cleanup;

    const onPointerUp = (): void => {
      const drop = target;

      cleanup();

      if (!active || drop === null) {
        return;
      }

      const others = columns.filter((candidate) => candidate.id !== columnId);
      const targetIndex = others.findIndex((candidate) => candidate.id === drop.columnId);

      if (targetIndex === -1) {
        return;
      }

      const insertion = drop.after ? targetIndex + 1 : targetIndex;

      void applyReorder(columnId, insertion);
    };

    const onPointerCancel = (): void => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const busy =
    projectSubmitting ||
    projectRefreshing ||
    columnPending.size > 0 ||
    reorderPending ||
    draggingColumnId !== null;

  return (
    <>
      <button
        type="button"
        data-testid="project-settings-button"
        onClick={openSettings}
        className={actionButtonClass}
      >
        Настроить
      </button>

      <ModalDialog
        open={open}
        label="Настройки доски"
        testId="project-settings-dialog"
        onClose={requestClose}
        restoreFocusSelector='[data-testid="project-settings-button"]'
        closeOnBackdrop
        className="m-auto w-[calc(100vw-2rem)] max-w-[34rem] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/45"
      >
        <div className="flex max-h-[85dvh] flex-col gap-4 overflow-y-auto p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="m-0 text-base font-semibold">Настройки доски</h2>
              <p className="m-0 text-xs text-muted-foreground">
                Название проекта и колонки сохраняются по отдельности.
              </p>
            </div>
            <button
              type="button"
              aria-label="Закрыть настройки доски"
              data-testid="project-settings-close"
              onClick={requestClose}
              disabled={busy}
              className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border border-border bg-background text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>

          {loading ? (
            <LoadingState label="Загрузка настроек…" />
          ) : loadError !== null ? (
            <div
              data-testid="project-settings-load-error"
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
            >
              <p className="m-0">Не удалось загрузить настройки: {loadError}</p>
              <button
                type="button"
                data-testid="project-settings-retry"
                onClick={() => {
                  const generation = generationRef.current + 1;

                  generationRef.current = generation;
                  setLoadError(null);
                  void loadSettings(project.id, generation);
                }}
                className={actionButtonClass}
              >
                Повторить
              </button>
            </div>
          ) : (
            <>
              <section
                aria-labelledby="project-settings-title-heading"
                className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/60 p-3"
              >
                <h3
                  id="project-settings-title-heading"
                  className="m-0 text-sm font-semibold tracking-tight"
                >
                  Проект
                </h3>

                <form
                  data-testid="project-settings-title-form"
                  aria-label="Название проекта"
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitProject();
                  }}
                >
                  <label
                    className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground"
                    htmlFor="project-settings-title"
                  >
                    Название проекта
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={titleInputRef}
                        id="project-settings-title"
                        name="title"
                        type="text"
                        data-testid="project-settings-title-input"
                        value={projectTitle}
                        maxLength={MAX_TITLE_LENGTH}
                        required
                        disabled={projectSubmitting}
                        onChange={(event) => {
                          setProjectTitle(event.target.value);
                          setProjectValidation(null);
                          setProjectError(null);
                          setProjectNotice(null);
                          setDirtyConfirm(false);
                        }}
                        className={inputClass}
                      />
                      <button
                        type="submit"
                        data-testid="project-settings-title-save"
                        disabled={
                          projectSubmitting ||
                          projectRefreshing ||
                          projectTitle.trim() === savedProjectTitle
                        }
                        aria-busy={projectSubmitting || projectRefreshing}
                        className={primaryButtonClass}
                      >
                        {projectSubmitting
                          ? "Сохранение…"
                          : projectRefreshing
                            ? "Обновление…"
                            : "Сохранить"}
                      </button>
                    </div>
                  </label>

                  {projectValidation === null &&
                  projectError === null &&
                  projectNotice === null ? null : (
                    <div className="flex flex-col gap-1">
                      {projectValidation === null ? null : (
                        <p
                          role="alert"
                          data-testid="project-settings-title-validation"
                          className="m-0 text-xs text-destructive"
                        >
                          {projectValidation}
                        </p>
                      )}
                      {projectError === null ? null : (
                        <p
                          role="alert"
                          data-testid="project-settings-title-error"
                          className="m-0 text-xs text-destructive"
                        >
                          {projectError}
                        </p>
                      )}
                      {projectNotice === null ? null : (
                        <p
                          role="status"
                          data-testid="project-settings-title-notice"
                          className="m-0 text-xs text-muted-foreground"
                        >
                          {projectNotice}
                        </p>
                      )}
                    </div>
                  )}
                </form>
              </section>

              <section
                aria-labelledby="project-settings-columns-heading"
                className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/60 p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3
                    id="project-settings-columns-heading"
                    className="m-0 text-sm font-semibold tracking-tight"
                  >
                    Колонки
                  </h3>
                  <p className="m-0 text-[11px] text-muted-foreground">
                    Порядок меняется ручкой или кнопками ↑/↓.
                  </p>
                </div>

                <ol
                  data-testid="project-settings-columns"
                  aria-label="Колонки доски"
                  className="m-0 flex list-none flex-col gap-1.5 p-0"
                >
                  {columns.map((column, index) => {
                    const draft = drafts[column.id] ?? column.title;
                    const pending = columnPending.has(column.id);
                    const error = columnErrors[column.id] ?? null;
                    const notice = columnNotices[column.id] ?? null;
                    const dropHere = dragOver?.columnId === column.id;

                    return (
                      <li
                        key={column.id}
                        data-testid={`project-settings-column-${column.id}`}
                        data-settings-column-id={column.id}
                        aria-busy={pending}
                        className="flex flex-col gap-1 rounded-md border bg-background p-2"
                        style={{
                          borderColor: dropHere ? "var(--ring)" : "var(--border)",
                          boxShadow: dropHere ? "0 0 0 2px var(--ring)" : "none",
                          opacity: draggingColumnId === column.id ? 0.62 : 1,
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <button
                            type="button"
                            aria-label={`Перетащить колонку «${column.title}»`}
                            title="Перетащить колонку"
                            data-testid={`project-settings-column-drag-${column.id}`}
                            disabled={pending || reorderPending}
                            onPointerDown={(event) => {
                              startColumnDrag(column.id, event);
                            }}
                            className="flex min-h-10 min-w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing xl:min-h-8"
                          >
                            <span aria-hidden="true">⠿</span>
                          </button>

                          <input
                            name={`column-${column.id}`}
                            type="text"
                            aria-label={`Название колонки «${column.title}»`}
                            data-testid={`project-settings-column-input-${column.id}`}
                            value={draft}
                            maxLength={MAX_TITLE_LENGTH}
                            disabled={pending || movingColumnId === column.id}
                            onChange={(event) => {
                              const value = event.target.value;

                              setDrafts((current) => ({ ...current, [column.id]: value }));
                              setColumnError(column.id, null);
                              setColumnNotice(column.id, null);
                              setDirtyConfirm(false);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void submitColumn(column.id);
                              }
                            }}
                            className={inputClass}
                          />

                          <button
                            type="button"
                            data-testid={`project-settings-column-save-${column.id}`}
                            aria-label={`Сохранить название колонки «${column.title}»`}
                            disabled={
                              pending ||
                              movingColumnId === column.id ||
                              draft.trim().length === 0 ||
                              draft.trim() === column.title
                            }
                            aria-busy={pending}
                            onClick={() => {
                              void submitColumn(column.id);
                            }}
                            className={primaryButtonClass}
                          >
                            {pending ? "…" : "Сохранить"}
                          </button>

                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              data-testid={`project-settings-column-up-${column.id}`}
                              aria-label={`Переместить колонку «${column.title}» выше`}
                              title="Выше"
                              disabled={pending || reorderPending || index === 0}
                              onClick={() => {
                                moveColumn(column.id, -1);
                              }}
                              className="inline-flex min-h-10 min-w-8 items-center justify-center rounded-md border border-border bg-background text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 xl:min-h-8"
                            >
                              <span aria-hidden="true">↑</span>
                            </button>
                            <button
                              type="button"
                              data-testid={`project-settings-column-down-${column.id}`}
                              aria-label={`Переместить колонку «${column.title}» ниже`}
                              title="Ниже"
                              disabled={pending || reorderPending || index === columns.length - 1}
                              onClick={() => {
                                moveColumn(column.id, 1);
                              }}
                              className="inline-flex min-h-10 min-w-8 items-center justify-center rounded-md border border-border bg-background text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 xl:min-h-8"
                            >
                              <span aria-hidden="true">↓</span>
                            </button>
                          </div>
                        </div>

                        {pending ? (
                          <span
                            role="status"
                            data-testid={`project-settings-column-pending-${column.id}`}
                            className="text-[11px] text-muted-foreground"
                          >
                            Сохранение…
                          </span>
                        ) : null}

                        {error === null ? null : (
                          <p
                            role="alert"
                            data-testid={`project-settings-column-error-${column.id}`}
                            className="m-0 text-[11px] text-destructive"
                          >
                            {error}
                          </p>
                        )}

                        {notice === null ? null : (
                          <p
                            role="status"
                            data-testid={`project-settings-column-notice-${column.id}`}
                            className="m-0 text-[11px] text-muted-foreground"
                          >
                            {notice}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>

              <div className="flex flex-col gap-2 border-t border-border pt-3">
                {dirtyConfirm ? (
                  <div
                    role="alertdialog"
                    aria-label="Несохранённые изменения"
                    data-testid="project-settings-dirty-confirm"
                    className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs"
                  >
                    <p className="m-0 font-medium">
                      Есть несохранённые изменения. Закрыть настройки без сохранения?
                    </p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        data-testid="project-settings-dirty-keep"
                        onClick={() => {
                          setDirtyConfirm(false);
                          doneButtonRef.current?.focus();
                        }}
                        className={actionButtonClass}
                      >
                        Остаться
                      </button>
                      <button
                        type="button"
                        data-testid="project-settings-dirty-discard"
                        onClick={requestDiscard}
                        disabled={busy}
                        className={actionButtonClass}
                      >
                        Закрыть без сохранения
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="flex justify-end">
                  <button
                    ref={doneButtonRef}
                    type="button"
                    data-testid="project-settings-done"
                    onClick={requestClose}
                    disabled={busy}
                    className={actionButtonClass}
                  >
                    Готово
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </ModalDialog>
    </>
  );
}
