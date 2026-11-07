import { describe, expect, it } from "vitest";

import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, MAX_TAGS } from "./constants.ts";
import {
  TasksValidationError,
  normalizeTag,
  normalizeTags,
  resolveCompletedAt,
  taskPositionScopeKey,
  validateCompletionInvariant,
  validateExpectedVersion,
  validateNormalizedTags,
  validateStoredTask,
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

  it("нормализует один тег для фильтра task.list.tag", () => {
    expect(normalizeTag("  Work  ")).toBe("work");
    expect(() => normalizeTag("   ")).toThrowError(TasksValidationError);
    expect(() => normalizeTag("a".repeat(33))).toThrowError(TasksValidationError);
  });
});

describe("validateNormalizedTags", () => {
  it("принимает уже нормализованные теги", () => {
    expect(validateNormalizedTags(["work", "ä"])).toEqual({
      ok: true,
      value: ["work", "ä"],
    });
  });

  it("отклоняет верхний регистр, внешние пробелы и дубликаты", () => {
    for (const tags of [
      ["Work"],
      [" work"],
      ["work "],
      ["work", "work"],
      ["work", "WORK"],
      ["Ä"],
    ]) {
      expect(validateNormalizedTags(tags)).toMatchObject({
        ok: false,
        code: "INVALID_NORMALIZED_TAGS",
      });
    }
  });
});

describe("validateStoredTask", () => {
  const completedAt = "2026-01-01T00:00:00.000Z";

  it("проверяет инвариант completedAt и нормализованные теги", () => {
    expect(validateStoredTask({ status: "done", completedAt, tags: ["work"] })).toEqual({
      ok: true,
      value: true,
    });
    expect(validateStoredTask({ status: "done", completedAt: null, tags: ["work"] })).toMatchObject(
      { ok: false, code: "INVALID_COMPLETION" },
    );
    expect(validateStoredTask({ status: "todo", completedAt: null, tags: ["Work"] })).toMatchObject(
      { ok: false, code: "INVALID_NORMALIZED_TAGS" },
    );
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

  it("покрывает create, move и повторный complete", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const updatedAt = "2026-01-02T00:00:00.000Z";

    expect(resolveCompletedAt("done", null, createdAt)).toBe(createdAt);
    expect(resolveCompletedAt("done", null, updatedAt)).toBe(updatedAt);
    expect(resolveCompletedAt("in_progress", updatedAt, now)).toBeNull();
    expect(resolveCompletedAt("done", createdAt, updatedAt)).toBe(createdAt);
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

describe("validateCompletionInvariant", () => {
  it("принимает done с completedAt и остальные статусы без него", () => {
    expect(validateCompletionInvariant({ status: "done", completedAt: now })).toEqual({
      ok: true,
      value: true,
    });
    expect(validateCompletionInvariant({ status: "backlog", completedAt: null })).toEqual({
      ok: true,
      value: true,
    });
    expect(validateCompletionInvariant({ status: "todo", completedAt: null })).toEqual({
      ok: true,
      value: true,
    });
    expect(validateCompletionInvariant({ status: "in_progress", completedAt: null })).toEqual({
      ok: true,
      value: true,
    });
  });

  it("отклоняет done без completedAt и completedAt вне done", () => {
    expect(validateCompletionInvariant({ status: "done", completedAt: null })).toMatchObject({
      ok: false,
      code: "INVALID_COMPLETION",
    });
    expect(validateCompletionInvariant({ status: "todo", completedAt: now })).toMatchObject({
      ok: false,
      code: "INVALID_COMPLETION",
    });
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
