import { describe, expect, it } from "vitest";

import type { Project, Task } from "./model.ts";
import {
  compareCodePoints,
  compareNullableDueAt,
  compareProjects,
  compareTaskList,
  matchesDueRange,
  matchesTaskText,
  normalizeSearchText,
} from "./listing.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const latest = "2026-01-03T00:00:00.000Z";

function openTask(overrides: Partial<Omit<Task, "status" | "completedAt">> = {}): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    parentTaskId: null,
    title: "Задача",
    descriptionMarkdown: "",
    status: "todo",
    priority: "low",
    dueAt: null,
    position: 0,
    tags: [],
    version: 1,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}

function project(id: string, created: string): Project {
  return {
    id,
    title: id,
    descriptionMarkdown: "",
    version: 1,
    createdAt: created,
    updatedAt: created,
  };
}

describe("normalizeSearchText и matchesTaskText", () => {
  it("делает NFKC и нижний регистр без locale", () => {
    expect(normalizeSearchText("  ＫＡＮＢＡＮＥＲ ЁЖ  ")).toBe("  kanbaner ёж  ");
    expect(matchesTaskText(openTask({ title: "Подготовить РЕЛИЗ" }), "релиз")).toBe(true);
    expect(matchesTaskText(openTask({ descriptionMarkdown: "Проверить ЁЖ" }), "ёж")).toBe(true);
    expect(matchesTaskText(openTask({ title: "Задача" }), "нет")).toBe(false);
  });
});

describe("compareCodePoints", () => {
  it("сравнивает по code points, а не по locale", () => {
    expect(compareCodePoints("A", "a")).toBeLessThan(0);
    expect(compareCodePoints("a", "A")).toBeGreaterThan(0);
    expect(compareCodePoints("abc", "ab")).toBeGreaterThan(0);
    expect(compareCodePoints("ё", "ж")).toBeGreaterThan(0);
  });
});

describe("compareNullableDueAt", () => {
  it("ставит null последними в обоих направлениях", () => {
    expect(compareNullableDueAt(null, createdAt, "asc")).toBeGreaterThan(0);
    expect(compareNullableDueAt(createdAt, null, "asc")).toBeLessThan(0);
    expect(compareNullableDueAt(null, createdAt, "desc")).toBeGreaterThan(0);
    expect(compareNullableDueAt(createdAt, null, "desc")).toBeLessThan(0);
    expect(compareNullableDueAt(createdAt, later, "asc")).toBeLessThan(0);
    expect(compareNullableDueAt(createdAt, later, "desc")).toBeGreaterThan(0);
  });
});

describe("compareTaskList", () => {
  it("сортирует position и стабилизирует по id asc", () => {
    const first = openTask({ id: "b", position: 1 });
    const second = openTask({ id: "a", position: 1 });
    const third = openTask({ id: "c", position: 2 });

    expect(compareTaskList(first, second, { field: "position", direction: "asc" })).toBeGreaterThan(
      0,
    );
    expect(compareTaskList(third, first, { field: "position", direction: "asc" })).toBeGreaterThan(
      0,
    );
    expect(compareTaskList(first, third, { field: "position", direction: "desc" })).toBeGreaterThan(
      0,
    );
  });

  it("сортирует dueAt с null последними независимо от направления", () => {
    const empty = openTask({ id: "a", dueAt: null });
    const early = openTask({ id: "b", dueAt: createdAt });
    const late = openTask({ id: "c", dueAt: later });

    expect(compareTaskList(early, empty, { field: "dueAt", direction: "asc" })).toBeLessThan(0);
    expect(compareTaskList(empty, early, { field: "dueAt", direction: "desc" })).toBeGreaterThan(0);
    expect(compareTaskList(late, early, { field: "dueAt", direction: "asc" })).toBeGreaterThan(0);
    expect(compareTaskList(late, early, { field: "dueAt", direction: "desc" })).toBeLessThan(0);
  });

  it("сортирует title по code points и createdAt/updatedAt по UTC", () => {
    const upper = openTask({ id: "a", title: "A", createdAt });
    const lower = openTask({ id: "b", title: "a", createdAt: later });
    const newest = openTask({ id: "c", title: "c", createdAt: latest });

    expect(compareTaskList(upper, lower, { field: "title", direction: "asc" })).toBeLessThan(0);
    expect(compareTaskList(upper, lower, { field: "title", direction: "desc" })).toBeGreaterThan(0);
    expect(compareTaskList(upper, newest, { field: "createdAt", direction: "asc" })).toBeLessThan(
      0,
    );
    expect(compareTaskList(upper, newest, { field: "updatedAt", direction: "asc" })).toBeLessThan(
      0,
    );
  });
});

describe("compareProjects", () => {
  it("сортирует createdAt asc, затем id asc", () => {
    expect(compareProjects(project("a", createdAt), project("b", later))).toBeLessThan(0);
    expect(compareProjects(project("b", createdAt), project("a", createdAt))).toBeGreaterThan(0);
  });
});

describe("matchesDueRange", () => {
  it("включает границы dueBefore и dueAfter", () => {
    expect(matchesDueRange(createdAt, createdAt, createdAt)).toBe(true);
    expect(matchesDueRange(later, later, undefined)).toBe(true);
    expect(matchesDueRange(later, undefined, later)).toBe(true);
    expect(matchesDueRange(latest, later, undefined)).toBe(false);
  });

  it("не включает null в ограниченный диапазон и пропускает без границ", () => {
    expect(matchesDueRange(null)).toBe(true);
    expect(matchesDueRange(null, createdAt)).toBe(false);
    expect(matchesDueRange(null, undefined, createdAt)).toBe(false);
  });
});
