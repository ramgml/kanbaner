"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  normalizeTag,
  type Project,
  type ProjectListOutput,
  type ProjectMutationOutput,
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
  type ProjectFormValues,
  type TaskFormValues,
  type UiOperationInvoker,
} from "@kanbaner/task-ui";

import { KANBAN_ROUTE } from "../metadata.ts";
import { KanbanCard, type KanbanReorderKind } from "./kanban-card.tsx";
import { KanbanColumn } from "./kanban-column.tsx";
import { KanbanCreatePanel, type KanbanCreateMode } from "./kanban-create.tsx";
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
  const [projectsError, setProjectsError] = useState<string | null>(null);
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
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

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
      }
    } catch (loadError) {
      if (projectsSequenceRef.current === sequence) {
        setProjectsError(errorMessage(loadError));
      }
    }
  }, [invoke]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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
    setFormMode(null);
    setFormError(null);
  };

  const openProjectForm = (): void => {
    setFormError(null);
    setProjectDraft(createProjectFormValues());
    setFormOpenerSelector('[data-testid="kanban-create-project"]');
    setFormSession((current) => current + 1);
    setFormMode("project");
  };

  const openTaskForm = (status: TaskStatus = "todo", opener?: string): void => {
    if (projects.length === 0) {
      return;
    }

    setFormError(null);
    setTaskDraft(createTaskFormValues(projects, { projectId: query.projectId, status }));
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
      await invokeJson<ProjectMutationOutput>(invoke, TASKS_COMMAND_IDS.projectCreate, {
        title: values.title,
        descriptionMarkdown: values.descriptionMarkdown,
      });

      // Повторный project.list: созданный проект должен сразу появиться в
      // фильтрах и форме. Текущий фильтр не меняется.
      await loadProjects();
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
    } catch (commandError) {
      // Форма остаётся открытой и сохраняет введённые значения.
      setFormError(errorMessage(commandError));
    } finally {
      endSubmit();
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
      setDragOver(target?.status ?? null);
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
      style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0, width: "100%" }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600 }}>Канбан</h1>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              color: "var(--muted-foreground)",
              maxWidth: "42rem",
            }}
          >
            Четыре фиксированные колонки. Перемещение доступно мышью, меню и кнопками порядка —
            данные задачи остаются в домене задач.
          </p>
        </div>

        {onKanbanRoute ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            <button
              type="button"
              data-testid="kanban-create-project"
              onClick={openProjectForm}
              style={{
                height: "32px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--foreground)",
                padding: "0 12px",
                fontSize: "13px",
                fontWeight: 500,
                cursor: "pointer",
              }}
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
              style={{
                height: "32px",
                borderRadius: "6px",
                border: "1px solid transparent",
                background: "var(--primary)",
                color: "var(--primary-foreground)",
                padding: "0 12px",
                fontSize: "13px",
                fontWeight: 500,
                cursor: projects.length === 0 ? "not-allowed" : "pointer",
                opacity: projects.length === 0 ? 0.5 : 1,
              }}
            >
              Новая задача
            </button>
          </div>
        ) : null}
      </header>

      <form
        aria-label="Фильтры канбана"
        data-testid="kanban-filters"
        onSubmit={(event) => {
          event.preventDefault();
        }}
        style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "8px" }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            fontSize: "11px",
            color: "var(--muted-foreground)",
            minWidth: "12rem",
          }}
        >
          Проект
          <select
            name="projectId"
            value={query.projectId}
            onChange={(event) => {
              updateKanbanQuery({ projectId: event.target.value, taskId: null });
            }}
            style={{
              height: "32px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              padding: "0 8px",
              fontSize: "13px",
            }}
          >
            <option value="">Все проекты</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            fontSize: "11px",
            color: "var(--muted-foreground)",
            minWidth: "10rem",
          }}
        >
          Тег
          <input
            name="tag"
            type="search"
            value={query.tag}
            onChange={(event) => {
              updateKanbanQuery({ tag: event.target.value, taskId: null });
            }}
            placeholder="например, release"
            style={{
              height: "32px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              padding: "0 8px",
              fontSize: "13px",
            }}
          />
        </label>

        <button
          type="button"
          onClick={() => {
            updateKanbanQuery({ taskId: null });
            resetKanbanFilters();
          }}
          style={{
            height: "32px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            background: "var(--background)",
            color: "var(--foreground)",
            padding: "0 12px",
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          Сбросить фильтры
        </button>
      </form>

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
        <p role="alert" style={{ margin: 0, fontSize: "12px", color: "var(--destructive)" }}>
          Проекты: {projectsError}
        </p>
      )}

      {error === null ? null : (
        <div
          role="alert"
          data-testid="kanban-error"
          style={{
            border: "1px solid var(--destructive)",
            background: "color-mix(in oklab, var(--destructive) 8%, transparent)",
            color: "var(--destructive)",
            borderRadius: "8px",
            padding: "8px 10px",
            fontSize: "13px",
          }}
        >
          {error}
        </div>
      )}

      <div
        data-testid="kanban-columns"
        style={{
          display: "flex",
          gap: "12px",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          overflowX: "auto",
          paddingBottom: "8px",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {KANBAN_STATUSES.map((status) => {
          const column = getColumn(renderedColumns, status);

          return (
            <KanbanColumn
              key={status}
              status={status}
              total={column.total}
              loading={column.loading}
              error={column.error}
              hasMore={column.nextOffset !== null}
              dragOver={dragOver === status}
              onCreateTask={() => {
                openTaskForm(status, `[data-testid="kanban-create-task-${status}"]`);
              }}
              createVisible={onKanbanRoute}
              createDisabled={projects.length === 0}
              onLoadMore={() => {
                loadMore(status);
              }}
              onRetry={() => {
                void reloadBoard();
              }}
            >
              {column.items.map((task, index) => (
                <li key={task.id}>
                  <KanbanCard
                    task={task}
                    index={index}
                    columnSize={column.items.length}
                    subtaskCount={task.parentTaskId === null ? (subtaskCounts[task.id] ?? null) : 0}
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
              ))}
            </KanbanColumn>
          );
        })}
      </div>
    </div>
  );
}
