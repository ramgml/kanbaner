import { describe, expect, it } from "vitest";

import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, MAX_TAGS } from "./constants.ts";
import {
  TasksValidationError,
  normalizeTags,
  resolveCompletedAt,
  taskPositionScopeKey,
  validateExpectedVersion,
  validateOffset,
  validatePagination,
  validatePosition,
  validateSubtaskParent,
  validateTags,
  validateTitle,
} from "./validation.ts";

const now = "2026-01-01T00:00:00.000Z";

function uniqueTags(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `tag-${String(index)}`);
}

describe("normalizeTags", () => {
  it("обрезает, приводит к нижнему регистру и удаляет дубликаты", () => {
    expect(normalizeTags([" Work ", "work", "URGENT", "  urgent  ", "ui"])).toEqual([
      "work",
      "urgent",
      "ui",
    ]);
  });

  it("бросает TasksValidationError при пустом теге", () => {
    expect(() => normalizeTags(["ok", "   "])).toThrowError(TasksValidationError);
    expect(validateTags(["ok", "   "])).toMatchObject({ ok: false, code: "TAG_EMPTY" });
  });

  it("ограничивает длину тега", () => {
    expect(validateTags(["a".repeat(33)])).toMatchObject({ ok: false, code: "TAG_TOO_LONG" });
  });

  it("ограничивает количество уникальных тегов", () => {
    expect(validateTags(uniqueTags(MAX_TAGS))).toMatchObject({ ok: true });
    expect(validateTags(uniqueTags(MAX_TAGS + 1))).toMatchObject({
      ok: false,
      code: "TAG_LIMIT",
    });
  });

  it("не считает дубликаты превышением лимита", () => {
    const tags = [...uniqueTags(MAX_TAGS), "TAG-0"];

    expect(validateTags(tags)).toEqual({
      ok: true,
      value: uniqueTags(MAX_TAGS),
    });
  });
});

describe("validateSubtaskParent", () => {
  it("разрешает корневую задачу того же проекта", () => {
    expect(
      validateSubtaskParent("project-1", {
        id: "parent-1",
        projectId: "project-1",
        parentTaskId: null,
      }),
    ).toEqual({ ok: true, value: { parentTaskId: "parent-1" } });
  });

  it("запрещает подзадачу второго уровня", () => {
    expect(
      validateSubtaskParent("project-1", {
        id: "parent-1",
        projectId: "project-1",
        parentTaskId: "root-1",
      }),
    ).toMatchObject({ ok: false, code: "SUBTASK_DEPTH_EXCEEDED" });
  });

  it("запрещает родителя из другого проекта", () => {
    expect(
      validateSubtaskParent("project-2", {
        id: "parent-1",
        projectId: "project-1",
        parentTaskId: null,
      }),
    ).toMatchObject({ ok: false, code: "PARENT_IN_OTHER_PROJECT" });
  });

  it("сообщает об отсутствующем родителе", () => {
    expect(validateSubtaskParent("project-1", null)).toMatchObject({
      ok: false,
      code: "PARENT_NOT_FOUND",
    });
    expect(validateSubtaskParent("project-1", undefined)).toMatchObject({
      ok: false,
      code: "PARENT_NOT_FOUND",
    });
  });
});

describe("resolveCompletedAt", () => {
  it("фиксирует время при переходе в done", () => {
    expect(resolveCompletedAt("done", null, now)).toBe(now);
  });

  it("сохраняет существующее время при повторном done", () => {
    expect(resolveCompletedAt("done", "2025-12-31T23:00:00.000Z", now)).toBe(
      "2025-12-31T23:00:00.000Z",
    );
  });

  it("очищает completedAt при выходе из done", () => {
    expect(resolveCompletedAt("in_progress", now, now)).toBeNull();
    expect(resolveCompletedAt("todo", now, now)).toBeNull();
    expect(resolveCompletedAt("backlog", null, now)).toBeNull();
  });

  it("отклоняет неверный timestamp", () => {
    expect(() => resolveCompletedAt("done", null, "2026-01-01")).toThrowError(TasksValidationError);
  });
});

describe("pagination and versions", () => {
  it("подставляет значения по умолчанию", () => {
    expect(validatePagination({})).toEqual({
      ok: true,
      value: { limit: DEFAULT_LIST_LIMIT, offset: 0 },
    });
  });

  it("проверяет границы limit и offset", () => {
    expect(validatePagination({ limit: 1, offset: 0 })).toEqual({
      ok: true,
      value: { limit: 1, offset: 0 },
    });
    expect(validatePagination({ limit: 0 })).toMatchObject({ ok: false, code: "INVALID_LIMIT" });
    expect(validatePagination({ limit: MAX_LIST_LIMIT + 1 })).toMatchObject({
      ok: false,
      code: "INVALID_LIMIT",
    });
    expect(validateOffset(-1)).toMatchObject({ ok: false, code: "INVALID_OFFSET" });
    expect(validateOffset(2.5)).toMatchObject({ ok: false, code: "INVALID_OFFSET" });
  });

  it("проверяет позицию", () => {
    expect(validatePosition(0)).toEqual({ ok: true, value: 0 });
    expect(validatePosition(-1)).toMatchObject({ ok: false, code: "INVALID_POSITION" });
    expect(validatePosition(1.5)).toMatchObject({ ok: false, code: "INVALID_POSITION" });
  });

  it("задаёт область позиции только по projectId и status", () => {
    expect(taskPositionScopeKey("project-1", "todo")).toBe("project-1:todo");
    expect(taskPositionScopeKey("project-1", "todo")).toBe(
      taskPositionScopeKey("project-1", "todo"),
    );
    expect(taskPositionScopeKey("project-1", "todo")).not.toBe(
      taskPositionScopeKey("project-1", "done"),
    );
    expect(taskPositionScopeKey("project-1", "todo")).not.toBe(
      taskPositionScopeKey("project-2", "todo"),
    );
  });

  it("проверяет expectedVersion для update и create", () => {
    expect(validateExpectedVersion(1)).toEqual({ ok: true, value: 1 });
    expect(validateExpectedVersion(0)).toMatchObject({
      ok: false,
      code: "INVALID_EXPECTED_VERSION",
    });
    expect(validateExpectedVersion(0, { allowZero: true })).toEqual({ ok: true, value: 0 });
    expect(validateExpectedVersion(1.5)).toMatchObject({
      ok: false,
      code: "INVALID_EXPECTED_VERSION",
    });
  });
});

describe("validateTitle", () => {
  it("обрезает заголовок и отклоняет пустой", () => {
    expect(validateTitle("  Задача  ")).toEqual({ ok: true, value: "Задача" });
    expect(validateTitle("   ")).toMatchObject({ ok: false, code: "INVALID_TITLE" });
    expect(validateTitle(42)).toMatchObject({ ok: false, code: "INVALID_TITLE" });
  });
});
