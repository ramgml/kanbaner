import { describe, expect, it } from "vitest";

import type { Task, TaskColumn, TaskStatus } from "@kanbaner/plugin-tasks/contract";

import {
  applyPlacements,
  columnTestSlug,
  createEmptyColumn,
  createEmptyColumns,
  defaultCreateColumnId,
  defaultDeleteTargetColumn,
  effectiveColumnId,
  getColumn,
  getColumns,
  isLastColumnOfType,
  placementForIndex,
  reorderKanbanColumns,
  resolveMovePosition,
  syncColumns,
  visibleMoveIntent,
  withoutColumn,
} from "./ui/board-state.ts";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function task(
  id: string,
  columnId: string,
  status: TaskStatus,
  position: number,
  projectId = "project-1",
): Task {
  return {
    id,
    projectId,
    parentTaskId: null,
    columnId,
    title: id,
    descriptionMarkdown: "",
    priority: "medium",
    dueAt: null,
    position,
    tags: [],
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    status,
    completedAt: status === "done" ? TIMESTAMP : null,
  } as Task;
}

function column(
  status: TaskStatus,
  position: number,
  projectId = "project-1",
  id = `column-${projectId}-legacy-${status}`,
): TaskColumn {
  return {
    id,
    projectId,
    title: status,
    status,
    position,
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const backlog = column("backlog", 0);
const todo = column("todo", 1);
const inProgress = column("in_progress", 2);
const done = column("done", 3);

function board(columns: readonly TaskColumn[], items: Readonly<Record<string, readonly Task[]>>) {
  const byId: Record<string, ReturnType<typeof createEmptyColumn>> = {};

  for (const entry of columns) {
    const tasks = items[entry.id] ?? [];
    byId[entry.id] = {
      column: entry,
      items: tasks,
      total: tasks.length,
      nextOffset: null,
      loading: false,
      error: null,
    };
  }

  return { order: columns.map((entry) => entry.id), byId };
}

describe("board-state", () => {
  it("накладывает оптимистичные перемещения и корректирует счётчики", () => {
    const a = task("a", todo.id, "todo", 0);
    const b = task("b", todo.id, "todo", 1);
    const c = task("c", done.id, "done", 0);
    const columns = board([backlog, todo, inProgress, done], {
      [todo.id]: [a, b],
      [done.id]: [c],
    });
    const moved = applyPlacements(columns, new Map([["a", { columnId: done.id, beforeId: "c" }]]));

    expect(getColumn(moved, todo.id)?.items.map((item) => item.id)).toEqual(["b"]);
    expect(getColumn(moved, done.id)?.items.map((item) => item.id)).toEqual(["a", "c"]);
    expect(getColumn(moved, todo.id)?.total).toBe(1);
    expect(getColumn(moved, done.id)?.total).toBe(2);
  });

  it("считает append и before по полному списку, исключая перемещаемую карточку", () => {
    const items = [
      task("a", todo.id, "todo", 0),
      task("b", todo.id, "todo", 1),
      task("c", todo.id, "todo", 2),
    ];

    expect(resolveMovePosition(items, "a", { kind: "append" })).toBe(2);
    expect(resolveMovePosition(items, "a", { kind: "start" })).toBe(0);
    expect(resolveMovePosition(items, "a", { kind: "before", beforeId: "c" })).toBe(1);
    expect(resolveMovePosition(items, "a", { kind: "before", beforeId: "missing" })).toBe(2);
  });

  it("переводит видимое «ниже» в anchor, не используя currentIndex полного scope", () => {
    const visibleA = task("visible-a", todo.id, "todo", 0);
    const hidden = task("hidden", todo.id, "todo", 1);
    const visibleC = task("visible-c", todo.id, "todo", 2);
    const fullScope = [visibleA, hidden, visibleC];
    const visible = [visibleA, visibleC];

    const downPlacement = placementForIndex(todo.id, visible, "visible-a", 1);

    expect(downPlacement).toEqual({ columnId: todo.id, beforeId: null });
    const downIntent = visibleMoveIntent(visible, "visible-a", downPlacement);

    expect(downIntent).toEqual({ kind: "append" });
    expect(resolveMovePosition(fullScope, "visible-a", downIntent)).toBe(2);

    const upPlacement = placementForIndex(todo.id, visible, "visible-c", 0);

    expect(upPlacement).toEqual({ columnId: todo.id, beforeId: "visible-a" });
    const upIntent = visibleMoveIntent(visible, "visible-c", upPlacement);

    expect(upIntent).toEqual({ kind: "before", beforeId: "visible-a" });
    expect(resolveMovePosition(fullScope, "visible-c", upIntent)).toBe(0);
  });

  it("строит anchor по следующей видимой карточке после оптимистичной вставки", () => {
    const a = task("a", todo.id, "todo", 0);
    const b = task("b", todo.id, "todo", 1);
    const c = task("c", todo.id, "todo", 2);

    const placement = placementForIndex(todo.id, [a, b, c], "a", 1);

    expect(visibleMoveIntent([a, b, c], "a", placement)).toEqual({
      kind: "before",
      beforeId: "c",
    });
  });

  it("строит вставку перед следующей карточкой для целевого индекса", () => {
    const items = [
      task("a", todo.id, "todo", 0),
      task("b", todo.id, "todo", 1),
      task("c", todo.id, "todo", 2),
    ];

    expect(placementForIndex(todo.id, items, "a", 0)).toEqual({
      columnId: todo.id,
      beforeId: "b",
    });
    expect(placementForIndex(todo.id, items, "a", 1)).toEqual({
      columnId: todo.id,
      beforeId: "c",
    });
    expect(placementForIndex(todo.id, items, "a", 2)).toEqual({
      columnId: todo.id,
      beforeId: null,
    });
  });

  it("синхронизирует порядок колонок и сохраняет загруженные страницы", () => {
    const a = task("a", todo.id, "todo", 0);
    const initial = board([todo, done], { [todo.id]: [a] });
    const synced = syncColumns(initial, [done, todo, inProgress]);

    expect(synced.order).toEqual([done.id, todo.id, inProgress.id]);
    expect(getColumn(synced, todo.id)?.items.map((item) => item.id)).toEqual(["a"]);
    expect(getColumn(synced, inProgress.id)?.loading).toBe(true);
  });

  it("оптимистично переставляет и удаляет колонки", () => {
    const initial = syncColumns(createEmptyColumns(), [backlog, todo, inProgress, done]);
    const reordered = reorderKanbanColumns(initial, backlog.id, 2);

    expect(reordered.order).toEqual([todo.id, inProgress.id, backlog.id, done.id]);
    expect(getColumns(reordered).map((entry) => entry.column.id)).toEqual(reordered.order);

    const removed = withoutColumn(reordered, todo.id);

    expect(removed.order).toEqual([inProgress.id, backlog.id, done.id]);
    expect(getColumn(removed, todo.id)).toBeNull();
  });

  it("выбирает default-колонку для создания и удаления", () => {
    const columns = [backlog, todo, inProgress, done];

    expect(defaultCreateColumnId(columns)).toBe(backlog.id);
    expect(defaultCreateColumnId([done, inProgress])).toBe(inProgress.id);
    expect(defaultDeleteTargetColumn(columns, inProgress.id)).toBe(backlog.id);
    expect(defaultDeleteTargetColumn([todo, done], todo.id)).toBe(done.id);
  });

  it("определяет последнюю колонку типа и фактическую колонку legacy-задачи", () => {
    expect(isLastColumnOfType([todo], todo.id)).toBe(true);
    expect(isLastColumnOfType([todo, inProgress], todo.id)).toBe(false);
    expect(isLastColumnOfType([todo, done], done.id)).toBe(true);

    const legacy = task("legacy", todo.id, "in_progress", 0);

    delete (legacy as { columnId?: string }).columnId;
    expect(effectiveColumnId(legacy, [todo, inProgress])).toBe(inProgress.id);
  });

  it("сохраняет стабильные testid канонических колонок и экранирует custom ID", () => {
    expect(columnTestSlug(backlog)).toBe("backlog");
    expect(columnTestSlug(todo)).toBe("todo");
    expect(columnTestSlug({ id: "column-project-1-legacy-in_progress" } as TaskColumn)).toBe(
      "in_progress",
    );
    expect(columnTestSlug({ id: "column-project-1-in-progress" } as TaskColumn)).toBe(
      "in_progress",
    );
    expect(columnTestSlug({ id: "column-abc/def" } as TaskColumn)).toBe("column-column-abc-def");
  });
});
