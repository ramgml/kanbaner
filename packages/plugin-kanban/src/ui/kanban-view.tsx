"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type Project,
  type ProjectListOutput,
  type Task,
  type TaskListInput,
  type TaskListOutput,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker } from "@kanbaner/task-ui";

import { KanbanCard, type KanbanReorderKind } from "./kanban-card.tsx";
import { KanbanColumn } from "./kanban-column.tsx";
import {
  KANBAN_PAGE_SIZE,
  KANBAN_STATUSES,
  applyPlacements,
  computeMovePosition,
  createEmptyColumns,
  getColumn,
  placementForIndex,
  type KanbanColumns,
  type Placement,
} from "./board-state.ts";
import {
  VERSION_CONFLICT_MESSAGE,
  errorMessage,
  invokeJson,
  isVersionConflict,
} from "./operations.ts";
import { resetKanbanFilters, updateKanbanQuery, useKanbanQuery } from "./query-state.ts";

interface ColumnPage {
  readonly items: readonly Task[];
  readonly total: number;
  readonly nextOffset: number | null;
}

interface DropTarget {
  readonly status: TaskStatus;
  readonly beforeId: string | null;
}

function emptyCounts(value: number): Record<TaskStatus, number> {
  return { backlog: value, todo: value, in_progress: value, done: value };
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

/** Читает страницу колонки, последовательно добирая до нужного количества. */
async function fetchColumnPage(
  invoke: UiOperationInvoker,
  status: TaskStatus,
  projectId: string,
  tag: string,
  targetCount: number,
): Promise<ColumnPage> {
  const items: Task[] = [];
  let total = 0;
  let nextOffset: number | null = null;
  let remaining = Math.max(1, targetCount);

  for (;;) {
    const limit = Math.min(KANBAN_PAGE_SIZE, remaining);
    const data = await invokeJson<TaskListOutput>(
      invoke,
      TASKS_QUERY_IDS.taskList,
      listInput(status, projectId, tag, limit, items.length),
    );

    total = data.total;
    items.push(...data.items);
    nextOffset = data.nextOffset;
    remaining -= data.items.length;

    if (data.nextOffset === null || data.items.length === 0 || remaining <= 0) {
      break;
    }
  }

  return { items, total, nextOffset };
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
export function KanbanView({ invoke }: { readonly invoke: UiOperationInvoker }) {
  const query = useKanbanQuery();
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [columns, setColumns] = useState<KanbanColumns>(createEmptyColumns);
  const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(() => new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [subtaskCounts, setSubtaskCounts] = useState<Readonly<Record<string, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  const loadedCountsRef = useRef<Record<TaskStatus, number>>(emptyCounts(KANBAN_PAGE_SIZE));
  const filterKeyRef = useRef<string>("\u0000");
  const reloadSequenceRef = useRef(0);
  const placementsRef = useRef<ReadonlyMap<string, Placement>>(new Map());
  const pendingRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const data = await invokeJson<ProjectListOutput>(invoke, TASKS_QUERY_IDS.projectList, {
          limit: 200,
          offset: 0,
        });

        if (!cancelled) {
          setProjects(data.items);
          setProjectsError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setProjectsError(errorMessage(loadError));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [invoke]);

  const reloadBoard = useCallback(async (): Promise<void> => {
    const sequence = reloadSequenceRef.current + 1;

    reloadSequenceRef.current = sequence;
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
        try {
          const page = await fetchColumnPage(
            invoke,
            status,
            query.projectId,
            query.tag,
            loadedCountsRef.current[status] ?? KANBAN_PAGE_SIZE,
          );

          return { status, page, error: null } as const;
        } catch (loadError) {
          return { status, page: null, error: errorMessage(loadError) } as const;
        }
      }),
    );

    if (reloadSequenceRef.current !== sequence) {
      return;
    }

    setColumns((current) => {
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
  }, [invoke, query.projectId, query.tag]);

  useEffect(() => {
    const filterKey = `${query.projectId}\u0000${query.tag}`;

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
    const missing = rootTaskIds.filter((taskId) => subtaskCounts[taskId] === undefined);

    if (missing.length === 0) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const entries = await Promise.all(
        missing.map(async (taskId) => {
          try {
            const data = await invokeJson<TaskListOutput>(invoke, TASKS_QUERY_IDS.taskList, {
              parentTaskId: taskId,
              limit: 1,
              offset: 0,
            } as unknown as JsonValue);

            return [taskId, data.total] as const;
          } catch {
            return [taskId, 0] as const;
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
  }, [invoke, rootTaskKey]);

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

  const moveTask = async (task: Task, placement: Placement): Promise<void> => {
    if (pendingRef.current.has(task.id)) {
      return;
    }

    const optimisticPlacements = new Map(placementsRef.current);

    optimisticPlacements.set(task.id, placement);

    const optimisticColumns = applyPlacements(columns, optimisticPlacements);
    const position = computeMovePosition(
      getColumn(optimisticColumns, placement.status).items,
      task.id,
    );

    setPlacement(task.id, placement);
    setPendingCard(task.id, true);
    setConflict(task.id, false);
    setError(null);
    setDraggingId(null);
    setDragOver(null);

    try {
      await invokeJson(invoke, TASKS_COMMAND_IDS.taskMove, {
        id: task.id,
        expectedVersion: task.version,
        status: placement.status,
        position,
      } as unknown as JsonValue);

      // Store сдвигает соседей и повышает их версии. После команды доска
      // перечитывается, а не пересчитывает версии вручную.
      await reloadBoard();
    } catch (commandError) {
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
    void moveTask(task, { status, beforeId: null });
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

    void moveTask(task, placementForIndex(status, items, task.id, targetIndex));
  };

  const loadMore = (status: TaskStatus): void => {
    const current = getColumn(columns, status);
    const offset = current.items.length;

    setColumns((previous) => ({
      ...previous,
      [status]: { ...getColumn(previous, status), loading: true },
    }));

    void (async () => {
      try {
        const data = await invokeJson<TaskListOutput>(
          invoke,
          TASKS_QUERY_IDS.taskList,
          listInput(status, query.projectId, query.tag, KANBAN_PAGE_SIZE, offset),
        );

        setColumns((previous) => {
          const existing = getColumn(previous, status);
          const known = new Set(existing.items.map((task) => task.id));
          const appended = data.items.filter((task) => !known.has(task.id));
          const items = [...existing.items, ...appended];

          loadedCountsRef.current[status] = items.length;

          return {
            ...previous,
            [status]: {
              items,
              total: data.total,
              nextOffset: appended.length === 0 ? null : data.nextOffset,
              loading: false,
              error: null,
            },
          };
        });
      } catch (loadError) {
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
        void moveTask(task, { status: drop.status, beforeId: drop.beforeId });
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
                    subtaskCount={subtaskCounts[task.id] ?? 0}
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
