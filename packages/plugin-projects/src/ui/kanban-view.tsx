"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  normalizeTag,
  type ProjectMutationOutput,
  type Task,
  type TaskCreateInput,
  type TaskListInput,
  type TaskListOutput,
  type TaskMutationOutput,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import {
  LoadingState,
  createProjectFormValues,
  type ProjectFormValues,
  type UiOperationInvoker,
  taskStatusLabel,
} from "@kanbaner/task-ui";

import { KANBAN_ROUTE } from "../metadata.ts";
import { KanbanCard, type KanbanReorderKind } from "./kanban-card.tsx";
import { KanbanColumn } from "./kanban-column.tsx";
import { KanbanCreatePanel, type KanbanCreateMode } from "./kanban-create.tsx";
import { KanbanQuickComposer } from "./kanban-quick-composer.tsx";
import type { TitleCreateResult } from "./title-composer.tsx";
import {
  KANBAN_PAGE_SIZE,
  KANBAN_STATUSES,
  applyPlacements,
  createEmptyColumns,
  getColumn,
  placementForIndex,
  resolveMovePosition,
  visibleMoveIntent,
  type KanbanColumns,
  type MoveIntent,
  type Placement,
} from "./board-state.ts";
import {
  VERSION_CONFLICT_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "./operations.ts";
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

interface ColumnPage {
  readonly items: readonly Task[];
  readonly total: number;
  readonly nextOffset: number | null;
}

interface VisibilityRequirement {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly position: number;
  readonly filterKey: string;
}

interface DropTarget {
  readonly status: TaskStatus;
  readonly beforeId: string | null;
}

function emptyCounts(value: number): Record<TaskStatus, number> {
  return { backlog: value, todo: value, in_progress: value, done: value };
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
  status: TaskStatus,
  projectId: string,
  tag: string,
  limit: number,
  offset: number,
): JsonValue {
  const input: TaskListInput = {
    status,
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
  status: TaskStatus,
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
      listInput(status, projectId, tag, limit, items.length),
    );

    total = data.total;
    items.push(...data.items);
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
  status: TaskStatus,
): Promise<readonly Task[]> {
  const items: Task[] = [];
  let offset = 0;

  for (;;) {
    const data = await invokeJson<TaskListOutput>(
      invoke,
      TASKS_QUERY_IDS.taskList,
      listInput(status, projectId, "", MAX_LIST_LIMIT, offset),
    );

    items.push(...data.items);

    if (data.nextOffset === null || data.items.length === 0 || data.nextOffset <= offset) {
      break;
    }

    offset = data.nextOffset;
  }

  return items;
}

function statusOf(element: Element | null): TaskStatus | null {
  const column = element?.closest<HTMLElement>("[data-kanban-column]");
  const value = column?.getAttribute("data-kanban-column") ?? null;

  return value !== null && (KANBAN_STATUSES as readonly string[]).includes(value)
    ? (value as TaskStatus)
    : null;
}

function columnContaining(columns: KanbanColumns, taskId: string): TaskStatus | null {
  for (const status of KANBAN_STATUSES) {
    if (getColumn(columns, status).items.some((task) => task.id === taskId)) {
      return status;
    }
  }

  return null;
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
  const [formStatus, setFormStatus] = useState<TaskStatus>("todo");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [projectDraft, setProjectDraft] = useState<ProjectFormValues>(createProjectFormValues);
  const [taskDraftTitle, setTaskDraftTitle] = useState("");
  const [formOpenerSelector, setFormOpenerSelector] = useState<string | undefined>(undefined);
  const [columns, setColumns] = useState<KanbanColumns>(createEmptyColumns);
  const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(() => new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [subtaskCounts, setSubtaskCounts] = useState<Readonly<Record<string, number | null>>>({});
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<DropTarget | null>(null);
  const [activeStatus, setActiveStatus] = useState<TaskStatus>("backlog");
  const [scrollHints, setScrollHints] = useState({ left: false, right: false });
  const [columnsHeight, setColumnsHeight] = useState<number | null>(null);
  const [quickResetTokens] = useState<Partial<Record<TaskStatus, number>>>({});
  const columnsRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TaskStatus, HTMLButtonElement | null>>>({});
  const loadedCountsRef = useRef<Record<TaskStatus, number>>(emptyCounts(KANBAN_PAGE_SIZE));
  const filterKeyRef = useRef<string>("\u0000");
  const filtersRef = useRef({ projectId: effectiveProjectId, tag: query.tag });
  const reloadSequenceRef = useRef(0);
  const loadMoreSequenceRef = useRef<Record<TaskStatus, number>>(emptyCounts(0));
  const visibilityRef = useRef<Map<string, VisibilityRequirement>>(new Map());
  const placementsRef = useRef<ReadonlyMap<string, Placement>>(new Map());
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  const submitGuardRef = useRef(false);

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

  const openTaskComposer = (status: TaskStatus = "todo", opener?: string): void => {
    if (effectiveProjectId.length === 0) {
      return;
    }

    setFormError(null);
    setFormStatus(status);
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

  const revealCreatedTask = async (task: Task): Promise<void> => {
    const normalizedTag = normalizeFilterTag(query.tag);
    const nextTag = query.tag.length === 0 || task.tags.includes(normalizedTag) ? query.tag : "";
    const filterKey = `${effectiveProjectId}\u0000${nextTag}`;

    loadedCountsRef.current[task.status] = Math.max(
      loadedCountsRef.current[task.status] ?? KANBAN_PAGE_SIZE,
      task.position + 1,
    );
    visibilityRef.current.set(task.id, {
      taskId: task.id,
      status: task.status,
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

  const createQuickTask = async (status: TaskStatus, title: string): Promise<TitleCreateResult> => {
    if (effectiveProjectId.length === 0) {
      return { ok: false, message: "Выберите проект" };
    }

    const trimmed = title.trim();

    if (trimmed.length === 0) {
      return { ok: false, message: "Укажите название задачи" };
    }

    const payload: TaskCreateInput = {
      projectId: effectiveProjectId,
      title: trimmed,
      descriptionMarkdown: "",
      status,
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

      await revealCreatedTask(data.task);

      return { ok: true };
    } catch (commandError) {
      return { ok: false, message: errorMessage(commandError) };
    }
  };

  const reloadBoard = useCallback(async (): Promise<void> => {
    const filters = filtersRef.current;

    if (filters.projectId.length === 0) {
      setColumns(createEmptyColumns());

      return;
    }

    const sequence = reloadSequenceRef.current + 1;
    const filterKey = filterKeyRef.current;
    const requirements = [...visibilityRef.current.values()].filter(
      (requirement) => requirement.filterKey === filterKey,
    );

    reloadSequenceRef.current = sequence;

    for (const status of KANBAN_STATUSES) {
      loadMoreSequenceRef.current = {
        ...loadMoreSequenceRef.current,
        [status]: loadMoreSequenceRef.current[status] + 1,
      };
    }

    setColumns((current) => ({
      backlog: { ...getColumn(current, "backlog"), loading: true },
      todo: { ...getColumn(current, "todo"), loading: true },
      in_progress: { ...getColumn(current, "in_progress"), loading: true },
      done: { ...getColumn(current, "done"), loading: true },
    }));

    const results = await Promise.all(
      KANBAN_STATUSES.map(async (status) => {
        const statusRequirements = requirements.filter(
          (requirement) => requirement.status === status,
        );
        const requiredIds = statusRequirements.map((requirement) => requirement.taskId);
        const requiredPosition =
          statusRequirements.length === 0
            ? 0
            : Math.max(...statusRequirements.map((requirement) => requirement.position + 1));
        const targetCount = Math.max(
          loadedCountsRef.current[status] ?? KANBAN_PAGE_SIZE,
          requiredPosition,
        );

        try {
          const page = await fetchColumnPage(
            invoke,
            status,
            filters.projectId,
            filters.tag,
            targetCount,
            requiredIds,
          );

          return { status, page, error: null } as const;
        } catch (loadError) {
          return { status, page: null, error: errorMessage(loadError) } as const;
        }
      }),
    );

    if (reloadSequenceRef.current !== sequence || filterKeyRef.current !== filterKey) {
      return;
    }

    for (const result of results) {
      if (result.page === null) {
        continue;
      }

      const loadedIds = new Set(result.page.items.map((task) => task.id));

      for (const requirement of requirements) {
        if (requirement.status === result.status && loadedIds.has(requirement.taskId)) {
          visibilityRef.current.delete(requirement.taskId);
        }
      }
    }

    setColumns((current) => {
      if (reloadSequenceRef.current !== sequence || filterKeyRef.current !== filterKey) {
        return current;
      }

      const next: Record<TaskStatus, KanbanColumns[TaskStatus]> = {
        backlog: getColumn(current, "backlog"),
        todo: getColumn(current, "todo"),
        in_progress: getColumn(current, "in_progress"),
        done: getColumn(current, "done"),
      };

      for (const result of results) {
        if (result.page === null) {
          next[result.status] = {
            ...getColumn(current, result.status),
            loading: false,
            error: result.error,
          };

          continue;
        }

        loadedCountsRef.current[result.status] = Math.max(
          KANBAN_PAGE_SIZE,
          result.page.items.length,
        );
        next[result.status] = {
          items: result.page.items,
          total: result.page.total,
          nextOffset: result.page.nextOffset,
          loading: false,
          error: null,
        };
      }

      return next;
    });
  }, [invoke]);

  useEffect(() => {
    const filterKey = `${effectiveProjectId}\u0000${query.tag}`;

    filtersRef.current = { projectId: effectiveProjectId, tag: query.tag };

    if (filterKeyRef.current !== filterKey) {
      filterKeyRef.current = filterKey;
      loadedCountsRef.current = emptyCounts(KANBAN_PAGE_SIZE);
    }

    void reloadBoard();
  }, [reloadBoard, effectiveProjectId, query.tag, query.revision]);

  const renderedColumns = useMemo(
    () => applyPlacements(columns, placements),
    [columns, placements],
  );

  const boardSettled = KANBAN_STATUSES.every((status) => !getColumn(columns, status).loading);

  const scrollToStatus = useCallback((status: TaskStatus): void => {
    setActiveStatus(status);

    const container = columnsRef.current;

    if (container === null) {
      return;
    }

    const target = container.querySelector<HTMLElement>(`[data-kanban-column="${status}"]`);

    if (target === null) {
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
    const container = columnsRef.current;

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
    const container = columnsRef.current;

    if (container === null) {
      return;
    }

    const onScroll = (): void => {
      updateScrollHints();

      const containerLeft = container.getBoundingClientRect().left;
      let closest: TaskStatus = KANBAN_STATUSES[0] ?? "backlog";
      let distance = Number.POSITIVE_INFINITY;

      for (const status of KANBAN_STATUSES) {
        const element = container.querySelector<HTMLElement>(`[data-kanban-column="${status}"]`);

        if (element === null) {
          continue;
        }

        const value = Math.abs(element.getBoundingClientRect().left - containerLeft);

        if (value < distance) {
          distance = value;
          closest = status;
        }
      }

      setActiveStatus((current) => (current === closest ? current : closest));
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
  // колонка растягивает страницу, а не прокручивается внутри себя. Нижний
  // резерв учитывает mobile bottom navigation и desktop padding shell-а.
  useEffect(() => {
    const container = columnsRef.current;

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

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, status: TaskStatus): void => {
    const index = KANBAN_STATUSES.indexOf(status);
    let nextIndex = -1;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % KANBAN_STATUSES.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + KANBAN_STATUSES.length) % KANBAN_STATUSES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = KANBAN_STATUSES.length - 1;
    }

    if (nextIndex < 0) {
      return;
    }

    const nextStatus = KANBAN_STATUSES[nextIndex];

    if (nextStatus === undefined) {
      return;
    }

    event.preventDefault();
    scrollToStatus(nextStatus);
    tabRefs.current[nextStatus]?.focus();
  };

  const rootTaskIds = useMemo(() => {
    const ids: string[] = [];

    for (const status of KANBAN_STATUSES) {
      for (const task of getColumn(renderedColumns, status).items) {
        if (task.parentTaskId === null) {
          ids.push(task.id);
        }
      }
    }

    return [...new Set(ids)];
  }, [renderedColumns]);
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
    status: TaskStatus,
    intent: MoveIntent,
    placement: Placement,
  ): Promise<void> => {
    if (pendingRef.current.has(task.id)) {
      return;
    }

    setPlacement(task.id, placement);
    setPendingCard(task.id, true);
    setConflict(task.id, false);
    setError(null);
    setDraggingId(null);
    setDragOver(null);

    try {
      const scopeTasks = await fetchAllScopeTasks(invoke, task.projectId, status);
      const position = resolveMovePosition(scopeTasks, task.id, intent);

      loadedCountsRef.current[status] = Math.max(
        loadedCountsRef.current[status] ?? KANBAN_PAGE_SIZE,
        position + 1,
      );
      visibilityRef.current.set(task.id, {
        taskId: task.id,
        status,
        position,
        filterKey: filterKeyRef.current,
      });

      await invokeJson(invoke, TASKS_COMMAND_IDS.taskMove, {
        id: task.id,
        expectedVersion: task.version,
        status,
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

  const moveToStatus = (task: Task, status: TaskStatus): void => {
    void moveTask(task, status, { kind: "append" }, { status, beforeId: null });
  };

  const reorder = (task: Task, kind: KanbanReorderKind): void => {
    const status = columnContaining(renderedColumns, task.id);

    if (status === null) {
      return;
    }

    const items = getColumn(renderedColumns, status).items;
    const index = items.findIndex((candidate) => candidate.id === task.id);

    if (index === -1) {
      return;
    }

    const targetIndex =
      kind === "start" ? 0 : kind === "end" ? items.length : kind === "up" ? index - 1 : index + 1;
    const placement = placementForIndex(status, items, task.id, targetIndex);
    const intent: MoveIntent =
      kind === "start"
        ? { kind: "start" }
        : kind === "end"
          ? { kind: "append" }
          : visibleMoveIntent(items, task.id, placement);

    void moveTask(task, status, intent, placement);
  };

  const loadMore = (status: TaskStatus): void => {
    const current = getColumn(columns, status);
    const cursor = current.nextOffset;

    if (cursor === null) {
      return;
    }

    const generation = reloadSequenceRef.current;
    const filterKey = filterKeyRef.current;
    const filters = filtersRef.current;
    const request = loadMoreSequenceRef.current[status] + 1;

    loadMoreSequenceRef.current = {
      ...loadMoreSequenceRef.current,
      [status]: request,
    };

    setColumns((previous) => ({
      ...previous,
      [status]: { ...getColumn(previous, status), loading: true },
    }));

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(
          invoke,
          TASKS_QUERY_IDS.taskList,
          listInput(status, filters.projectId, filters.tag, KANBAN_PAGE_SIZE, cursor),
        );

        const isCurrent = (): boolean =>
          reloadSequenceRef.current === generation &&
          loadMoreSequenceRef.current[status] === request &&
          filterKeyRef.current === filterKey;

        if (!isCurrent()) {
          return;
        }

        const known = new Set(current.items.map((task) => task.id));
        const appended = data.items.filter((task) => !known.has(task.id));

        if (appended.length === 0) {
          await reloadBoard();

          return;
        }

        setColumns((previous) => {
          if (!isCurrent()) {
            return previous;
          }

          const existing = getColumn(previous, status);
          const knownIds = new Set(existing.items.map((task) => task.id));
          const fresh = data.items.filter((task) => !knownIds.has(task.id));
          const items = [...existing.items, ...fresh];

          loadedCountsRef.current[status] = items.length;

          return {
            ...previous,
            [status]: {
              items,
              total: data.total,
              nextOffset: data.nextOffset,
              loading: false,
              error: null,
            },
          };
        });
      } catch (loadError) {
        if (
          reloadSequenceRef.current !== generation ||
          loadMoreSequenceRef.current[status] !== request ||
          filterKeyRef.current !== filterKey
        ) {
          return;
        }

        setColumns((previous) => ({
          ...previous,
          [status]: {
            ...getColumn(previous, status),
            loading: false,
            error: errorMessage(loadError),
          },
        }));
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

    const status = statusOf(element);

    if (status === null) {
      return null;
    }

    const card = element.closest<HTMLElement>("[data-card-id]");
    const cardId = card?.getAttribute("data-card-id") ?? null;
    const columnElement = element.closest<HTMLElement>("[data-kanban-column]");
    const inTopZone = element.closest<HTMLElement>('[data-kanban-drop-zone="top"]') !== null;

    if (inTopZone) {
      // Верхняя зона задана явным атрибутом composer/заголовка, а не
      // координатой первой карточки: при scrollTop>0 её top может быть
      // отрицательным, но drop всё равно должен вставлять перед первой.
      const firstCard = columnElement?.querySelector<HTMLElement>("[data-card-id]") ?? null;
      const firstId = firstCard?.getAttribute("data-card-id") ?? null;

      if (firstId === null) {
        return { status, beforeId: null };
      }

      // Первую карточку нельзя вставить перед ней же: это no-op, не append.
      return firstId === draggedId ? null : { status, beforeId: firstId };
    }

    if (card === null || cardId === null) {
      // Ниже карточек сохраняем append.
      return { status, beforeId: null };
    }

    if (cardId === draggedId) {
      return null;
    }

    const rect = card.getBoundingClientRect();
    const before = clientY < rect.top + rect.height / 2;

    if (before) {
      return { status, beforeId: cardId };
    }

    const cards = [...(columnElement?.querySelectorAll<HTMLElement>("[data-card-id]") ?? [])];
    const next = cards[cards.indexOf(card) + 1]?.getAttribute("data-card-id") ?? null;

    // Следующая карточка может быть самой перемещаемой: вставка перед собой
    // бессмысленна и не должна превращаться в append.
    return next === draggedId ? null : { status, beforeId: next };
  };

  const startDrag = (task: Task, event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let target: DropTarget | null = null;

    setDraggingId(task.id);

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) {
        return;
      }

      active = true;
      target = resolveDropTarget(moveEvent.clientX, moveEvent.clientY, task.id);
      setDragOver(target);
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      setDraggingId(null);
      setDragOver(null);
    };

    const onPointerUp = (): void => {
      const drop = target;

      cleanup();

      if (active && drop !== null && drop.beforeId !== task.id) {
        const intent: MoveIntent =
          drop.beforeId === null ? { kind: "append" } : { kind: "before", beforeId: drop.beforeId };

        void moveTask(task, drop.status, intent, drop);
      }
    };

    const onPointerCancel = (): void => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  const showBoard = onKanbanRoute && effectiveProjectId.length > 0;
  const hasFilters = query.tag.length > 0;
  const visibleTotal = KANBAN_STATUSES.reduce(
    (sum, status) => sum + getColumn(renderedColumns, status).total,
    0,
  );

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
        search={workspaceSearch}
        fallbackTitle={projects.length === 0 ? "Проекты" : "Выберите проект"}
        actions={
          onKanbanRoute ? (
            <button
              type="button"
              data-testid="kanban-create-task"
              disabled={effectiveProjectId.length === 0}
              onClick={() => {
                openTaskComposer("todo");
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
        status={formStatus}
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
        onCreateTask={(title) => createQuickTask(formStatus, title)}
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
          <div
            data-testid="kanban-mobile-tabs"
            role="tablist"
            aria-label="Колонки доски"
            className="flex shrink-0 gap-1 overflow-x-auto pb-0.5 md:hidden"
          >
            {KANBAN_STATUSES.map((status) => {
              const active = activeStatus === status;

              return (
                <button
                  key={status}
                  ref={(element) => {
                    tabRefs.current[status] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`kanban-tab-${status}`}
                  data-testid={`kanban-tab-${status}`}
                  aria-selected={active}
                  aria-controls={`kanban-column-${status}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => {
                    scrollToStatus(status);
                  }}
                  onKeyDown={(event) => {
                    onTabKeyDown(event, status);
                  }}
                  className={`min-h-10 shrink-0 rounded-full px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-background text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {taskStatusLabel(status)}
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
              ref={columnsRef}
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
              {KANBAN_STATUSES.map((status) => {
                const columnData = getColumn(renderedColumns, status);
                const items = columnData.items;
                const dropActive = dragOver?.status === status;
                const dropBeforeId = dropActive ? (dragOver?.beforeId ?? null) : null;
                const insertion = dropActive
                  ? dropBeforeId === null
                    ? items.length
                    : (() => {
                        const found = items.findIndex((task) => task.id === dropBeforeId);

                        return found === -1 ? items.length : found;
                      })()
                  : -1;
                const placeholder = (
                  <li
                    key={`kanban-drop-${status}`}
                    data-testid="kanban-drop-placeholder"
                    aria-hidden="true"
                    className="pointer-events-none h-12 rounded-lg border-2 border-dashed border-ring bg-ring/10"
                  />
                );

                return (
                  <KanbanColumn
                    key={status}
                    status={status}
                    total={columnData.total}
                    loading={columnData.loading}
                    error={columnData.error}
                    hasMore={columnData.nextOffset !== null}
                    dragOver={dropActive}
                    dropActive={dropActive}
                    onLoadMore={() => {
                      loadMore(status);
                    }}
                    onRetry={() => {
                      void reloadBoard();
                    }}
                    quickComposer={
                      onKanbanRoute ? (
                        <KanbanQuickComposer
                          status={status}
                          projectId={effectiveProjectId}
                          disabled={effectiveProjectId.length === 0}
                          resetToken={quickResetTokens[status] ?? 0}
                          onCreate={(title) => createQuickTask(status, title)}
                        />
                      ) : null
                    }
                  >
                    {items.map((task, index) => (
                      <Fragment key={task.id}>
                        {index === insertion ? placeholder : null}
                        <li>
                          <KanbanCard
                            task={task}
                            index={index}
                            columnSize={items.length}
                            subtaskCount={
                              task.parentTaskId === null ? (subtaskCounts[task.id] ?? null) : 0
                            }
                            selected={query.taskId === task.id}
                            pending={pending.has(task.id)}
                            conflict={conflicts.has(task.id)}
                            dragging={draggingId === task.id}
                            onOpen={(openedTask) => {
                              updateKanbanQuery({ taskId: openedTask.id });
                            }}
                            onMoveTo={moveToStatus}
                            onReorder={reorder}
                            onDragStart={startDrag}
                          />
                        </li>
                      </Fragment>
                    ))}
                    {insertion === items.length ? placeholder : null}
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
    </div>
  );
}
