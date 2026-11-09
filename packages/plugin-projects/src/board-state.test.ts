import { describe, expect, it } from "vitest";

import type { Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";

import {
  applyPlacements,
  createEmptyColumns,
  getColumn,
  placementForIndex,
  resolveMovePosition,
  visibleMoveIntent,
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

  it("считает append и before по полному списку, исключая перемещаемую карточку", () => {
    const items = [task("a", "todo", 0), task("b", "todo", 1), task("c", "todo", 2)];

    expect(resolveMovePosition(items, "a", { kind: "append" })).toBe(2);
    expect(resolveMovePosition(items, "a", { kind: "start" })).toBe(0);
    expect(resolveMovePosition(items, "a", { kind: "before", beforeId: "c" })).toBe(1);
    expect(resolveMovePosition(items, "a", { kind: "before", beforeId: "missing" })).toBe(2);
  });

  it("переводит видимое «ниже» в anchor, не используя currentIndex полного scope", () => {
    const visibleA = task("visible-a", "todo", 0);
    const hidden = task("hidden", "todo", 1);
    const visibleC = task("visible-c", "todo", 2);
    const fullScope = [visibleA, hidden, visibleC];
    const visible = [visibleA, visibleC];

    // В видимом списке [A, C] «ниже» для A — конец; anchor-а нет, значит
    // append по полному scope даёт позицию 2 и порядок B, C, A.
    const downPlacement = placementForIndex("todo", visible, "visible-a", 1);

    expect(downPlacement).toEqual({ status: "todo", beforeId: null });
    const downIntent = visibleMoveIntent(visible, "visible-a", downPlacement);

    expect(downIntent).toEqual({ kind: "append" });
    expect(resolveMovePosition(fullScope, "visible-a", downIntent)).toBe(2);

    // «Выше» для C в видимом списке ставит anchor на A; в полном scope A
    // находится на позиции 0, а не рядом с hidden.
    const upPlacement = placementForIndex("todo", visible, "visible-c", 0);

    expect(upPlacement).toEqual({ status: "todo", beforeId: "visible-a" });
    const upIntent = visibleMoveIntent(visible, "visible-c", upPlacement);

    expect(upIntent).toEqual({ kind: "before", beforeId: "visible-a" });
    expect(resolveMovePosition(fullScope, "visible-c", upIntent)).toBe(0);
  });

  it("строит anchor по следующей видимой карточке после оптимистичной вставки", () => {
    const a = task("a", "todo", 0);
    const b = task("b", "todo", 1);
    const c = task("c", "todo", 2);

    // [A, B, C], «ниже» A → [B, A, C], anchor — C.
    const placement = placementForIndex("todo", [a, b, c], "a", 1);

    expect(visibleMoveIntent([a, b, c], "a", placement)).toEqual({
      kind: "before",
      beforeId: "c",
    });
  });

  it("строит вставку перед следующей карточкой для целевого индекса", () => {
    const items = [task("a", "todo", 0), task("b", "todo", 1), task("c", "todo", 2)];

    expect(placementForIndex("todo", items, "a", 0)).toEqual({ status: "todo", beforeId: "b" });
    expect(placementForIndex("todo", items, "a", 1)).toEqual({ status: "todo", beforeId: "c" });
    expect(placementForIndex("todo", items, "a", 2)).toEqual({ status: "todo", beforeId: null });
  });
});
