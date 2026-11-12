"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  normalizeTag,
  type ColumnMutationOutput,
  type ProjectMutationOutput,
  type Task,
  type TaskColumn,
  type TaskCreateInput,
  type TaskListInput,
  type TaskListOutput,
  type TaskMutationOutput,
} from "@kanbaner/plugin-tasks/contract";
import {
  LoadingState,
  ModalDialog,
  createProjectFormValues,
  type ProjectFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { KANBAN_ROUTE } from "../metadata.ts";
import { KanbanCard, type KanbanReorderKind } from "./kanban-card.tsx";
import { KanbanColumn } from "./kanban-column.tsx";
import { KanbanDeleteColumnDialog } from "./kanban-column-forms.tsx";
import { KanbanCreatePanel, type KanbanCreateMode } from "./kanban-create.tsx";
import { KanbanQuickComposer } from "./kanban-quick-composer.tsx";
import type { TitleCreateResult } from "./title-composer.tsx";
import {
  KANBAN_PAGE_SIZE,
  applyPlacements,
  columnContainingTask,
  columnTestSlug,
  createEmptyColumns,
  defaultCreateColumnId,
  defaultDeleteTargetColumn,
  getColumn,
  getColumns,
  isLastColumnOfType,
  placementForIndex,
  reorderKanbanColumns,
  resolveMovePosition,
  restoreColumnOrder,
  syncColumns,
  visibleMoveIntent,
  type KanbanColumns,
  type MoveIntent,
  type Placement,
} from "./board-state.ts";
import {
  BULK_TASK_COMMAND_IDS,
  BULK_VERSION_CONFLICT_MESSAGE,
  KanbanOperationError,
  VERSION_CONFLICT_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "./operations.ts";
import { fetchProjectColumns } from "./load-columns.ts";
import {
  bumpKanbanRevision,
  registerKanbanSearchWriter,
  resetKanbanFilters,
  serializeKanbanQuery,
  setKanbanSearch,
  updateKanbanQuery,
  useKanbanQuery,
} from "./query-state.ts";
import { ProjectHeader } from "./project-header.tsx";
import { useProjectsData } from "./use-projects.ts";
import { useProjectSummary } from "./use-project-summary.ts";
import {
  bumpProjectsRevision,
  readLastProjectId,
  registerWorkspaceView,
  rememberProject,
  resolveProjectId,
} from "./workspace.ts";

/** Контракт задачи ограничивает `limit` значением 200. */
const MAX_LIST_LIMIT = 200;

/** Минимальный сдвиг указателя, после которого начинается drag. */
const DRAG_THRESHOLD = 7;
/** Долгое нажатие на мобильном до старта drag. */
const TOUCH_LONG_PRESS_MS = 220;
/** Сдвиг до long press, который считается вертикальной прокруткой. */
const TOUCH_SCROLL_TOLERANCE = 10;
/** Окно подавления click после завершённого drag. */
const CLICK_SUPPRESSION_MS = 400;

const COLUMN_VERSION_CONFLICT_MESSAGE =
  "Колонка уже изменена в другом месте. Доска перечитана — проверьте порядок и повторите действие.";

interface ColumnPage {
  readonly items: readonly Task[];
  readonly total: number;
  readonly nextOffset: number | null;
}

interface VisibilityRequirement {
  readonly taskId: string;
  readonly columnId: string;
  readonly position: number;
  readonly filterKey: string;
}

interface DropTarget {
  readonly columnId: string;
  readonly beforeId: string | null;
}

interface DragPreview {
  readonly html: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

function normalizeFilterTag(value: string): string {
  if (value.trim().length === 0) {
    return "";
  }

  try {
    return normalizeTag(value);
  } catch {
    return value.trim().toLowerCase();
  }
}

function listInput(
  columnId: string,
  projectId: string,
  tag: string,
  limit: number,
  offset: number,
): JsonValue {
  const input: TaskListInput = {
    columnId,
    projectId,
    ...(tag.length === 0 ? {} : { tag }),
    sort: { field: "position", direction: "asc" },
    limit,
    offset,
  };

  return input as unknown as JsonValue;
}

async function fetchColumnPage(
  invoke: UiOperationInvoker,
  columnId: string,
  projectId: string,
  tag: string,
  targetCount: number,
  mustIncludeIds: readonly string[] = [],
): Promise<ColumnPage> {
  const items: Task[] = [];
  const required = new Set(mustIncludeIds);
  let total = 0;
  let nextOffset: number | null = null;
  let remaining = Math.max(1, targetCount);

  for (;;) {
    const limit = remaining > 0 ? Math.min(KANBAN_PAGE_SIZE, remaining) : KANBAN_PAGE_SIZE;
    const data = await invokeJson<TaskListOutput>(
      invoke,
      TASKS_QUERY_IDS.taskList,
      listInput(columnId, projectId, tag, limit, items.length),
    );

    total = data.total;
    for (const task of data.items) {
      items.push({ ...task, columnId: task.columnId ?? columnId } as Task);
    }
    nextOffset = data.nextOffset;
    remaining -= data.items.length;

    const loadedIds = new Set(items.map((task) => task.id));
    const foundAll = [...required].every((id) => loadedIds.has(id));

    if (data.nextOffset === null || data.items.length === 0 || (remaining <= 0 && foundAll)) {
      break;
    }
  }

  return { items, total, nextOffset };
}

async function fetchAllScopeTasks(
  invoke: UiOperationInvoker,
  projectId: string,
  columnId: string,
): Promise<readonly Task[]> {
  const items: Task[] = [];
  let offset = 0;

  for (;;) {
    const data = await invokeJson<TaskListOutput>(
      invoke,
      TASKS_QUERY_IDS.taskList,
      listInput(columnId, projectId, "", MAX_LIST_LIMIT, offset),
    );

    items.push(...data.items);

    if (data.nextOffset === null || data.items.length === 0 || data.nextOffset <= offset) {
      break;
    }

    offset = data.nextOffset;
  }

  return items;
}

function columnIdAt(element: Element | null): string | null {
  const column = element?.closest<HTMLElement>("[data-kanban-column-id]");
  const value = column?.getAttribute("data-kanban-column-id") ?? null;

  return value !== null && value.length > 0 ? value : null;
}

/** Основное представление `/view/kanban`: одна доска одного проекта. */
export function KanbanView({
  invoke,
  pathname,
  search,
  replaceSearch,
}: {
  readonly invoke: UiOperationInvoker;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
}) {
  const query = useKanbanQuery(search);
  const onKanbanRoute = pathname === undefined || pathname === KANBAN_ROUTE;
  const { projects, loading: projectsLoading, error: projectsError } = useProjectsData(invoke);

  useEffect(() => {
    if (replaceSearch === undefined) {
      return;
    }

    return registerKanbanSearchWriter(replaceSearch);
  }, [replaceSearch]);

  const requestedProject = useMemo(
    () => projects.find((project) => project.id === query.projectId) ?? null,
    [projects, query.projectId],
  );
  const resolvedCandidate = useMemo(
    () => resolveProjectId(projects, query.projectId, readLastProjectId()),
    [projects, query.projectId],
  );
  const effectiveProjectId = projectsLoading
    ? query.projectId
    : (requestedProject?.id ?? resolvedCandidate ?? "");
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === effectiveProjectId) ?? null,
    [projects, effectiveProjectId],
  );
  const {
    summary,
    loading: summaryLoading,
    error: summaryError,
  } = useProjectSummary(invoke, effectiveProjectId, query.revision);

  // Последний/единственный проект выбирается без отдельного экрана; несколько
  // проектов без сохранённого выбора требуют явного выбора в sidebar.
  useEffect(() => {
    if (projectsLoading || projects.length === 0) {
      return;
    }

    if (query.projectId.length > 0 && requestedProject !== null) {
      rememberProject(query.projectId);

      return;
    }

    const resolved = resolveProjectId(projects, query.projectId, readLastProjectId());

    if (resolved !== null) {
      rememberProject(resolved);

      if (resolved !== query.projectId) {
        updateKanbanQuery({ projectId: resolved });
      }

      return;
    }

    if (query.projectId.length > 0) {
      updateKanbanQuery({ projectId: "", taskId: null });
    }
  }, [projectsLoading, projects, query.projectId, query.taskId, requestedProject]);

  const workspaceSearch = useMemo(
    () => (search !== undefined && pathname !== undefined ? search : serializeKanbanQuery(query)),
    [search, pathname, query],
  );

  useEffect(
    () =>
      registerWorkspaceView({
        route: KANBAN_ROUTE,
        projectId: effectiveProjectId,
        search: workspaceSearch,
        navigate: setKanbanSearch,
      }),
    [effectiveProjectId, workspaceSearch],
  );

  const [formMode, setFormMode] = useState<KanbanCreateMode | null>(null);
  const [formSession, setFormSession] = useState(0);
  const [formColumnId, setFormColumnId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [projectDraft, setProjectDraft] = useState<ProjectFormValues>(createProjectFormValues);
  const [taskDraftTitle, setTaskDraftTitle] = useState("");
  const [formOpenerSelector, setFormOpenerSelector] = useState<string | undefined>(undefined);
  const [columns, setColumns] = useState<KanbanColumns>(createEmptyColumns);
  const [loadedProjectId, setLoadedProjectId] = useState("");
  const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(() => new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [subtaskCounts, setSubtaskCounts] = useState<Readonly<Record<string, number | null>>>({});
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [dragOver, setDragOver] = useState<DropTarget | null>(null);
  const [activeColumnId, setActiveColumnId] = useState("");
  const [scrollHints, setScrollHints] = useState({ left: false, right: false });
  const [columnsHeight, setColumnsHeight] = useState<number | null>(null);

  const [columnPending, setColumnPending] = useState<ReadonlySet<string>>(() => new Set());
  const [columnConflicts, setColumnConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [columnDraggingId, setColumnDraggingId] = useState<string | null>(null);
  const [columnDragOver, setColumnDragOver] = useState<{
    readonly columnId: string;
    readonly after: boolean;
  } | null>(null);

  const [renamingColumnId, setRenamingColumnId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);

  const [deletingColumnId, setDeletingColumnId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteCount, setDeleteCount] = useState<number | null>(null);
  const [deleteCountError, setDeleteCountError] = useState<string | null>(null);
  const [columnNotice, setColumnNotice] = useState<string | null>(null);

  const [bulkSelection, setBulkSelection] = useState<ReadonlyMap<string, Task>>(() => new Map());
  const [bulkTargetId, setBulkTargetId] = useState("");
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);

  const columnsScrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const loadedCountsRef = useRef<Record<string, number>>({});
  const filterKeyRef = useRef<string>("\u0000");
  const filtersRef = useRef({ projectId: effectiveProjectId, tag: query.tag });
  const reloadSequenceRef = useRef(0);
  const loadMoreSequenceRef = useRef<Record<string, number>>({});
  const visibilityRef = useRef<Map<string, VisibilityRequirement>>(new Map());
  const placementsRef = useRef<ReadonlyMap<string, Placement>>(new Map());
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  const columnsRef = useRef<KanbanColumns>(columns);
  const submitGuardRef = useRef(false);
  const renameGuardRef = useRef(false);
  const deleteGuardRef = useRef(false);
  const deleteCountRequestRef = useRef(0);
  const deleteDialogRequestRef = useRef(0);
  const projectGenerationRef = useRef(0);
  const effectiveProjectIdRef = useRef(effectiveProjectId);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragSuppressRef = useRef<{ readonly taskId: string; readonly until: number } | null>(null);
  const dragPreviewOffsetRef = useRef({ x: 0, y: 0 });
  const deleteDialogRef = useRef<{
    readonly requestId: number;
    readonly columnId: string;
    readonly targetId: string;
  } | null>(null);
  /**
   * Массовый выбор хранится как snapshot `Task` в порядке выбора.
   *
   * `Map` сохраняет порядок вставки, поэтому payload moveMany идёт в порядке
   * кликов. Snapshot нужен для `expectedVersion` и не зависит от перерисовок.
   */
  const bulkSelectionRef = useRef<ReadonlyMap<string, Task>>(new Map());
  const bulkGuardRef = useRef(false);
  const bulkFilterTagRef = useRef(query.tag);

  effectiveProjectIdRef.current = effectiveProjectId;

  const boardReady = effectiveProjectId.length > 0 && loadedProjectId === effectiveProjectId;
  const boardColumns = boardReady ? columns : createEmptyColumns();

  columnsRef.current = boardColumns;

  const columnList = useMemo(
    () => getColumns(boardColumns).map((column) => column.column),
    [boardColumns],
  );

  const currentColumn = (columnId: string): TaskColumn | null => {
    const data = boardColumns.byId[columnId];

    return data !== undefined && data.column.projectId === effectiveProjectId ? data.column : null;
  };

  const operationContext = (): { readonly projectId: string; readonly generation: number } => ({
    projectId: effectiveProjectIdRef.current,
    generation: projectGenerationRef.current,
  });

  const isOperationCurrent = (context: {
    readonly projectId: string;
    readonly generation: number;
  }): boolean =>
    effectiveProjectIdRef.current === context.projectId &&
    projectGenerationRef.current === context.generation;

  const applyColumn = (updated: TaskColumn): void => {
    setColumns((current) => {
      const data = current.byId[updated.id];

      if (data === undefined) {
        return current;
      }

      return {
        order: current.order,
        byId: { ...current.byId, [updated.id]: { ...data, column: updated } },
      };
    });
  };

  const loadDeleteCount = async (projectId: string, columnId: string): Promise<number> => {
    const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
      projectId,
      columnId,
      limit: 1,
      offset: 0,
    } as unknown as JsonValue);

    return data.total;
  };

  const refreshProjectColumns = async (
    projectId: string,
    options: { readonly reportError?: boolean } = {},
  ): Promise<readonly TaskColumn[] | null> => {
    if (projectId.length === 0) {
      return null;
    }

    try {
      const fresh = await fetchProjectColumns(invoke, projectId);

      if (filtersRef.current.projectId !== projectId) {
        return null;
      }

      setColumns((current) => syncColumns(current, fresh));
      setLoadedProjectId(projectId);

      return fresh;
    } catch (refreshError) {
      if ((options.reportError ?? true) && filtersRef.current.projectId === projectId) {
        setError(`Колонки: ${errorMessage(refreshError)}`);
      }

      return null;
    }
  };

  const closeCreateForm = (): void => {
    setFormMode(null);
    setFormError(null);
  };

  const openProjectForm = (): void => {
    setFormError(null);
    setProjectDraft(createProjectFormValues());
    setFormOpenerSelector('[data-testid="kanban-create-first-project"]');
    setFormSession((current) => current + 1);
    setFormMode("project");
  };

  const openTaskComposer = (columnId?: string, opener?: string): void => {
    if (effectiveProjectId.length === 0) {
      return;
    }

    const resolved =
      columnId !== undefined && currentColumn(columnId) !== null
        ? columnId
        : (defaultCreateColumnId(columnList) ?? "");

    setFormError(
      resolved.length === 0 ? "В проекте нет доступных колонок. Добавьте колонку." : null,
    );
    setFormColumnId(resolved);
    setTaskDraftTitle("");
    setFormOpenerSelector(opener ?? '[data-testid="kanban-create-task"]');
    setFormSession((current) => current + 1);
    setFormMode("task");
  };

  const beginSubmit = (): boolean => {
    if (submitGuardRef.current) {
      return false;
    }

    submitGuardRef.current = true;
    setFormSubmitting(true);
    setFormError(null);

    return true;
  };

  const endSubmit = (): void => {
    submitGuardRef.current = false;
    setFormSubmitting(false);
  };

  const createProject = async (values: ProjectFormValues): Promise<void> => {
    if (!beginSubmit()) {
      return;
    }

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
      rememberProject(data.project.id);
      updateKanbanQuery({ projectId: data.project.id, taskId: null });
      setFormMode(null);
      setFormError(null);
    } catch (commandError) {
      setFormError(errorMessage(commandError));
    } finally {
      endSubmit();
    }
  };

  const revealCreatedTask = async (task: Task, columnId: string): Promise<void> => {
    const normalizedTag = normalizeFilterTag(query.tag);
    const nextTag = query.tag.length === 0 || task.tags.includes(normalizedTag) ? query.tag : "";
    const filterKey = `${effectiveProjectId}\u0000${nextTag}`;

    loadedCountsRef.current[columnId] = Math.max(
      loadedCountsRef.current[columnId] ?? KANBAN_PAGE_SIZE,
      task.position + 1,
    );
    visibilityRef.current.set(task.id, {
      taskId: task.id,
      columnId,
      position: task.position,
      filterKey,
    });

    if (nextTag !== query.tag) {
      updateKanbanQuery({ tag: nextTag, taskId: null });
      bumpKanbanRevision();

      return;
    }

    bumpKanbanRevision();
  };

  const createQuickTask = async (columnId: string, title: string): Promise<TitleCreateResult> => {
    const context = operationContext();

    if (effectiveProjectId.length === 0) {
      return { ok: false, message: "Выберите проект" };
    }

    if (currentColumn(columnId) === null) {
      return { ok: false, message: "Выберите существующую колонку" };
    }

    const trimmed = title.trim();

    if (trimmed.length === 0) {
      return { ok: false, message: "Укажите название задачи" };
    }

    if (!isOperationCurrent(context)) {
      return { ok: false, message: "Проект изменился. Повторите создание." };
    }

    const payload: TaskCreateInput = {
      projectId: context.projectId,
      columnId,
      title: trimmed,
      descriptionMarkdown: "",
      priority: "medium",
      dueAt: null,
      tags: [],
    };

    try {
      const data = await invokeJson<TaskMutationOutput>(
        invoke,
        TASKS_COMMAND_IDS.taskCreate,
        payload as unknown as JsonValue,
      );

      await revealCreatedTask(data.task, columnId);

      return { ok: true };
    } catch (commandError) {
      return { ok: false, message: errorMessage(commandError) };
    }
  };

  const reloadBoard = useCallback(async (): Promise<void> => {
    const filters = filtersRef.current;

    if (filters.projectId.length === 0) {
      setColumns(createEmptyColumns());
      setLoadedProjectId("");

      return;
    }

    const sequence = reloadSequenceRef.current + 1;
    const filterKey = filterKeyRef.current;
    const requirements = [...visibilityRef.current.values()].filter(
      (requirement) => requirement.filterKey === filterKey,
    );

    reloadSequenceRef.current = sequence;

    let projectColumns: readonly TaskColumn[];

    try {
      projectColumns = await fetchProjectColumns(invoke, filters.projectId);
    } catch (loadError) {
      if (reloadSequenceRef.current === sequence && filterKeyRef.current === filterKey) {
        setLoadedProjectId("");
        setError(errorMessage(loadError));
      }

      return;
    }

    if (reloadSequenceRef.current !== sequence || filterKeyRef.current !== filterKey) {
      return;
    }

    const loadMoreGeneration = { ...loadMoreSequenceRef.current };

    for (const column of projectColumns) {
      loadMoreGeneration[column.id] = (loadMoreGeneration[column.id] ?? 0) + 1;
    }

    loadMoreSequenceRef.current = loadMoreGeneration;
    setColumns((current) => syncColumns(current, projectColumns));
    setLoadedProjectId(filters.projectId);

    const results = await Promise.all(
      projectColumns.map(async (column) => {
        const columnRequirements = requirements.filter(
          (requirement) => requirement.columnId === column.id,
        );
        const requiredIds = columnRequirements.map((requirement) => requirement.taskId);
        const requiredPosition =
          columnRequirements.length === 0
            ? 0
            : Math.max(...columnRequirements.map((requirement) => requirement.position + 1));
        const targetCount = Math.max(
          loadedCountsRef.current[column.id] ?? KANBAN_PAGE_SIZE,
          requiredPosition,
        );

        try {
          const page = await fetchColumnPage(
            invoke,
            column.id,
            filters.projectId,
            filters.tag,
            targetCount,
            requiredIds,
          );

          return { columnId: column.id, page, error: null } as const;
        } catch (loadError) {
          return {
            columnId: column.id,
            page: null,
            error: errorMessage(loadError),
          } as const;
        }
      }),
    );

    if (reloadSequenceRef.current !== sequence || filterKeyRef.current !== filterKey) {
      return;
    }

    // Массовый выбор переживает обычный refresh: snapshot обновляется до
    // актуальных версий, а исчезнувшие/скрытые задачи из выбора убираются.
    if (bulkSelectionRef.current.size > 0) {
      const freshTasks = new Map<string, Task>();

      for (const result of results) {
        for (const task of result.page?.items ?? []) {
          if (task.projectId === filters.projectId) {
            freshTasks.set(task.id, task);
          }
        }
      }

      // Задача могла находиться за границей загруженной страницы после
      // чужого move. Отдельный task.get отличает «ещё существует» от
      // «удалена», не требуя полной перезагрузки всех страниц.
      const missingIds = [...bulkSelectionRef.current.keys()].filter((id) => !freshTasks.has(id));
      const lookups = new Map<string, Task | null>();

      if (missingIds.length > 0) {
        const found = await Promise.all(
          missingIds.map(async (id) => {
            try {
              const data = await invokeJson<{ readonly task: Task }>(
                invoke,
                TASKS_QUERY_IDS.taskGet,
                { id } as unknown as JsonValue,
              );

              return [id, data.task] as const;
            } catch (lookupError) {
              if (lookupError instanceof KanbanOperationError && lookupError.code === "NOT_FOUND") {
                return [id, null] as const;
              }

              // Временная ошибка не должна молча стирать выбор.
              return [id, undefined] as const;
            }
          }),
        );

        for (const [id, task] of found) {
          lookups.set(id, task ?? null);
        }

        if (reloadSequenceRef.current !== sequence || filterKeyRef.current !== filterKey) {
          return;
        }
      }

      const nextSelection = new Map<string, Task>();
      let selectionChanged = false;

      for (const [id, snapshot] of bulkSelectionRef.current) {
        const fresh = freshTasks.get(id);
        const lookup = lookups.get(id);

        // Временная ошибка task.get: задача не найдена на странице, но её
        // существование не опровергнуто — сохраняем прежний snapshot.
        if (fresh === undefined && lookup === undefined) {
          nextSelection.set(id, snapshot);

          continue;
        }

        if (fresh === undefined && lookup === null) {
          selectionChanged = true;

          continue;
        }

        const resolved = fresh ?? lookup;

        if (resolved === undefined || resolved === null) {
          selectionChanged = true;

          continue;
        }

        nextSelection.set(id, resolved);

        if (resolved.version !== snapshot.version) {
          selectionChanged = true;
        }
      }

      if (selectionChanged) {
        bulkSelectionRef.current = nextSelection;
        setBulkSelection(nextSelection);

        if (nextSelection.size === 0) {
          setBulkDeleteOpen(false);
          setBulkDeleteError(null);
        }
      }
    }

    for (const result of results) {
      if (result.page === null) {
        continue;
      }

      const loadedIds = new Set(result.page.items.map((task) => task.id));

      for (const requirement of requirements) {
        if (requirement.columnId === result.columnId && loadedIds.has(requirement.taskId)) {
          visibilityRef.current.delete(requirement.taskId);
        }
      }
    }

    setColumns((current) => {
      if (reloadSequenceRef.current !== sequence || filterKeyRef.current !== filterKey) {
        return current;
      }

      const byId = { ...current.byId };

      for (const result of results) {
        const existing = current.byId[result.columnId];

        if (existing === undefined) {
          continue;
        }

        if (result.page === null) {
          byId[result.columnId] = { ...existing, loading: false, error: result.error };

          continue;
        }

        loadedCountsRef.current[result.columnId] = Math.max(
          KANBAN_PAGE_SIZE,
          result.page.items.length,
        );
        byId[result.columnId] = {
          ...existing,
          items: result.page.items,
          total: result.page.total,
          nextOffset: result.page.nextOffset,
          loading: false,
          error: null,
        };
      }

      return { order: current.order, byId };
    });
  }, [invoke]);

  useEffect(() => {
    const filterKey = `${effectiveProjectId}\u0000${query.tag}`;

    filtersRef.current = { projectId: effectiveProjectId, tag: query.tag };

    if (filterKeyRef.current !== filterKey) {
      filterKeyRef.current = filterKey;
      loadedCountsRef.current = {};
    }

    void reloadBoard();
  }, [reloadBoard, effectiveProjectId, query.tag, query.revision]);

  // Смена tag не должна оставлять в массовом выборе скрытые фильтром задачи:
  // пользователь не видит их на доске, но действие затронуло бы.
  useEffect(() => {
    if (bulkFilterTagRef.current === query.tag) {
      return;
    }

    bulkFilterTagRef.current = query.tag;

    const tag = normalizeFilterTag(query.tag);
    const current = bulkSelectionRef.current;
    const next = new Map<string, Task>();

    for (const [id, task] of current) {
      if (tag.length === 0 || task.tags.includes(tag)) {
        next.set(id, task);
      }
    }

    if (next.size !== current.size) {
      bulkSelectionRef.current = next;
      setBulkSelection(next);
    }

    setBulkError(null);

    if (next.size === 0) {
      setBulkDeleteOpen(false);
      setBulkDeleteError(null);
    }
  }, [query.tag]);

  // Target обязан быть фактической колонкой текущего проекта.
  useEffect(() => {
    if (columnList.length === 0) {
      if (bulkTargetId !== "") {
        setBulkTargetId("");
      }

      return;
    }

    if (!columnList.some((column) => column.id === bulkTargetId)) {
      setBulkTargetId(columnList[0]?.id ?? "");
    }
  }, [bulkTargetId, columnList]);

  // Первая фактическая колонка должна быть активной после загрузки/смены
  // проекта. Браузер иногда восстанавливает горизонтальный scroll контейнера
  // (например, после full navigation), поэтому сбрасываем его один раз на
  // проект/фильтр и только затем разрешаем scroll-наблюдателю менять вкладку.
  const initialColumnKeyRef = useRef<string>("");

  // Данные A не должны переезжать в B вместе с оптимистичными состояниями.
  useEffect(() => {
    projectGenerationRef.current += 1;
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    dragSuppressRef.current = null;
    deleteDialogRef.current = null;
    deleteDialogRequestRef.current += 1;
    deleteCountRequestRef.current += 1;
    bulkSelectionRef.current = new Map();
    bulkGuardRef.current = false;
    setBulkSelection(new Map());
    setBulkTargetId("");
    setBulkPending(false);
    setBulkError(null);
    setBulkDeleteOpen(false);
    setBulkDeleteError(null);
    placementsRef.current = new Map();
    pendingRef.current = new Set();
    visibilityRef.current.clear();
    loadedCountsRef.current = {};
    setPlacements(new Map());
    setPending(new Set());
    setConflicts(new Set());
    setDraggingId(null);
    setDragOver(null);
    setColumnPending(new Set());
    setColumnConflicts(new Set());
    setColumnDraggingId(null);
    setColumnDragOver(null);
    setRenamingColumnId(null);
    setRenameError(null);
    setDeletingColumnId(null);
    setDeleteError(null);
    setDeleteCount(null);
    setDeleteCountError(null);
    deleteCountRequestRef.current += 1;
    setColumnNotice(null);
    setFormMode(null);
    setFormError(null);
    setActiveColumnId("");
    setError(null);
    initialColumnKeyRef.current = "";
  }, [effectiveProjectId]);

  // Размонтирование доски инвалидирует все незавершённые операции и снимает
  // pointer listeners. effectiveProjectIdRef пуст, поэтому захваченный ранее
  // project/generation больше не пройдёт проверку перед mutation.
  useEffect(
    () => () => {
      projectGenerationRef.current += 1;
      effectiveProjectIdRef.current = "";
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      dragSuppressRef.current = null;
      deleteDialogRef.current = null;
      deleteDialogRequestRef.current += 1;
      deleteCountRequestRef.current += 1;
      bulkGuardRef.current = false;
      bulkSelectionRef.current = new Map();
    },
    [],
  );

  useEffect(() => {
    if (boardColumns.order.length === 0) {
      return;
    }

    const key = `${effectiveProjectId}\u0000${query.tag}`;

    if (initialColumnKeyRef.current === key) {
      return;
    }

    initialColumnKeyRef.current = key;
    setActiveColumnId(boardColumns.order[0] ?? "");

    const container = columnsScrollRef.current;

    if (container === null) {
      return;
    }

    container.scrollLeft = 0;
    const frame = requestAnimationFrame(() => {
      container.scrollLeft = 0;
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [boardColumns.order, effectiveProjectId, query.tag]);

  // Активная вкладка всегда указывает на существующую колонку.
  useEffect(() => {
    if (boardColumns.order.length === 0) {
      if (activeColumnId !== "") {
        setActiveColumnId("");
      }

      return;
    }

    if (!boardColumns.order.includes(activeColumnId)) {
      setActiveColumnId(boardColumns.order[0] ?? "");
    }
  }, [boardColumns.order, activeColumnId]);

  const renderedColumns = useMemo(
    () => applyPlacements(boardColumns, placements),
    [boardColumns, placements],
  );

  const renderedColumnList = useMemo(() => getColumns(renderedColumns), [renderedColumns]);

  const boardSettled = renderedColumnList.every((column) => !column.loading);

  const scrollToColumn = useCallback((columnId: string): void => {
    setActiveColumnId(columnId);

    const container = columnsScrollRef.current;

    if (container === null) {
      return;
    }

    const target = [...container.querySelectorAll<HTMLElement>("[data-kanban-column-id]")].find(
      (element) => element.getAttribute("data-kanban-column-id") === columnId,
    );

    if (target === undefined) {
      return;
    }

    const left =
      target.getBoundingClientRect().left -
      container.getBoundingClientRect().left +
      container.scrollLeft;

    if (typeof container.scrollTo === "function") {
      container.scrollTo({ left, behavior: "smooth" });
    } else {
      container.scrollLeft = left;
    }
  }, []);

  const updateScrollHints = useCallback((): void => {
    const container = columnsScrollRef.current;

    if (container === null) {
      return;
    }

    const maxScroll = container.scrollWidth - container.clientWidth;
    const next = {
      left: container.scrollLeft > 2,
      right: maxScroll - container.scrollLeft > 2,
    };

    setScrollHints((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);

  useEffect(() => {
    const container = columnsScrollRef.current;

    if (container === null) {
      return;
    }

    const onScroll = (): void => {
      updateScrollHints();

      const containerLeft = container.getBoundingClientRect().left;
      let closest: string | null = null;
      let distance = Number.POSITIVE_INFINITY;

      for (const element of container.querySelectorAll<HTMLElement>("[data-kanban-column-id]")) {
        const id = element.getAttribute("data-kanban-column-id");

        if (id === null) {
          continue;
        }

        const value = Math.abs(element.getBoundingClientRect().left - containerLeft);

        if (value < distance) {
          distance = value;
          closest = id;
        }
      }

      if (closest !== null) {
        setActiveColumnId((current) => (current === closest ? current : closest));
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateScrollHints);

    let observer: ResizeObserver | null = null;

    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateScrollHints);
      observer.observe(container);
    }

    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateScrollHints);
      observer?.disconnect();
    };
    // Контейнер появляется только после загрузки проектов: эффект обязан
    // перезапуститься, когда доска впервые монтируется.
  }, [updateScrollHints, effectiveProjectId, projectsLoading]);

  useEffect(() => {
    const frame = requestAnimationFrame(updateScrollHints);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [renderedColumns, effectiveProjectId, updateScrollHints]);

  // Колонки получают собственную высоту в пределах viewport, иначе длинная
  // колонка растягивает страницу, а не прокручивается внутри себя.
  useEffect(() => {
    const container = columnsScrollRef.current;

    if (container === null) {
      return;
    }

    const update = (): void => {
      const top = container.getBoundingClientRect().top;
      const reserve = window.innerWidth < 768 ? 96 : 24;
      const next = Math.max(240, Math.round(window.innerHeight - top - reserve));

      setColumnsHeight((current) => (current === next ? current : next));
    };

    update();
    window.addEventListener("resize", update);

    let observer: ResizeObserver | null = null;

    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(container.parentElement ?? container);
    }

    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [effectiveProjectId, formMode, projectsLoading, renderedColumns, summary, summaryLoading]);

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, columnId: string): void => {
    const order = renderedColumns.order;
    const index = order.indexOf(columnId);
    let nextIndex = -1;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % order.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + order.length) % order.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = order.length - 1;
    }

    if (nextIndex < 0) {
      return;
    }

    const nextId = order[nextIndex];

    if (nextId === undefined) {
      return;
    }

    event.preventDefault();
    scrollToColumn(nextId);
    tabRefs.current[nextId]?.focus();
  };

  const rootTaskIds = useMemo(() => {
    const ids: string[] = [];

    for (const column of renderedColumnList) {
      for (const task of column.items) {
        if (task.parentTaskId === null) {
          ids.push(task.id);
        }
      }
    }

    return [...new Set(ids)];
  }, [renderedColumnList]);
  const rootTaskKey = rootTaskIds.join("|");

  useEffect(() => {
    if (rootTaskIds.length === 0) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const entries = await Promise.all(
        rootTaskIds.map(async (taskId) => {
          try {
            const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
              parentTaskId: taskId,
              limit: 1,
              offset: 0,
            } as unknown as JsonValue);

            return [taskId, data.total] as const;
          } catch {
            return [taskId, null] as const;
          }
        }),
      );

      if (!cancelled) {
        setSubtaskCounts((current) => ({ ...current, ...Object.fromEntries(entries) }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // rootTaskKey стабилен между рендерами при том же наборе карточек.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, rootTaskKey, query.revision]);

  const setPendingCard = (taskId: string, value: boolean): void => {
    const next = new Set(pendingRef.current);

    if (value) {
      next.add(taskId);
    } else {
      next.delete(taskId);
    }

    pendingRef.current = next;
    setPending(next);
  };

  const setPlacement = (taskId: string, placement: Placement | null): void => {
    const next = new Map(placementsRef.current);

    if (placement === null) {
      next.delete(taskId);
    } else {
      next.set(taskId, placement);
    }

    placementsRef.current = next;
    setPlacements(next);
  };

  const setConflict = (taskId: string, value: boolean): void => {
    setConflicts((current) => {
      const next = new Set(current);

      if (value) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }

      return next;
    });
  };

  const moveTask = async (
    task: Task,
    columnId: string,
    intent: MoveIntent,
    placement: Placement,
  ): Promise<void> => {
    const context = operationContext();

    if (
      task.projectId !== context.projectId ||
      currentColumn(columnId) === null ||
      pendingRef.current.has(task.id)
    ) {
      return;
    }

    setPlacement(task.id, placement);
    setPendingCard(task.id, true);
    setConflict(task.id, false);
    setError(null);
    setDraggingId(null);
    setDragOver(null);

    try {
      const scopeTasks = await fetchAllScopeTasks(invoke, task.projectId, columnId);

      // Проект мог переключиться, пока читался полный scope: устаревшую
      // команду не отправляем и отменяем optimistic placement.
      if (!isOperationCurrent(context) || currentColumn(columnId) === null) {
        visibilityRef.current.delete(task.id);

        return;
      }

      const position = resolveMovePosition(scopeTasks, task.id, intent);

      loadedCountsRef.current[columnId] = Math.max(
        loadedCountsRef.current[columnId] ?? KANBAN_PAGE_SIZE,
        position + 1,
      );
      visibilityRef.current.set(task.id, {
        taskId: task.id,
        columnId,
        position,
        filterKey: filterKeyRef.current,
      });

      await invokeJson(invoke, TASKS_COMMAND_IDS.taskMove, {
        id: task.id,
        expectedVersion: task.version,
        columnId,
        ...(currentColumn(columnId) === null ? {} : { status: currentColumn(columnId)?.status }),
        position,
      } as unknown as JsonValue);

      await reloadBoard();
      bumpKanbanRevision();
    } catch (commandError) {
      visibilityRef.current.delete(task.id);

      if (isVersionConflict(commandError)) {
        setConflict(task.id, true);
        setError(VERSION_CONFLICT_MESSAGE);
        await reloadBoard();
      } else {
        setError(errorMessage(commandError));
      }
    } finally {
      setPlacement(task.id, null);
      setPendingCard(task.id, false);
    }
  };

  const moveToColumn = (task: Task, columnId: string): void => {
    void moveTask(task, columnId, { kind: "append" }, { columnId, beforeId: null });
  };

  const toggleBulkSelection = (task: Task, checked: boolean): void => {
    if (bulkGuardRef.current || task.projectId !== effectiveProjectIdRef.current) {
      return;
    }

    const next = new Map(bulkSelectionRef.current);

    if (checked) {
      // Повторный set существующего ключа не меняет порядок выбора, но
      // обновляет snapshot версии.
      next.set(task.id, task);
    } else {
      next.delete(task.id);
    }

    bulkSelectionRef.current = next;
    setBulkSelection(next);
    setBulkError(null);

    if (next.size === 0) {
      setBulkDeleteOpen(false);
      setBulkDeleteError(null);
    }
  };

  const clearBulkSelection = (): void => {
    if (bulkGuardRef.current) {
      return;
    }

    bulkSelectionRef.current = new Map();
    setBulkSelection(new Map());
    setBulkError(null);
    setBulkDeleteOpen(false);
    setBulkDeleteError(null);
  };

  const bulkMove = async (): Promise<void> => {
    if (bulkGuardRef.current || bulkSelectionRef.current.size === 0) {
      return;
    }

    const target = currentColumn(bulkTargetId);

    if (target === null) {
      setBulkError("Выберите существующую колонку текущего проекта");
      return;
    }

    if (bulkSelectionRef.current.size > MAX_LIST_LIMIT) {
      setBulkError(`За один раз можно переместить не больше ${String(MAX_LIST_LIMIT)} задач`);
      return;
    }

    const context = operationContext();
    const items = [...bulkSelectionRef.current.values()].map((task) => ({
      id: task.id,
      expectedVersion: task.version,
    }));

    bulkGuardRef.current = true;
    setBulkPending(true);
    setBulkError(null);

    try {
      // Порядок items — порядок выбора; target append выполняет домен.
      await invokeJson<{ readonly tasks: readonly Task[] }>(
        invoke,
        BULK_TASK_COMMAND_IDS.taskMoveMany,
        { items, columnId: target.id } as unknown as JsonValue,
      );

      if (!isOperationCurrent(context)) {
        return;
      }

      bulkSelectionRef.current = new Map();
      setBulkSelection(new Map());
      setBulkDeleteOpen(false);
      setBulkDeleteError(null);

      await reloadBoard();

      if (!isOperationCurrent(context)) {
        return;
      }

      bumpKanbanRevision();
    } catch (commandError) {
      if (!isOperationCurrent(context)) {
        return;
      }

      // Даже обычная ошибка перечитывает доску: повтор должен использовать
      // актуальные версии, а исчезнувшие задачи — выпасть из выбора.
      await reloadBoard();

      if (!isOperationCurrent(context)) {
        return;
      }

      setBulkError(
        isVersionConflict(commandError)
          ? BULK_VERSION_CONFLICT_MESSAGE
          : errorMessage(commandError),
      );
    } finally {
      bulkGuardRef.current = false;
      setBulkPending(false);
    }
  };

  const openBulkDelete = (): void => {
    if (bulkGuardRef.current || bulkSelectionRef.current.size === 0) {
      return;
    }

    setBulkDeleteError(null);
    setBulkDeleteOpen(true);
  };

  const cancelBulkDelete = (): void => {
    if (bulkGuardRef.current) {
      return;
    }

    setBulkDeleteOpen(false);
    setBulkDeleteError(null);
  };

  const confirmBulkDelete = async (): Promise<void> => {
    if (bulkGuardRef.current || bulkSelectionRef.current.size === 0) {
      return;
    }

    const context = operationContext();
    const items = [...bulkSelectionRef.current.values()].map((task) => ({
      id: task.id,
      expectedVersion: task.version,
    }));

    bulkGuardRef.current = true;
    setBulkPending(true);
    setBulkDeleteError(null);

    try {
      await invokeJson(invoke, BULK_TASK_COMMAND_IDS.taskDeleteMany, {
        items,
        confirm: true,
      } as unknown as JsonValue);

      if (!isOperationCurrent(context)) {
        return;
      }

      bulkSelectionRef.current = new Map();
      setBulkSelection(new Map());
      setBulkDeleteOpen(false);
      setBulkDeleteError(null);
      setBulkError(null);

      await reloadBoard();

      if (!isOperationCurrent(context)) {
        return;
      }

      bumpKanbanRevision();
    } catch (commandError) {
      if (!isOperationCurrent(context)) {
        return;
      }

      await reloadBoard();

      if (!isOperationCurrent(context)) {
        return;
      }

      if (bulkSelectionRef.current.size === 0) {
        // Повторять нечего: выбранные задачи уже удалены или скрыты.
        setBulkDeleteOpen(false);
        setBulkDeleteError(null);

        return;
      }

      setBulkDeleteError(
        isVersionConflict(commandError)
          ? BULK_VERSION_CONFLICT_MESSAGE
          : errorMessage(commandError),
      );
    } finally {
      bulkGuardRef.current = false;
      setBulkPending(false);
    }
  };

  const reorder = (task: Task, kind: KanbanReorderKind): void => {
    if (task.projectId !== effectiveProjectId) {
      return;
    }

    const columnId = columnContainingTask(renderedColumns, task.id);

    if (columnId === null) {
      return;
    }

    const column = getColumn(renderedColumns, columnId);

    if (column === null) {
      return;
    }

    const items = column.items;
    const index = items.findIndex((candidate) => candidate.id === task.id);

    if (index === -1) {
      return;
    }

    const targetIndex =
      kind === "start" ? 0 : kind === "end" ? items.length : kind === "up" ? index - 1 : index + 1;
    const placement = placementForIndex(columnId, items, task.id, targetIndex);
    const intent: MoveIntent =
      kind === "start"
        ? { kind: "start" }
        : kind === "end"
          ? { kind: "append" }
          : visibleMoveIntent(items, task.id, placement);

    void moveTask(task, columnId, intent, placement);
  };

  const loadMore = (columnId: string): void => {
    if (currentColumn(columnId) === null) {
      return;
    }

    const current = getColumn(boardColumns, columnId);

    if (current === null) {
      return;
    }

    const cursor = current.nextOffset;

    if (cursor === null) {
      return;
    }

    const generation = reloadSequenceRef.current;
    const filterKey = filterKeyRef.current;
    const filters = filtersRef.current;
    const request = (loadMoreSequenceRef.current[columnId] ?? 0) + 1;

    loadMoreSequenceRef.current = {
      ...loadMoreSequenceRef.current,
      [columnId]: request,
    };

    setColumns((previous) => {
      const target = previous.byId[columnId];

      if (target === undefined) {
        return previous;
      }

      return {
        order: previous.order,
        byId: { ...previous.byId, [columnId]: { ...target, loading: true } },
      };
    });

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(
          invoke,
          TASKS_QUERY_IDS.taskList,
          listInput(columnId, filters.projectId, filters.tag, KANBAN_PAGE_SIZE, cursor),
        );

        const items = data.items.map(
          (task) => ({ ...task, columnId: task.columnId ?? columnId }) as Task,
        );
        const isCurrent = (): boolean =>
          reloadSequenceRef.current === generation &&
          (loadMoreSequenceRef.current[columnId] ?? 0) === request &&
          filterKeyRef.current === filterKey;

        if (!isCurrent()) {
          return;
        }

        const known = new Set(current.items.map((task) => task.id));
        const appended = items.filter((task) => !known.has(task.id));

        if (appended.length === 0) {
          await reloadBoard();

          return;
        }

        setColumns((previous) => {
          if (!isCurrent()) {
            return previous;
          }

          const existing = previous.byId[columnId];

          if (existing === undefined) {
            return previous;
          }

          const knownIds = new Set(existing.items.map((task) => task.id));
          const fresh = items.filter((task) => !knownIds.has(task.id));
          const nextItems = [...existing.items, ...fresh];

          loadedCountsRef.current[columnId] = nextItems.length;

          return {
            order: previous.order,
            byId: {
              ...previous.byId,
              [columnId]: {
                ...existing,
                items: nextItems,
                total: data.total,
                nextOffset: data.nextOffset,
                loading: false,
                error: null,
              },
            },
          };
        });
      } catch (loadError) {
        if (
          reloadSequenceRef.current !== generation ||
          (loadMoreSequenceRef.current[columnId] ?? 0) !== request ||
          filterKeyRef.current !== filterKey
        ) {
          return;
        }

        setColumns((previous) => {
          const target = previous.byId[columnId];

          if (target === undefined) {
            return previous;
          }

          return {
            order: previous.order,
            byId: {
              ...previous.byId,
              [columnId]: { ...target, loading: false, error: errorMessage(loadError) },
            },
          };
        });
      }
    })();
  };

  const resolveDropTarget = (
    clientX: number,
    clientY: number,
    draggedId: string,
  ): DropTarget | null => {
    if (typeof document.elementFromPoint !== "function") {
      return null;
    }

    const element = document.elementFromPoint(clientX, clientY);

    if (element === null) {
      return null;
    }

    const columnId = columnIdAt(element);

    if (columnId === null) {
      return null;
    }

    const card = element.closest<HTMLElement>("[data-card-id]");
    const cardId = card?.getAttribute("data-card-id") ?? null;
    const columnElement = element.closest<HTMLElement>("[data-kanban-column-id]");
    const inTopZone = element.closest<HTMLElement>('[data-kanban-drop-zone="top"]') !== null;

    if (inTopZone) {
      const firstCard = columnElement?.querySelector<HTMLElement>("[data-card-id]") ?? null;
      const firstId = firstCard?.getAttribute("data-card-id") ?? null;

      if (firstId === null) {
        return { columnId, beforeId: null };
      }

      return firstId === draggedId ? null : { columnId, beforeId: firstId };
    }

    if (card === null || cardId === null) {
      const candidates = [
        ...(columnElement?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []),
      ].filter((candidate) => candidate.getAttribute("data-card-id") !== draggedId);
      const next = candidates.find((candidate) => {
        const rect = candidate.getBoundingClientRect();

        return clientY < rect.top + rect.height / 2;
      });

      // Промежуток между карточками — не append: выбираем ближайшую границу
      // по геометрии исходных карточек, не меняя их положение индикатором.
      return {
        columnId,
        beforeId: next?.getAttribute("data-card-id") ?? null,
      };
    }

    if (cardId === draggedId) {
      return null;
    }

    const rect = card.getBoundingClientRect();
    const before = clientY < rect.top + rect.height / 2;

    if (before) {
      return { columnId, beforeId: cardId };
    }

    const cards = [...(columnElement?.querySelectorAll<HTMLElement>("[data-card-id]") ?? [])];
    const next = cards[cards.indexOf(card) + 1]?.getAttribute("data-card-id") ?? null;

    return next === draggedId ? null : { columnId, beforeId: next };
  };

  const consumeDragClickSuppression = (taskId: string): boolean => {
    const current = dragSuppressRef.current;

    if (current === null || current.taskId !== taskId) {
      return false;
    }

    dragSuppressRef.current = null;

    return performance.now() <= current.until;
  };

  /**
   * Начинает drag карточки из любой неинтерактивной области.
   *
   * Мышь/перо активируются после сдвига на `DRAG_THRESHOLD`; touch требует
   * long press, чтобы вертикальный scroll колонки оставался рабочим. Никакой
   * click не подавляется до фактического drag: обычный клик по заголовку
   * открывает карточку.
   */
  const startDrag = (task: Task, event: ReactPointerEvent<HTMLElement>): void => {
    if (task.projectId !== effectiveProjectId || !boardReady) {
      return;
    }

    dragCleanupRef.current?.();
    dragCleanupRef.current = null;

    const isTouch = event.pointerType === "touch";
    const pointerId = event.pointerId;
    const captureTarget = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const sourceRect = captureTarget.getBoundingClientRect();

    dragPreviewOffsetRef.current = {
      x: startX - sourceRect.left,
      y: startY - sourceRect.top,
    };

    let active = false;
    let armed = !isTouch;
    let target: DropTarget | null = null;
    let longPressTimer: number | null = null;
    let touchMoveBlocker: ((moveEvent: TouchEvent) => void) | null = null;

    const activate = (clientX = startX, clientY = startY): void => {
      if (active) {
        return;
      }

      active = true;
      setDraggingId(task.id);

      const clone = captureTarget.cloneNode(true) as HTMLElement;
      const clonedElements = [
        clone,
        ...clone.querySelectorAll<HTMLElement>("[data-testid], [data-card-id], [id]"),
      ];

      for (const element of clonedElements) {
        element.removeAttribute("data-testid");
        element.removeAttribute("data-card-id");
        element.removeAttribute("id");
      }

      for (const interactive of clone.querySelectorAll<HTMLElement>("button, a, input, textarea")) {
        interactive.tabIndex = -1;
      }

      clone.style.opacity = "1";
      clone.style.boxShadow = "0 16px 36px rgb(15 23 42 / 0.28)";
      clone.style.cursor = "grabbing";

      setDragPreview({
        html: clone.outerHTML,
        left: clientX - dragPreviewOffsetRef.current.x,
        top: clientY - dragPreviewOffsetRef.current.y,
        width: sourceRect.width,
      });
    };

    const armTouch = (): void => {
      longPressTimer = null;

      if (active) {
        return;
      }

      // После long press блокируем прокрутку, пока пользователь не отпустит
      // палец: иначе браузер начнёт pan и отменит pointer-события.
      armed = true;
      activate();
      touchMoveBlocker = (moveEvent: TouchEvent): void => {
        if (moveEvent.cancelable) {
          moveEvent.preventDefault();
        }
      };
      document.addEventListener("touchmove", touchMoveBlocker, { passive: false });

      // После long press удерживаем pointer на карточке, даже если палец
      // сместился за её границы.
      try {
        captureTarget.setPointerCapture(pointerId);
      } catch {
        // Браузер может уже снять pointer capture; drag продолжает работать
        // через window listeners.
      }
    };

    if (isTouch) {
      longPressTimer = window.setTimeout(armTouch, TOUCH_LONG_PRESS_MS);
    }

    const cleanup = (): void => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }

      if (touchMoveBlocker !== null) {
        document.removeEventListener("touchmove", touchMoveBlocker);
        touchMoveBlocker = null;
      }

      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      setDraggingId(null);
      setDragPreview(null);
      setDragOver(null);

      if (dragCleanupRef.current === cleanup) {
        dragCleanupRef.current = null;
      }
    };

    dragCleanupRef.current = cleanup;

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);

      if (!active) {
        if (!armed) {
          // До long press заметный сдвиг — это вертикальный scroll, а не drag.
          if (distance > TOUCH_SCROLL_TOLERANCE) {
            cleanup();
          }

          return;
        }

        if (distance < DRAG_THRESHOLD) {
          return;
        }

        activate(moveEvent.clientX, moveEvent.clientY);
      }

      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }

      setDragPreview((current) =>
        current === null
          ? null
          : {
              ...current,
              left: moveEvent.clientX - dragPreviewOffsetRef.current.x,
              top: moveEvent.clientY - dragPreviewOffsetRef.current.y,
            },
      );
      target = resolveDropTarget(moveEvent.clientX, moveEvent.clientY, task.id);
      setDragOver(target);
    };

    const isOriginalPlacement = (drop: DropTarget): boolean => {
      const currentColumnId = columnContainingTask(columnsRef.current, task.id);

      if (currentColumnId !== drop.columnId) {
        return false;
      }

      const items = getColumn(columnsRef.current, currentColumnId)?.items ?? [];
      const currentIndex = items.findIndex((candidate) => candidate.id === task.id);

      return currentIndex >= 0 && drop.beforeId === (items[currentIndex + 1]?.id ?? null);
    };

    const onPointerUp = (): void => {
      const drop = target;
      const wasActive = active;

      cleanup();

      if (wasActive) {
        dragSuppressRef.current = {
          taskId: task.id,
          until: performance.now() + CLICK_SUPPRESSION_MS,
        };
      }

      if (wasActive && drop !== null && drop.beforeId !== task.id && !isOriginalPlacement(drop)) {
        const intent: MoveIntent =
          drop.beforeId === null ? { kind: "append" } : { kind: "before", beforeId: drop.beforeId };

        void moveTask(task, drop.columnId, intent, drop);
      }
    };

    const onPointerCancel = (): void => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const setColumnPendingCard = (columnId: string, value: boolean): void => {
    setColumnPending((current) => {
      const next = new Set(current);

      if (value) {
        next.add(columnId);
      } else {
        next.delete(columnId);
      }

      return next;
    });
  };

  const setColumnConflict = (columnId: string, value: boolean): void => {
    setColumnConflicts((current) => {
      const next = new Set(current);

      if (value) {
        next.add(columnId);
      } else {
        next.delete(columnId);
      }

      return next;
    });
  };

  const moveColumnToIndex = async (column: TaskColumn, targetIndex: number): Promise<void> => {
    if (columnPending.has(column.id) || currentColumn(column.id) === null) {
      return;
    }

    const context = operationContext();
    const order = columnsRef.current.order;
    const currentIndex = order.indexOf(column.id);

    if (currentIndex === -1 || targetIndex === currentIndex) {
      return;
    }

    const previousOrder = [...order];

    setColumns((current) => reorderKanbanColumns(current, column.id, targetIndex));
    setColumnPendingCard(column.id, true);
    setColumnConflict(column.id, false);
    setColumnNotice(null);
    setError(null);

    try {
      if (!isOperationCurrent(context)) {
        setColumns((current) => restoreColumnOrder(current, previousOrder));

        return;
      }

      await invokeJson(invoke, TASKS_COMMAND_IDS.columnMove, {
        id: column.id,
        expectedVersion: column.version,
        position: targetIndex,
      } as unknown as JsonValue);

      const refreshed = await refreshProjectColumns(column.projectId, { reportError: false });

      if (refreshed !== null) {
        setColumnNotice("Порядок колонок сохранён");
      } else {
        setError(
          "Порядок сохранён, но список колонок не обновлён. Повторите загрузку доски (обновите страницу).",
        );
      }
    } catch (commandError) {
      // Снимок порядка восстанавливается сразу и не зависит от refresh:
      // пользователь не остаётся с недоверенной перестановкой.
      setColumns((current) => restoreColumnOrder(current, previousOrder));

      const refreshed = await refreshProjectColumns(column.projectId, { reportError: false });

      if (isVersionConflict(commandError)) {
        setColumnConflict(column.id, true);

        if (refreshed === null) {
          setLoadedProjectId("");
          setError(
            "Колонка изменена в другом месте, а обновить список не удалось. Доска скрыта до повторной загрузки.",
          );
        } else {
          setError(COLUMN_VERSION_CONFLICT_MESSAGE);
        }
      } else {
        setError(errorMessage(commandError));
      }
    } finally {
      setColumnPendingCard(column.id, false);
    }
  };

  const moveColumnByStep = (column: TaskColumn, delta: -1 | 1): void => {
    const order = columnsRef.current.order;
    const index = order.indexOf(column.id);
    const targetIndex = index + delta;

    if (index === -1 || targetIndex < 0 || targetIndex >= order.length) {
      return;
    }

    void moveColumnToIndex(column, targetIndex);
  };

  const startColumnDrag = (column: TaskColumn, event: ReactPointerEvent<HTMLElement>): void => {
    if (currentColumn(column.id) === null) {
      return;
    }

    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let target: { readonly columnId: string; readonly after: boolean } | null = null;

    setColumnDraggingId(column.id);

    const resolve = (
      clientX: number,
      clientY: number,
    ): { columnId: string; after: boolean } | null => {
      if (typeof document.elementFromPoint !== "function") {
        return null;
      }

      const element = document.elementFromPoint(clientX, clientY);
      const targetElement = element?.closest<HTMLElement>("[data-kanban-column-id]") ?? null;
      const targetId = targetElement?.getAttribute("data-kanban-column-id") ?? null;

      if (targetElement === null || targetId === null || targetId === column.id) {
        return null;
      }

      const rect = targetElement.getBoundingClientRect();

      return { columnId: targetId, after: clientX > rect.left + rect.width / 2 };
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) {
        return;
      }

      active = true;
      target = resolve(moveEvent.clientX, moveEvent.clientY);
      setColumnDragOver(target);
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      setColumnDraggingId(null);
      setColumnDragOver(null);

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

      const order = columnsRef.current.order;
      const others = order.filter((id) => id !== column.id);
      const targetIndex = others.indexOf(drop.columnId);

      if (targetIndex === -1) {
        return;
      }

      const insertion = drop.after ? targetIndex + 1 : targetIndex;

      void moveColumnToIndex(column, insertion);
    };

    const onPointerCancel = (): void => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const startRenameColumn = (column: TaskColumn): void => {
    if (currentColumn(column.id) === null) {
      return;
    }

    setRenamingColumnId(column.id);
    setRenameValue(column.title);
    setRenameError(null);
    setColumnNotice(null);
  };

  const cancelRenameColumn = (): void => {
    if (renameSubmitting) {
      return;
    }

    setRenamingColumnId(null);
    setRenameError(null);
  };

  const submitRenameColumn = async (): Promise<void> => {
    if (renamingColumnId === null || renameGuardRef.current || renameSubmitting) {
      return;
    }

    const column = currentColumn(renamingColumnId);

    if (column === null) {
      setRenamingColumnId(null);

      return;
    }

    const title = renameValue.trim();

    if (title.length === 0) {
      setRenameError("Укажите название колонки");
      return;
    }

    if (title === column.title) {
      setRenamingColumnId(null);
      setRenameError(null);

      return;
    }

    renameGuardRef.current = true;
    setRenameSubmitting(true);
    setRenameError(null);
    setColumnNotice(null);

    const context = operationContext();

    try {
      if (!isOperationCurrent(context)) {
        return;
      }

      const data = await invokeJson<ColumnMutationOutput>(invoke, TASKS_COMMAND_IDS.columnUpdate, {
        id: column.id,
        expectedVersion: column.version,
        title,
      } as unknown as JsonValue);

      if (!isOperationCurrent(context)) {
        return;
      }

      // Локально фиксируем новую версию сразу: даже если refresh упадёт,
      // повторная отправка не использует устаревший expectedVersion.
      applyColumn(data.column);
      const refreshed = await refreshProjectColumns(column.projectId);

      if (!isOperationCurrent(context)) {
        return;
      }

      if (refreshed !== null) {
        setRenamingColumnId(null);
        setRenameError(null);
        setColumnNotice("Колонка переименована");
      } else {
        setRenameError(
          "Колонка переименована, но список не обновлён. Дождитесь обновления и повторите при необходимости.",
        );
      }
    } catch (commandError) {
      if (isVersionConflict(commandError)) {
        const refreshed = await refreshProjectColumns(column.projectId);

        setRenameError(
          refreshed !== null
            ? "Колонка уже изменена в другом месте. Версия обновлена — проверьте название и повторите."
            : "Колонка изменена в другом месте, но обновить список не удалось. Проверьте соединение и повторите.",
        );
      } else {
        setRenameError(errorMessage(commandError));
      }
    } finally {
      renameGuardRef.current = false;
      setRenameSubmitting(false);
    }
  };

  const beginDeleteCount = (columnId: string): void => {
    const column = currentColumn(columnId);

    if (column === null) {
      return;
    }

    const request = deleteCountRequestRef.current + 1;

    deleteCountRequestRef.current = request;
    setDeleteCount(null);
    setDeleteCountError(null);

    void (async () => {
      try {
        const total = await loadDeleteCount(column.projectId, column.id);

        if (deleteCountRequestRef.current === request) {
          setDeleteCount(total);
        }
      } catch (countError) {
        if (deleteCountRequestRef.current === request) {
          setDeleteCount(null);
          setDeleteCountError(errorMessage(countError));
        }
      }
    })();
  };

  const openDeleteColumn = (column: TaskColumn): void => {
    if (currentColumn(column.id) === null) {
      return;
    }

    const nextTarget = defaultDeleteTargetColumn(columnList, column.id);

    deleteDialogRequestRef.current += 1;
    deleteDialogRef.current = {
      requestId: deleteDialogRequestRef.current,
      columnId: column.id,
      targetId: nextTarget ?? "",
    };
    setDeletingColumnId(column.id);
    setDeleteTargetId(nextTarget ?? "");
    setDeleteError(null);
    setColumnNotice(null);
    beginDeleteCount(column.id);
  };

  const cancelDeleteColumn = (): void => {
    if (deleteSubmitting) {
      return;
    }

    deleteCountRequestRef.current += 1;
    deleteDialogRequestRef.current += 1;
    deleteDialogRef.current = null;
    setDeletingColumnId(null);
    setDeleteError(null);
    setDeleteCount(null);
    setDeleteCountError(null);
  };

  const confirmDeleteColumn = async (): Promise<void> => {
    if (
      deletingColumnId === null ||
      deleteGuardRef.current ||
      deleteSubmitting ||
      deleteCount === null ||
      deleteCountError !== null
    ) {
      return;
    }

    const column = currentColumn(deletingColumnId);
    const target = currentColumn(deleteTargetId);

    if (column === null) {
      setDeletingColumnId(null);

      return;
    }

    if (target === null) {
      setDeleteError("Выберите колонку текущего проекта для переноса задач");
      return;
    }

    deleteGuardRef.current = true;
    setDeleteSubmitting(true);
    setDeleteError(null);
    setColumnNotice(null);

    const context = operationContext();
    const dialog = deleteDialogRef.current;

    const dialogStillCurrent = (): boolean =>
      isOperationCurrent(context) &&
      dialog !== null &&
      deleteDialogRef.current?.requestId === dialog.requestId &&
      deleteDialogRef.current.columnId === dialog.columnId &&
      deleteDialogRef.current.targetId === dialog.targetId;

    try {
      // Повторная точная проверка перед разрушительной командой: счётчик не
      // зависит от активного tag и скрытых фильтром задач.
      const total = await loadDeleteCount(column.projectId, column.id);

      if (!dialogStillCurrent()) {
        return;
      }

      if (total !== deleteCount) {
        setDeleteCount(total);
        setDeleteError(
          `Последствия изменились: теперь будет перенесено задач: ${String(total)}. Подтвердите удаление снова.`,
        );

        return;
      }

      setDeleteCount(total);

      if (!dialogStillCurrent()) {
        return;
      }

      await invokeJson(invoke, TASKS_COMMAND_IDS.columnDelete, {
        id: column.id,
        expectedVersion: column.version,
        confirm: true,
        targetColumnId: target.id,
      } as unknown as JsonValue);

      const refreshed = await refreshProjectColumns(column.projectId);

      if (!isOperationCurrent(context)) {
        return;
      }

      if (activeColumnId === column.id) {
        setActiveColumnId(target.id);
      }

      setDeletingColumnId(null);
      deleteDialogRef.current = null;
      setDeleteCount(null);
      setDeleteCountError(null);
      bumpKanbanRevision();

      if (refreshed !== null) {
        setColumnNotice("Колонка удалена, задачи перенесены");
      } else {
        setError(
          "Колонка удалена, но список колонок не обновлён. Перезагрузите страницу или повторите действие.",
        );
      }
    } catch (commandError) {
      if (!isOperationCurrent(context)) {
        return;
      }

      if (isVersionConflict(commandError)) {
        const refreshed = await refreshProjectColumns(column.projectId);

        if (!dialogStillCurrent()) {
          return;
        }

        setDeleteError(
          refreshed !== null
            ? "Колонка уже изменена в другом месте. Версия обновлена — проверьте последствия и повторите."
            : "Колонка изменена в другом месте, но обновить список не удалось. Проверьте соединение и повторите.",
        );

        if (refreshed !== null && refreshed.some((entry) => entry.id === column.id)) {
          const nextTarget = defaultDeleteTargetColumn(refreshed, column.id);

          setDeleteTargetId(nextTarget ?? "");
          deleteDialogRef.current = {
            requestId: dialog?.requestId ?? -1,
            columnId: column.id,
            targetId: nextTarget ?? "",
          };
          beginDeleteCount(column.id);
        }
      } else if (deleteCountError !== null) {
        setDeleteError(deleteCountError);
      } else {
        setDeleteError(errorMessage(commandError));
      }
    } finally {
      deleteGuardRef.current = false;
      setDeleteSubmitting(false);
    }
  };

  const showBoard = onKanbanRoute && effectiveProjectId.length > 0;
  const hasFilters = query.tag.length > 0;
  const visibleTotal = renderedColumnList.reduce((sum, column) => sum + column.total, 0);
  const formColumn = currentColumn(formColumnId);
  const deletingColumn = deletingColumnId === null ? null : currentColumn(deletingColumnId);
  const headerColumns = renderedColumnList.map(({ column, total }) => ({
    id: column.id,
    title: column.title,
    slug: columnTestSlug(column),
    total,
  }));

  return (
    <div
      data-testid="kanban-view"
      className="flex min-h-0 w-full flex-1 flex-col gap-3 rounded-xl border border-border/60 bg-[#e2e8f0] p-2 sm:p-3 dark:bg-[#1e293b]"
      style={{ minWidth: 0 }}
    >
      <ProjectHeader
        variant="kanban"
        route={KANBAN_ROUTE}
        project={selectedProject}
        summary={summary}
        columnCounts={headerColumns}
        search={workspaceSearch}
        fallbackTitle={projects.length === 0 ? "Проекты" : "Выберите проект"}
        invoke={invoke}
        onProjectUpdated={bumpKanbanRevision}
        onColumnsChanged={bumpKanbanRevision}
        actions={
          onKanbanRoute ? (
            <button
              type="button"
              data-testid="kanban-create-task"
              disabled={effectiveProjectId.length === 0 || !boardReady}
              onClick={() => {
                openTaskComposer();
              }}
              className="inline-flex min-h-10 items-center rounded-md border border-transparent bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8"
            >
              Новая задача
            </button>
          ) : null
        }
      />

      <KanbanCreatePanel
        pathname={pathname}
        mode={formMode}
        session={formSession}
        projectId={effectiveProjectId}
        column={formColumn}
        projectValues={projectDraft}
        onProjectValuesChange={setProjectDraft}
        taskDraftTitle={taskDraftTitle}
        onTaskDraftTitleChange={setTaskDraftTitle}
        openerSelector={formOpenerSelector}
        submitting={formSubmitting}
        error={formError}
        onCancel={closeCreateForm}
        onCreateProject={(values) => {
          void createProject(values);
        }}
        onCreateTask={(title) => createQuickTask(formColumnId, title)}
      />

      {projectsError === null ? null : (
        <p role="alert" className="m-0 text-xs text-destructive">
          Проекты: {projectsError}
        </p>
      )}

      {summaryError === null ? null : (
        <p
          data-testid="kanban-summary-error"
          role="status"
          className="m-0 text-xs text-muted-foreground"
        >
          Сводка: {summaryError}
        </p>
      )}

      {columnNotice === null ? null : (
        <p
          data-testid="kanban-column-notice"
          role="status"
          className="m-0 rounded-lg border border-border bg-background/70 px-2.5 py-2 text-xs text-muted-foreground"
        >
          {columnNotice}
        </p>
      )}

      {error === null ? null : (
        <div
          role="alert"
          data-testid="kanban-error"
          className="rounded-lg border border-destructive bg-destructive/5 px-2.5 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {projectsLoading && projects.length === 0 ? (
        <LoadingState label="Загрузка проектов…" />
      ) : projects.length === 0 && projectsError === null ? (
        <div
          data-testid="kanban-empty-projects"
          className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-background/60 px-4 py-3"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="m-0 text-sm font-medium">Пока нет проектов</p>
            <p className="m-0 text-xs text-muted-foreground">
              Создайте первый проект, чтобы добавлять на доску задачи.
            </p>
          </div>
          <button
            type="button"
            data-testid="kanban-create-first-project"
            onClick={openProjectForm}
            className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
          >
            Создать первый проект
          </button>
        </div>
      ) : !showBoard ? (
        <div
          data-testid="kanban-project-picker"
          role="status"
          className="flex shrink-0 flex-col gap-1 rounded-lg border border-dashed border-border bg-background/70 px-4 py-4"
        >
          <p className="m-0 text-sm font-medium">Выберите проект</p>
          <p className="m-0 text-xs text-muted-foreground">
            Проекты переключаются в разделе «Проекты» боковой панели. Доска всегда показывает один
            проект.
          </p>
        </div>
      ) : (
        <>
          {boardReady ? null : (
            <p
              role="status"
              data-testid="kanban-board-loading"
              className="m-0 text-xs text-muted-foreground"
            >
              Загрузка колонок…
            </p>
          )}

          <div
            data-testid="kanban-mobile-tabs"
            role="tablist"
            aria-label="Колонки доски"
            className="flex shrink-0 gap-1 overflow-x-auto pb-0.5 md:hidden"
          >
            {renderedColumnList.map(({ column }) => {
              const slug = columnTestSlug(column);
              const active = activeColumnId === column.id;

              return (
                <button
                  key={column.id}
                  ref={(element) => {
                    tabRefs.current[column.id] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`kanban-tab-${slug}`}
                  data-testid={`kanban-tab-${slug}`}
                  aria-selected={active}
                  aria-controls={`kanban-column-${slug}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => {
                    scrollToColumn(column.id);
                  }}
                  onKeyDown={(event) => {
                    onTabKeyDown(event, column.id);
                  }}
                  className={`min-h-10 shrink-0 rounded-full px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-background text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {column.title}
                </button>
              );
            })}
          </div>

          <form
            aria-label="Фильтры канбана"
            data-testid="kanban-filters"
            onSubmit={(event) => {
              event.preventDefault();
            }}
            className="flex shrink-0 flex-wrap items-end gap-2"
          >
            <label className="flex min-w-[10rem] flex-col gap-0.5 text-[11px] text-muted-foreground">
              Тег
              <input
                name="tag"
                type="search"
                value={query.tag}
                onChange={(event) => {
                  updateKanbanQuery({ tag: event.target.value, taskId: null });
                }}
                placeholder="например, release"
                className="h-10 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:h-8"
              />
            </label>

            {hasFilters ? (
              <div
                data-testid="kanban-active-filters"
                aria-label="Активные фильтры"
                className="flex flex-wrap items-center gap-1.5"
              >
                <button
                  type="button"
                  data-testid="kanban-filter-chip-tag"
                  aria-label={`Сбросить фильтр тега «${query.tag}»`}
                  onClick={() => {
                    updateKanbanQuery({ tag: "", taskId: null });
                  }}
                  className="inline-flex min-h-10 items-center gap-1 rounded-full border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
                >
                  Тег: {query.tag}
                  <span aria-hidden="true">×</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    resetKanbanFilters();
                  }}
                  className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
                >
                  Сбросить фильтры
                </button>
              </div>
            ) : null}
          </form>

          {bulkSelection.size === 0 ? null : (
            <section
              data-testid="kanban-bulk-bar"
              aria-label="Массовые действия"
              aria-busy={bulkPending}
              className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-background/85 px-2.5 py-2"
            >
              <p
                data-testid="kanban-bulk-count"
                role="status"
                className="m-0 text-sm font-medium whitespace-nowrap"
              >
                Выбрано {bulkSelection.size}
              </p>

              <label className="flex w-full min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground sm:w-auto sm:flex-row sm:items-center sm:gap-1">
                <span className="whitespace-nowrap">Колонка</span>
                <select
                  data-testid="kanban-bulk-target"
                  aria-label="Колонка назначения"
                  value={bulkTargetId}
                  disabled={bulkPending || columnList.length === 0}
                  onChange={(event) => {
                    setBulkTargetId(event.target.value);
                    setBulkError(null);
                  }}
                  className="h-10 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 sm:w-auto xl:h-8"
                >
                  {columnList.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.title}
                      {column.status === "done" ? " (Done)" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="kanban-bulk-move"
                  disabled={bulkPending || bulkTargetId.length === 0}
                  aria-busy={bulkPending}
                  onClick={() => {
                    void bulkMove();
                  }}
                  className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {bulkPending ? "Перемещение…" : "Переместить"}
                </button>

                <button
                  type="button"
                  data-testid="kanban-bulk-delete"
                  disabled={bulkPending}
                  onClick={openBulkDelete}
                  className="inline-flex min-h-10 items-center rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Удалить
                </button>

                <button
                  type="button"
                  data-testid="kanban-bulk-clear"
                  disabled={bulkPending}
                  onClick={clearBulkSelection}
                  className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Снять выбор
                </button>
              </div>

              {bulkError === null ? null : (
                <p
                  role="alert"
                  data-testid="kanban-bulk-error"
                  className="m-0 basis-full text-xs font-medium text-destructive"
                >
                  {bulkError}
                </p>
              )}
            </section>
          )}

          {hasFilters && boardSettled && visibleTotal === 0 ? (
            <div
              data-testid="kanban-empty-filter"
              role="status"
              className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-background/60 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="m-0 text-sm font-medium">По фильтрам ничего не найдено</p>
                <p className="m-0 text-xs text-muted-foreground">
                  Измените тег, чтобы увидеть задачи.
                </p>
              </div>
              <button
                type="button"
                data-testid="kanban-empty-filter-reset"
                onClick={() => {
                  resetKanbanFilters();
                }}
                className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
              >
                Сбросить фильтры
              </button>
            </div>
          ) : null}

          <div className="relative flex min-h-0 w-full flex-1 flex-col">
            {scrollHints.right ? (
              <div
                data-testid="kanban-scroll-fade"
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-[#e2e8f0] to-transparent md:w-12 dark:from-[#1e293b]"
              />
            ) : null}

            <div
              ref={columnsScrollRef}
              data-testid="kanban-columns"
              role="region"
              aria-label="Колонки доски"
              tabIndex={0}
              className="flex min-h-0 w-full flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden pr-4 pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:snap-none md:pr-6"
              style={{
                minWidth: 0,
                WebkitOverflowScrolling: "touch",
                ...(columnsHeight === null
                  ? {}
                  : { height: `${String(columnsHeight)}px`, flex: "0 0 auto" }),
              }}
            >
              {renderedColumnList.map((columnData) => {
                const { column, items } = columnData;
                const slug = columnTestSlug(column);
                const dropActive = dragOver?.columnId === column.id;
                const dropBeforeId = dropActive ? (dragOver?.beforeId ?? null) : null;
                const insertion = dropActive
                  ? dropBeforeId === null
                    ? items.length
                    : (() => {
                        const found = items.findIndex((task) => task.id === dropBeforeId);

                        return found === -1 ? items.length : found;
                      })()
                  : -1;
                const dropIndicator = (position: "before" | "after", first = false) => (
                  <span
                    data-testid="kanban-drop-placeholder"
                    data-drop-position={position}
                    aria-hidden="true"
                    className={`pointer-events-none absolute right-0 left-0 z-20 block h-1 rounded-full bg-ring shadow-[0_0_0_2px_var(--background)] ${
                      position === "after" ? "-bottom-[5px]" : first ? "top-0" : "-top-[5px]"
                    }`}
                  />
                );
                const index = renderedColumns.order.indexOf(column.id);
                const lastOfType = isLastColumnOfType(columnList, column.id);
                const pendingColumn = columnPending.has(column.id);

                return (
                  <KanbanColumn
                    key={column.id}
                    column={column}
                    slug={slug}
                    total={columnData.total}
                    loading={columnData.loading}
                    error={columnData.error}
                    hasMore={columnData.nextOffset !== null}
                    dragOver={
                      dropActive ||
                      (columnDragOver?.columnId === column.id && columnDraggingId !== null)
                    }
                    dropActive={dropActive}
                    pending={pendingColumn}
                    conflict={columnConflicts.has(column.id)}
                    canMoveLeft={index > 0}
                    canMoveRight={index >= 0 && index < renderedColumns.order.length - 1}
                    canDelete={!lastOfType}
                    deleteDisabledReason={
                      lastOfType
                        ? `Последняя ${column.status === "done" ? "Done" : "открытая"} колонка проекта — удаление недоступно.`
                        : null
                    }
                    rename={{
                      open: renamingColumnId === column.id,
                      value: renameValue,
                      error: renameError,
                      submitting: renameSubmitting,
                    }}
                    onRenameOpen={() => {
                      startRenameColumn(column);
                    }}
                    onRenameValueChange={setRenameValue}
                    onRenameSubmit={() => {
                      void submitRenameColumn();
                    }}
                    onRenameCancel={cancelRenameColumn}
                    onMoveLeft={() => {
                      moveColumnByStep(column, -1);
                    }}
                    onMoveRight={() => {
                      moveColumnByStep(column, 1);
                    }}
                    onDelete={() => {
                      openDeleteColumn(column);
                    }}
                    onDragStart={(event) => {
                      startColumnDrag(column, event);
                    }}
                    onLoadMore={() => {
                      loadMore(column.id);
                    }}
                    onRetry={() => {
                      void reloadBoard();
                    }}
                    quickComposer={
                      onKanbanRoute ? (
                        <KanbanQuickComposer
                          column={column}
                          slug={slug}
                          projectId={effectiveProjectId}
                          disabled={effectiveProjectId.length === 0}
                          onCreate={createQuickTask}
                        />
                      ) : null
                    }
                  >
                    {items.map((task, cardIndex) => (
                      <li key={task.id} className="relative">
                        {cardIndex === insertion ? dropIndicator("before", cardIndex === 0) : null}
                        {insertion === items.length && cardIndex === items.length - 1
                          ? dropIndicator("after")
                          : null}
                        <KanbanCard
                          task={task}
                          index={cardIndex}
                          columnSize={items.length}
                          columns={columnList}
                          currentColumnId={column.id}
                          subtaskCount={
                            task.parentTaskId === null ? (subtaskCounts[task.id] ?? null) : 0
                          }
                          selected={query.taskId === task.id}
                          pending={pending.has(task.id)}
                          conflict={conflicts.has(task.id)}
                          dragging={draggingId === task.id}
                          bulkSelected={bulkSelection.has(task.id)}
                          bulkDisabled={bulkPending}
                          onBulkToggle={toggleBulkSelection}
                          onOpen={(openedTask) => {
                            updateKanbanQuery({ taskId: openedTask.id });
                          }}
                          onMoveTo={moveToColumn}
                          onReorder={reorder}
                          onDragStart={startDrag}
                          shouldSuppressClick={() => consumeDragClickSuppression(task.id)}
                          onCardPointerDown={() => {
                            dragSuppressRef.current = null;
                          }}
                        />
                      </li>
                    ))}
                    {insertion === 0 && items.length === 0 ? (
                      <li
                        data-testid="kanban-drop-placeholder"
                        data-drop-position="empty"
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 top-0 h-12 rounded-lg border-2 border-dashed border-ring bg-ring/10"
                      />
                    ) : null}
                  </KanbanColumn>
                );
              })}
            </div>

            {scrollHints.right ? (
              <div
                data-testid="kanban-scroll-hint"
                aria-hidden="true"
                className="pointer-events-none absolute right-4 bottom-3 z-20 hidden items-center rounded-full border border-border bg-background/95 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm md:flex"
              >
                Прокрутите вправо →
              </div>
            ) : null}
          </div>
        </>
      )}

      {summaryLoading && summary === null && effectiveProjectId.length > 0 ? (
        <span className="sr-only" data-testid="kanban-summary-loading">
          Сводка загружается
        </span>
      ) : null}

      {effectiveProjectId.length === 0 && projects.length > 0 ? (
        <span className="sr-only" data-testid="kanban-no-project">
          Проект не выбран
        </span>
      ) : null}

      {dragPreview === null
        ? null
        : createPortal(
            <div
              data-testid="kanban-drag-preview"
              aria-hidden="true"
              className="pointer-events-none fixed z-[100]"
              style={{
                left: dragPreview.left,
                top: dragPreview.top,
                width: dragPreview.width,
                transform: "rotate(1.5deg)",
                transformOrigin: "center",
              }}
            >
              <div dangerouslySetInnerHTML={{ __html: dragPreview.html }} />
            </div>,
            document.body,
          )}

      {deletingColumn === null ? null : (
        <KanbanDeleteColumnDialog
          column={deletingColumn}
          columns={columnList}
          taskCount={deleteCount}
          taskCountError={deleteCountError}
          targetColumnId={deleteTargetId}
          error={deleteError}
          submitting={deleteSubmitting}
          onTargetChange={(columnId) => {
            setDeleteTargetId(columnId);
            setDeleteError(null);

            if (deleteDialogRef.current !== null) {
              deleteDialogRef.current = { ...deleteDialogRef.current, targetId: columnId };
            }
          }}
          onSubmit={() => {
            void confirmDeleteColumn();
          }}
          onCancel={cancelDeleteColumn}
        />
      )}

      {!bulkDeleteOpen ? null : (
        <ModalDialog
          open
          label="Удалить выбранные задачи"
          testId="kanban-bulk-delete-dialog"
          onClose={cancelBulkDelete}
          className="m-auto w-[calc(100vw-2rem)] max-w-[30rem] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/45"
        >
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-base font-semibold">Удалить выбранные задачи?</h2>
              <p className="m-0 text-xs text-muted-foreground">
                Действие нельзя отменить. Задачи будут удалены вместе с подзадачами.
              </p>
            </div>

            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
              <p className="m-0 font-medium text-destructive">
                Будет удалено задач:{" "}
                <span data-testid="kanban-bulk-delete-count">{bulkSelection.size}</span>
              </p>
            </div>

            {bulkDeleteError === null ? null : (
              <p
                role="alert"
                data-testid="kanban-bulk-delete-error"
                className="m-0 text-xs text-destructive"
              >
                {bulkDeleteError}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                data-testid="kanban-bulk-delete-cancel"
                disabled={bulkPending}
                onClick={cancelBulkDelete}
                className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                data-testid="kanban-bulk-delete-confirm"
                disabled={bulkPending || bulkSelection.size === 0}
                aria-busy={bulkPending}
                onClick={() => {
                  void confirmBulkDelete();
                }}
                className="inline-flex min-h-10 items-center rounded-md bg-destructive px-3 text-sm font-medium text-white hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bulkPending ? "Удаление…" : "Удалить задачи"}
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
