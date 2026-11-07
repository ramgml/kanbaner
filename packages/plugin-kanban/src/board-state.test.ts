import { describe, expect, it } from "vitest";

import type { Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";

import {
  applyPlacements,
  computeMovePosition,
  createEmptyColumns,
  getColumn,
  placementForIndex,
} from "./ui/board-state.ts";

function task(id: string, status: TaskStatus, position: number, projectId = "project-1"): Task {
  return {
    id,
    projectId,
    parentTaskId: null,
    title: id,
    descriptionMarkdown: "",
    priority: "medium",
    dueAt: null,
    position,
    tags: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
    completedAt: null,
  } as Task;
}

function columnsWith(byStatus: Partial<Record<TaskStatus, readonly Task[]>>) {
  const columns = createEmptyColumns();

  return {
    ...columns,
    backlog: {
      items: byStatus.backlog ?? [],
      total: byStatus.backlog?.length ?? 0,
      nextOffset: null,
      loading: false,
      error: null,
    },
    todo: {
      items: byStatus.todo ?? [],
      total: byStatus.todo?.length ?? 0,
      nextOffset: null,
      loading: false,
      error: null,
    },
    in_progress: {
      items: byStatus.in_progress ?? [],
      total: byStatus.in_progress?.length ?? 0,
      nextOffset: null,
      loading: false,
      error: null,
    },
    done: {
      items: byStatus.done ?? [],
      total: byStatus.done?.length ?? 0,
      nextOffset: null,
      loading: false,
      error: null,
    },
  };
}

describe("board-state", () => {
  it("накладывает оптимистичные перемещения и корректирует счётчики", () => {
    const a = task("a", "todo", 0);
    const b = task("b", "todo", 1);
    const c = task("c", "done", 0);
    const columns = columnsWith({ todo: [a, b], done: [c] });
    const moved = applyPlacements(columns, new Map([["a", { status: "done", beforeId: "c" }]]));

    expect(getColumn(moved, "todo").items.map((item) => item.id)).toEqual(["b"]);
    expect(getColumn(moved, "done").items.map((item) => item.id)).toEqual(["a", "c"]);
    expect(getColumn(moved, "todo").total).toBe(1);
    expect(getColumn(moved, "done").total).toBe(2);
  });

  it("считает позицию в области проекта, игнорируя чужие проекты", () => {
    const items = [
      task("a0", "todo", 0, "project-a"),
      task("b0", "todo", 0, "project-b"),
      task("a1", "todo", 1, "project-a"),
      task("b1", "todo", 1, "project-b"),
    ];

    expect(computeMovePosition(items, "a1")).toBe(1);
    expect(computeMovePosition(items, "b1")).toBe(1);
  });

  it("строит вставку перед следующей карточкой для целевого индекса", () => {
    const items = [task("a", "todo", 0), task("b", "todo", 1), task("c", "todo", 2)];

    expect(placementForIndex("todo", items, "a", 0)).toEqual({ status: "todo", beforeId: "b" });
    expect(placementForIndex("todo", items, "a", 1)).toEqual({ status: "todo", beforeId: "c" });
    expect(placementForIndex("todo", items, "a", 2)).toEqual({ status: "todo", beforeId: null });
  });
});
