"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  normalizeTag,
  type Project,
  type ProjectListOutput,
  type ProjectMutationOutput,
  type ProjectSummary,
  type ProjectSummaryOutput,
  type ProjectSummaryTotals,
  type Task,
  type TaskCreateInput,
  type TaskListInput,
  type TaskListOutput,
  type TaskMutationOutput,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import {
  createProjectFormValues,
  createTaskFormValues,
  dateInputToDueAt,
  parseTagsInput,
  taskStatusLabel,
  type ProjectFormValues,
  type TaskFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { KANBAN_ROUTE } from "../metadata.ts";
import { KanbanCard, type KanbanReorderKind } from "./kanban-card.tsx";
import { KanbanColumn } from "./kanban-column.tsx";
import { KanbanCreatePanel, type KanbanCreateMode } from "./kanban-create.tsx";
import { ProjectsGrid } from "./projects-grid.tsx";
import {
  KanbanQuickComposer,
  type QuickComposerDraft,
  type QuickCreateInput,
  type QuickCreateResult,
} from "./kanban-quick-composer.tsx";
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
  updateKanbanQuery,
  useKanbanQuery,
} from "./query-state.ts";

/** Контракт задачи ограничивает `limit` значением 200. */
const MAX_LIST_LIMIT = 200;

/** Размер страницы сетки проектов. */
const PROJECTS_PAGE_SIZE = 12;

type BoardViewMode = "board" | "projects";

interface ColumnPage {
  readonly items: readonly Task[];
  readonly total: number;
  readonly nextOffset: number | null;
}

/**
 * Требование видимости карточки после move.
 *
 * Требования хранятся по taskId, потому что одновременных перемещений может
 * быть несколько. `filterKey` привязывает требование к scope запроса: reload
 * с другим фильтром не должен преждевременно его снимать.
 */
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

/**
 * Нормализует активный фильтр тега через публичный `normalizeTag`.
 *
 * Домен хранит теги в нижнем регистре без пробелов, поэтому сравнение
 * `Release` с `release` должно учитывать нормализацию. Для пустого значения
 * возвращается пустая строка; невалидный фильтр (слишком длинный) не роняет
 * доску, а сравнивается в безопасном нижнем регистре.
 */
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
    ...(projectId.length === 0 ? {} : { projectId }),
    ...(tag.length === 0 ? {} : { tag }),
    sort: { field: "position", direction: "asc" },
    limit,
    offset,
  };

  return input as unknown as JsonValue;
}

/**
 * Читает страницу колонки, последовательно добирая до нужного количества.
 *
 * `mustIncludeIds` нужен после перемещений: каждая карточка не должна
 * исчезнуть за границей страницы, поэтому чтение продолжается, пока не
 * появятся все required ID или сервер не сообщит об окончании списка.
 * Одного `max(position)` недостаточно: при нескольких одновременных move
 * требования могут относиться к разным позициям.
 */
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

/**
 * Полный нефильтрованный упорядоченный список задач одного статуса в проекте.
 *
 * `task.move` считает `position` в области `(projectId, status)`, поэтому для
 * корректного индекса нужен весь scope, а не видимый subset с фильтром тега
 * или текущей страницей.
 */
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

/** Добавляет новую страницу сводок без дублей по projectId. */
function mergeSummaries(
  current: readonly ProjectSummary[],
  incoming: readonly ProjectSummary[],
): readonly ProjectSummary[] {
  const known = new Set(current.map((summary) => summary.project.id));
  const fresh = incoming.filter((summary) => !known.has(summary.project.id));

  return fresh.length === 0 ? current : [...current, ...fresh];
}

/** Основное представление `/view/kanban`. */
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

  useEffect(() => {
    if (replaceSearch === undefined) {
      return;
    }

    return registerKanbanSearchWriter(replaceSearch);
  }, [replaceSearch]);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<BoardViewMode>("board");
  const [projectSummaries, setProjectSummaries] = useState<readonly ProjectSummary[]>([]);
  const [summaryTotals, setSummaryTotals] = useState<ProjectSummaryTotals | null>(null);
  const [summaryTotalProjects, setSummaryTotalProjects] = useState(0);
  const [summaryNextOffset, setSummaryNextOffset] = useState<number | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryLoadingMore, setSummaryLoadingMore] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [selectedSummary, setSelectedSummary] = useState<ProjectSummary | null>(null);
  const [formMode, setFormMode] = useState<KanbanCreateMode | null>(null);
  const [formSession, setFormSession] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [taskDraft, setTaskDraft] = useState<TaskFormValues | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectFormValues>(createProjectFormValues);
  const [formOpenerSelector, setFormOpenerSelector] = useState<string | undefined>(undefined);
  const [rootTasks, setRootTasks] = useState<readonly Task[]>([]);
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
  const [quickOpenStatuses, setQuickOpenStatuses] = useState<ReadonlySet<TaskStatus>>(
    () => new Set(),
  );
  const [quickResetTokens, setQuickResetTokens] = useState<Partial<Record<TaskStatus, number>>>({});
  const columnsRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TaskStatus, HTMLButtonElement | null>>>({});
  const quickOriginRef = useRef<TaskStatus | null>(null);

  const loadedCountsRef = useRef<Record<TaskStatus, number>>(emptyCounts(KANBAN_PAGE_SIZE));
  const filterKeyRef = useRef<string>("\u0000");
  const filtersRef = useRef({ projectId: query.projectId, tag: query.tag });
  const reloadSequenceRef = useRef(0);
  const loadMoreSequenceRef = useRef<Record<TaskStatus, number>>(emptyCounts(0));
  const visibilityRef = useRef<Map<string, VisibilityRequirement>>(new Map());
  const placementsRef = useRef<ReadonlyMap<string, Placement>>(new Map());
  const pendingRef = useRef<ReadonlySet<string>>(new Set());
  const submitGuardRef = useRef(false);
  const projectsSequenceRef = useRef(0);
  const summariesRef = useRef<readonly ProjectSummary[]>([]);
  const summarySequenceRef = useRef(0);
  const selectedSummarySequenceRef = useRef(0);

  const loadProjects = useCallback(async (): Promise<void> => {
    const sequence = projectsSequenceRef.current + 1;

    projectsSequenceRef.current = sequence;

    try {
      const data = await invokeJson<ProjectListOutput>(invoke, TASKS_QUERY_IDS.projectList, {
        limit: 200,
        offset: 0,
      });

      if (projectsSequenceRef.current === sequence) {
        setProjects(data.items);
        setProjectsError(null);
        setProjectsLoaded(true);
      }
    } catch (loadError) {
      if (projectsSequenceRef.current === sequence) {
        setProjectsError(errorMessage(loadError));
        setProjectsLoaded(true);
      }
    }
  }, [invoke]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /**
   * Читает сводки проектов страницами.
   *
   * `totals` из ответа всегда описывает все подходящие проекты, поэтому
   * заголовок «Все проекты» не зависит от уже загруженной страницы. Повторный
   * вызов с `reset` перечитывает с начала — после create/move/complete/delete и
   * смены ревизии.
   */
  const loadProjectSummaries = useCallback(
    async (reset: boolean): Promise<void> => {
      const sequence = summarySequenceRef.current + 1;
      const offset = reset ? 0 : summariesRef.current.length;

      summarySequenceRef.current = sequence;

      if (reset) {
        setSummaryLoading(true);
      } else {
        setSummaryLoadingMore(true);
      }

      try {
        const data = await invokeJson<ProjectSummaryOutput>(
          invoke,
          TASKS_QUERY_IDS.projectSummary,
          { limit: PROJECTS_PAGE_SIZE, offset },
        );

        if (summarySequenceRef.current !== sequence) {
          return;
        }

        const next = reset ? data.items : mergeSummaries(summariesRef.current, data.items);

        summariesRef.current = next;
        setProjectSummaries(next);
        setSummaryTotals(data.totals);
        setSummaryTotalProjects(data.total);
        setSummaryNextOffset(data.nextOffset);
        setSummaryError(null);
      } catch (loadError) {
        if (summarySequenceRef.current === sequence) {
          setSummaryError(errorMessage(loadError));
        }
      } finally {
        if (summarySequenceRef.current === sequence) {
          setSummaryLoading(false);
          setSummaryLoadingMore(false);
        }
      }
    },
    [invoke],
  );

  const loadSelectedSummary = useCallback(async (): Promise<void> => {
    const projectId = query.projectId;
    const sequence = selectedSummarySequenceRef.current + 1;

    selectedSummarySequenceRef.current = sequence;

    if (projectId.length === 0) {
      setSelectedSummary(null);

      return;
    }

    try {
      const data = await invokeJson<ProjectSummaryOutput>(invoke, TASKS_QUERY_IDS.projectSummary, {
        projectId,
        limit: 1,
        offset: 0,
      });

      if (selectedSummarySequenceRef.current === sequence) {
        setSelectedSummary(data.items.find((summary) => summary.project.id === projectId) ?? null);
      }
    } catch {
      // Сводка вторична: ошибка не должна скрывать саму доску.
      if (selectedSummarySequenceRef.current === sequence) {
        setSelectedSummary(null);
      }
    }
  }, [invoke, query.projectId]);

  const refreshSummaries = useCallback(async (): Promise<void> => {
    await Promise.all([loadProjectSummaries(true), loadSelectedSummary()]);
  }, [loadProjectSummaries, loadSelectedSummary]);

  useEffect(() => {
    void loadProjectSummaries(true);
  }, [loadProjectSummaries, query.revision]);

  useEffect(() => {
    void loadSelectedSummary();
  }, [loadSelectedSummary, query.revision]);

  const reloadBoard = useCallback(async (): Promise<void> => {
    const sequence = reloadSequenceRef.current + 1;
    // Читаем актуальные фильтры из ref, а не из замыкания: запоздавший
    // reload после move не должен перезаписать колонку старым фильтром.
    const filters = filtersRef.current;
    const filterKey = filterKeyRef.current;
    // Снимок требований видимости: одновременно может быть несколько moves.
    // Reload с другим фильтром не должен их снимать, поэтому учитываем только
    // требования текущего filterKey.
    const requirements = [...visibilityRef.current.values()].filter(
      (requirement) => requirement.filterKey === filterKey,
    );

    reloadSequenceRef.current = sequence;

    // Любой полный reload отменяет запоздавшие loadMore: их ответ уже не
    // относится к текущему фильтру и поколению данных.
    for (const status of KANBAN_STATUSES) {
      loadMoreSequenceRef.current = {
        ...loadMoreSequenceRef.current,
        [status]: loadMoreSequenceRef.current[status] + 1,
      };
    }

    setColumns((current) => {
      const next: Record<TaskStatus, KanbanColumns[TaskStatus]> = {
        backlog: { ...getColumn(current, "backlog"), loading: true },
        todo: { ...getColumn(current, "todo"), loading: true },
        in_progress: { ...getColumn(current, "in_progress"), loading: true },
        done: { ...getColumn(current, "done"), loading: true },
      };

      return next;
    });

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
        // Цель по количеству — максимум из уже догруженного и required
        // позиций. Сами ID проверяются отдельно: только max position может
        // не покрыть все одновременные требования.
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

    // Требование снимается только когда актуальный reload действительно
    // содержит этот ID. Не найденная карточка остаётся в наборе, чтобы
    // следующий подходящий reload продолжил догрузку.
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

  const closeCreateForm = (): void => {
    // Cancel из полной формы сохраняет quick draft; связь с origin снимаем,
    // чтобы последующее создание быстрым путём не очищало чужой черновик.
    quickOriginRef.current = null;
    setFormMode(null);
    setFormError(null);
  };

  const openProjectForm = (): void => {
    quickOriginRef.current = null;
    setFormError(null);
    setProjectDraft(createProjectFormValues());
    setFormOpenerSelector('[data-testid="kanban-create-project"]');
    setFormSession((current) => current + 1);
    setFormMode("project");
  };

  const openTaskForm = (
    status: TaskStatus = "todo",
    opener?: string,
    prefill?: { readonly title?: string | undefined; readonly projectId?: string | undefined },
  ): void => {
    if (projects.length === 0) {
      return;
    }

    quickOriginRef.current = null;
    setFormError(null);
    setTaskDraft(
      createTaskFormValues(projects, {
        projectId: prefill?.projectId ?? query.projectId,
        status,
        ...(prefill?.title === undefined ? {} : { title: prefill.title }),
      }),
    );
    setFormOpenerSelector(opener ?? '[data-testid="kanban-create-task"]');
    setFormSession((current) => current + 1);
    setFormMode("task");
  };

  const openTaskFormFromQuick = (status: TaskStatus, draft: QuickComposerDraft): void => {
    if (projects.length === 0) {
      return;
    }

    openTaskForm(status, `[data-testid="kanban-quick-details-${status}"]`, {
      title: draft.title,
      projectId: draft.projectId,
    });
    // openTaskForm сбрасывает origin для обычных путей; здесь помечаем, что
    // успешное создание должно очистить originating quick draft.
    quickOriginRef.current = status;
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
      await invokeJson<ProjectMutationOutput>(invoke, TASKS_COMMAND_IDS.projectCreate, {
        title: values.title,
        descriptionMarkdown: values.descriptionMarkdown,
      });

      // Повторный project.list: созданный проект должен сразу появиться в
      // фильтрах и форме. Текущий фильтр не меняется. Сводка перечитывается,
      // чтобы сетка проектов и агрегат «Все проекты» не отставали.
      await loadProjects();
      await refreshSummaries();
      setFormMode(null);
      setFormError(null);
    } catch (commandError) {
      setFormError(errorMessage(commandError));
    } finally {
      endSubmit();
    }
  };

  /**
   * Показывает созданную задачу в её колонке, даже если она оказалась за
   * границей уже догруженной страницы.
   *
   * Позицию в scope вычисляет домен (`task.create` без `position` делает
   * атомарный append); доска не пересчитывает её вручную. Требование
   * видимости использует тот же механизм, что и move: reload читает страницы
   * target-колонки, пока не встретит созданный ID.
   */
  const revealCreatedTask = async (task: Task): Promise<void> => {
    const nextProjectId =
      query.projectId.length === 0 || query.projectId === task.projectId
        ? query.projectId
        : task.projectId;
    const normalizedTag = normalizeFilterTag(query.tag);
    const nextTag = query.tag.length === 0 || task.tags.includes(normalizedTag) ? query.tag : "";
    const filterKey = `${nextProjectId}\u0000${nextTag}`;

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

    if (nextProjectId !== query.projectId || nextTag !== query.tag) {
      // Созданная задача не попадает в текущий фильтр: переключаем только то,
      // что мешает её показать. Ревизия перечитывает доску с новым ключом.
      updateKanbanQuery({ projectId: nextProjectId, tag: nextTag, taskId: null });
      bumpKanbanRevision();

      return;
    }

    // Ревизия перечитывает доску (включая target-колонку до required ID) и
    // обновляет число подзадач у видимых корневых карточек.
    bumpKanbanRevision();
  };

  const createTask = async (values: TaskFormValues): Promise<void> => {
    if (!beginSubmit()) {
      return;
    }

    const input: TaskCreateInput = {
      projectId: values.projectId,
      title: values.title,
      descriptionMarkdown: values.descriptionMarkdown,
      status: values.status,
      priority: values.priority,
      dueAt: dateInputToDueAt(values.dueAt, "start"),
      tags: parseTagsInput(values.tags),
      ...(values.parentTaskId.length === 0 ? {} : { parentTaskId: values.parentTaskId }),
    };

    try {
      const data = await invokeJson<TaskMutationOutput>(
        invoke,
        TASKS_COMMAND_IDS.taskCreate,
        input as unknown as JsonValue,
      );

      await revealCreatedTask(data.task);
      setFormMode(null);
      setFormError(null);

      const quickOrigin = quickOriginRef.current;

      quickOriginRef.current = null;

      if (quickOrigin !== null) {
        // Полная форма была открыта из quick composer: источник больше не
        // должен хранить отправленный заголовок.
        setQuickResetTokens((current) => ({
          ...current,
          [quickOrigin]: (current[quickOrigin] ?? 0) + 1,
        }));
      }
    } catch (commandError) {
      // Форма остаётся открытой и сохраняет введённые значения.
      setFormError(errorMessage(commandError));
    } finally {
      endSubmit();
    }
  };

  /**
   * Быстрое создание по названию.
   *
   * Домен выполняет атомарный append: `position` не передаётся. После успеха
   * composer очищается, но остаётся открытым; видимость карточки обеспечивает
   * тот же `revealCreatedTask`, что и у полной формы. Ошибка возвращается в
   * composer, чтобы он сохранил введённый текст.
   */
  const createQuickTask = async (
    status: TaskStatus,
    input: QuickCreateInput,
  ): Promise<QuickCreateResult> => {
    if (input.projectId.length === 0) {
      return { ok: false, message: "Выберите проект" };
    }

    const title = input.title.trim();

    if (title.length === 0) {
      return { ok: false, message: "Укажите название задачи" };
    }

    const payload: TaskCreateInput = {
      projectId: input.projectId,
      title,
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

  useEffect(() => {
    if (formMode !== "task" || !onKanbanRoute) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
          parentTaskId: null,
          limit: MAX_LIST_LIMIT,
          offset: 0,
          sort: { field: "title", direction: "asc" },
        } as unknown as JsonValue);

        if (!cancelled) {
          setRootTasks(data.items);
        }
      } catch {
        // Родитель необязателен: задача создаётся и корневой.
        if (!cancelled) {
          setRootTasks([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke, formMode, formSession, query.revision, onKanbanRoute]);

  useEffect(() => {
    const filterKey = `${query.projectId}\u0000${query.tag}`;

    filtersRef.current = { projectId: query.projectId, tag: query.tag };

    if (filterKeyRef.current !== filterKey) {
      filterKeyRef.current = filterKey;
      loadedCountsRef.current = emptyCounts(KANBAN_PAGE_SIZE);
    }

    void reloadBoard();
  }, [reloadBoard, query.projectId, query.tag, query.revision]);

  const renderedColumns = useMemo(
    () => applyPlacements(columns, placements),
    [columns, placements],
  );

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === query.projectId) ?? null,
    [projects, query.projectId],
  );
  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title] as const)),
    [projects],
  );
  const allProjectsMode = query.projectId.length === 0;
  const hasFilters = query.projectId.length > 0 || query.tag.length > 0;
  const showingProjects = viewMode === "projects";
  const headerSummary = showingProjects || allProjectsMode ? summaryTotals : selectedSummary;
  const boardSettled = KANBAN_STATUSES.every((status) => !getColumn(columns, status).loading);
  const visibleTotal = KANBAN_STATUSES.reduce(
    (sum, status) => sum + getColumn(renderedColumns, status).total,
    0,
  );

  const openProjectBoard = useCallback((projectId: string): void => {
    setViewMode("board");
    updateKanbanQuery({ projectId, taskId: null });
  }, []);

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

    // Текущая вкладка следует за ближайшей к левому краю колонкой. Это также
    // работает при ручной прокрутке на мобильном.
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
  }, [updateScrollHints]);

  useEffect(() => {
    // Первый замер асинхронный: синхронный setState в effect не нужен, а
    // ResizeObserver не всегда доступен в тестовой среде.
    const frame = requestAnimationFrame(updateScrollHints);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [renderedColumns, projects.length, updateScrollHints]);

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

    // Ревизия инвалидирует ранее полученные значения: после create/delete
    // подзадачи в overlay счётчики перезапрашиваются для всех видимых
    // корневых карточек, без remount доски.
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
            // Ошибка не должна выглядеть как реальный ноль подзадач.
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
      // Позиция считается по полному scope `(projectId, status)`, а не по
      // видимому subset с фильтром или текущей страницей.
      const scopeTasks = await fetchAllScopeTasks(invoke, task.projectId, status);
      const position = resolveMovePosition(scopeTasks, task.id, intent);

      loadedCountsRef.current[status] = Math.max(
        loadedCountsRef.current[status] ?? KANBAN_PAGE_SIZE,
        position + 1,
      );
      // Требования накапливаются по taskId: одновременные moves в одну
      // колонку не должны затирать друг друга.
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

      // Store сдвигает соседей и повышает их версии. После команды доска
      // перечитывается, а не пересчитывает версии вручную. reloadBoard
      // догружает target колонку минимум до позиции перемещённой карточки.
      await reloadBoard();
      // Move меняет счётчики статусов и просроченность: та же сводка должна
      // обновиться без ожидания другой ревизии.
      await refreshSummaries();
    } catch (commandError) {
      // Команда не применилась: требование видимости для неё больше не
      // актуально, остальные одновременные требования сохраняются.
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

    // Действия относятся к видимому порядку. Для «Выше»/«Ниже» anchor
    // берётся из уже построенного optimistic placement (следующая видимая
    // карточка), а полный scope нужен только для перевода anchor-а в позицию.
    // Скрытые соседи не сдвигают направление.
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
          // Пустая или полностью дублированная страница всегда означает, что
          // локальные ID могли устареть (уменьшился total, сдвинулись
          // позиции). Перечитываем колонку с начала: reload не вызывает
          // loadMore, поэтому цикла нет. Пагинацию закрывает уже актуальный
          // nextOffset из reload, а не счётчик этой страницы.
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

    if (card === null || cardId === null) {
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

    const cards = [
      ...(card
        .closest<HTMLElement>("[data-kanban-column]")
        ?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []),
    ];
    const next = cards[cards.indexOf(card) + 1]?.getAttribute("data-card-id") ?? null;

    return { status, beforeId: next };
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

      if (active && drop !== null) {
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

  return (
    <div
      data-testid="kanban-view"
      className="flex min-h-0 w-full flex-1 flex-col gap-3 rounded-xl border border-border/60 bg-[#e2e8f0] p-2 sm:p-3 dark:bg-[#1e293b]"
      style={{ minWidth: 0 }}
    >
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1
            data-testid="kanban-board-title"
            className="m-0 truncate text-xl font-semibold tracking-tight sm:text-2xl"
          >
            {showingProjects
              ? "Проекты"
              : allProjectsMode
                ? "Все проекты"
                : (selectedProject?.title ?? "Проект")}
          </h1>
          {showingProjects ? (
            <p
              data-testid="kanban-board-description"
              className="m-0 max-w-2xl text-xs text-muted-foreground sm:text-sm"
            >
              Доски проектов с точными счётчиками задач и просроченными.
            </p>
          ) : allProjectsMode ? (
            <p
              data-testid="kanban-board-description"
              className="m-0 max-w-2xl text-xs text-muted-foreground sm:text-sm"
            >
              Задачи всех проектов на одной доске.
            </p>
          ) : selectedProject !== null && selectedProject.descriptionMarkdown.trim().length > 0 ? (
            <p
              data-testid="kanban-board-description"
              className="m-0 max-w-2xl text-xs whitespace-pre-wrap text-muted-foreground sm:text-sm"
            >
              {selectedProject.descriptionMarkdown}
            </p>
          ) : null}
          {headerSummary === null ? null : (
            <dl
              data-testid="kanban-board-summary"
              aria-label="Сводка задач"
              className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground"
            >
              <div className="flex items-baseline gap-1">
                <dt>Всего:</dt>
                <dd
                  data-testid="kanban-summary-total"
                  className="m-0 font-semibold text-foreground"
                >
                  {headerSummary.total}
                </dd>
              </div>
              {KANBAN_STATUSES.map((status) => (
                <div key={status} className="flex items-baseline gap-1">
                  <dt>{taskStatusLabel(status)}:</dt>
                  <dd
                    data-testid={`kanban-summary-${status}`}
                    className="m-0 font-semibold text-foreground"
                  >
                    {headerSummary.counts[status]}
                  </dd>
                </div>
              ))}
              <div className="flex items-baseline gap-1">
                <dt>Просрочено:</dt>
                <dd
                  data-testid="kanban-summary-overdue"
                  className={
                    headerSummary.overdueCount > 0
                      ? "m-0 font-semibold text-destructive"
                      : "m-0 font-semibold text-foreground"
                  }
                >
                  {headerSummary.overdueCount}
                </dd>
              </div>
            </dl>
          )}
        </div>

        {onKanbanRoute ? (
          <div className="flex flex-wrap gap-2">
            <div
              role="group"
              aria-label="Режим представления"
              className="inline-flex overflow-hidden rounded-md border border-border"
            >
              <button
                type="button"
                data-testid="kanban-mode-board"
                aria-pressed={!showingProjects}
                onClick={() => {
                  setViewMode("board");
                }}
                className={`inline-flex min-h-10 items-center px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8 ${
                  showingProjects
                    ? "bg-background hover:bg-accent"
                    : "bg-primary text-primary-foreground"
                }`}
              >
                Доска
              </button>
              <button
                type="button"
                data-testid="kanban-mode-projects"
                aria-pressed={showingProjects}
                onClick={() => {
                  setViewMode("projects");
                }}
                className={`inline-flex min-h-10 items-center border-l border-border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8 ${
                  showingProjects
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent"
                }`}
              >
                Проекты
              </button>
            </div>
            <button
              type="button"
              data-testid="kanban-create-project"
              onClick={openProjectForm}
              className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
            >
              Новый проект
            </button>
            <button
              type="button"
              data-testid="kanban-create-task"
              disabled={projects.length === 0}
              onClick={() => {
                openTaskForm();
              }}
              className="inline-flex min-h-10 items-center rounded-md border border-transparent bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8"
            >
              Новая задача
            </button>
          </div>
        ) : null}
      </header>

      {showingProjects ? null : (
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
            <label className="flex min-w-[12rem] flex-col gap-0.5 text-[11px] text-muted-foreground">
              Проект
              <select
                name="projectId"
                value={query.projectId}
                onChange={(event) => {
                  updateKanbanQuery({ projectId: event.target.value, taskId: null });
                }}
                className="h-10 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:h-8"
              >
                <option value="">Все проекты</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>

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
                {query.projectId.length > 0 ? (
                  <button
                    type="button"
                    data-testid="kanban-filter-chip-project"
                    aria-label={`Сбросить фильтр проекта «${
                      selectedProject?.title ?? query.projectId
                    }»`}
                    onClick={() => {
                      updateKanbanQuery({ projectId: "", taskId: null });
                    }}
                    className="inline-flex min-h-10 items-center gap-1 rounded-full border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
                  >
                    Проект: {selectedProject?.title ?? query.projectId}
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}

                {query.tag.length > 0 ? (
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
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    updateKanbanQuery({ taskId: null });
                    resetKanbanFilters();
                  }}
                  className="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-8"
                >
                  Сбросить фильтры
                </button>
              </div>
            ) : null}
          </form>
        </>
      )}

      <KanbanCreatePanel
        pathname={pathname}
        mode={formMode}
        session={formSession}
        projects={projects}
        rootTasks={rootTasks}
        taskValues={taskDraft}
        projectValues={projectDraft}
        onTaskValuesChange={setTaskDraft}
        onProjectValuesChange={setProjectDraft}
        openerSelector={formOpenerSelector}
        submitting={formSubmitting}
        error={formError}
        onCancel={closeCreateForm}
        onSubmitProject={(values) => {
          void createProject(values);
        }}
        onSubmitTask={(values) => {
          void createTask(values);
        }}
      />

      {projectsError === null ? null : (
        <p role="alert" className="m-0 text-xs text-destructive">
          Проекты: {projectsError}
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

      {showingProjects ? (
        <ProjectsGrid
          items={projectSummaries}
          totals={summaryTotals}
          totalProjects={summaryTotalProjects}
          loading={summaryLoading}
          loadingMore={summaryLoadingMore}
          error={summaryError}
          hasMore={summaryNextOffset !== null}
          onCreateProject={openProjectForm}
          onOpenBoard={openProjectBoard}
          onLoadMore={() => {
            void loadProjectSummaries(false);
          }}
          onRetry={() => {
            void loadProjectSummaries(true);
          }}
        />
      ) : (
        <>
          {projectsLoaded && projects.length === 0 && projectsError === null ? (
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
          ) : null}

          {hasFilters && boardSettled && visibleTotal === 0 ? (
            <div
              data-testid="kanban-empty-filter"
              role="status"
              className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-background/60 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="m-0 text-sm font-medium">По фильтрам ничего не найдено</p>
                <p className="m-0 text-xs text-muted-foreground">
                  Измените проект или тег, чтобы увидеть задачи.
                </p>
              </div>
              <button
                type="button"
                data-testid="kanban-empty-filter-reset"
                onClick={() => {
                  updateKanbanQuery({ taskId: null });
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
              style={{ minWidth: 0, WebkitOverflowScrolling: "touch" }}
            >
              {KANBAN_STATUSES.map((status) => {
                const column = getColumn(renderedColumns, status);
                const items = column.items;
                const dropActive = dragOver?.status === status;
                const insertion = dropActive
                  ? dragOver.beforeId === null
                    ? items.length
                    : (() => {
                        const found = items.findIndex((task) => task.id === dragOver.beforeId);

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
                    total={column.total}
                    loading={column.loading}
                    error={column.error}
                    hasMore={column.nextOffset !== null}
                    dragOver={dropActive}
                    dropActive={dropActive}
                    onCreateTask={() => {
                      openTaskForm(status, `[data-testid="kanban-create-task-${status}"]`);
                    }}
                    createVisible={onKanbanRoute}
                    createDisabled={projects.length === 0}
                    quickComposerOpen={quickOpenStatuses.has(status)}
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
                          projects={projects}
                          activeProjectId={query.projectId}
                          disabled={projects.length === 0}
                          resetToken={quickResetTokens[status] ?? 0}
                          onOpenChange={(open) => {
                            setQuickOpenStatuses((current) => {
                              if (open) {
                                if (current.has(status)) {
                                  return current;
                                }

                                const next = new Set(current);

                                next.add(status);

                                return next;
                              }

                              if (!current.has(status)) {
                                return current;
                              }

                              const next = new Set(current);

                              next.delete(status);

                              return next;
                            });
                          }}
                          onCreate={(input) => createQuickTask(status, input)}
                          onOpenDetails={(draft: QuickComposerDraft) => {
                            openTaskFormFromQuick(status, draft);
                          }}
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
                            projectTitle={
                              allProjectsMode ? (projectTitles.get(task.projectId) ?? null) : null
                            }
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
    </div>
  );
}
