import { describe, expect, it } from "vitest";

import {
  formatColumnRef,
  formatProjectRef,
  formatTaskRef,
  isProjectRef,
  isTaskRef,
  parseProjectRef,
  parseTaskRef,
  parseTasksResourceRef,
  tryParseTasksResourceRef,
} from "./resources.ts";

describe("ResourceRef домена задач", () => {
  it("собирает стабильные ссылки", () => {
    expect(formatProjectRef("project-1")).toBe("kanbaner.tasks:project:project-1");
    expect(formatTaskRef("task-1")).toBe("kanbaner.tasks:task:task-1");
    expect(formatColumnRef("column-1")).toBe("kanbaner.tasks:task-column:column-1");
  });

  it("разбирает собственные ссылки", () => {
    expect(parseProjectRef("kanbaner.tasks:project:project-1")).toBe("project-1");
    expect(parseTaskRef("kanbaner.tasks:task:task-1")).toBe("task-1");
    expect(parseTasksResourceRef("kanbaner.tasks:task:task-1")).toEqual({
      kind: "task",
      id: "task-1",
    });
    expect(parseTasksResourceRef("kanbaner.tasks:task-column:column-1")).toEqual({
      kind: "task-column",
      id: "column-1",
    });
  });

  it("проверяет pluginId, тип и opaque id", () => {
    expect(isProjectRef("kanbaner.tasks:project:project-1")).toBe(true);
    expect(isTaskRef("kanbaner.tasks:task:task-1")).toBe(true);
    expect(isProjectRef("kanbaner.notes:project:project-1")).toBe(false);
    expect(isTaskRef("kanbaner.tasks:project:task-1")).toBe(false);
    expect(isTaskRef("kanbaner.tasks:task:")).toBe(false);
    expect(isTaskRef("kanbaner.tasks:task:bad:id")).toBe(false);
    expect(isTaskRef(42)).toBe(false);
  });

  it("бросает ошибку при чужом pluginId или типе", () => {
    expect(() => parseTaskRef("kanbaner.notes:task:task-1")).toThrowError(TypeError);
    expect(() => parseProjectRef("kanbaner.tasks:task:task-1")).toThrowError(TypeError);
    expect(() => parseTasksResourceRef("kanbaner.notes:task:task-1")).toThrowError(TypeError);
    expect(() => parseTasksResourceRef("kanbaner.tasks:note:note-1")).toThrowError(TypeError);
  });

  it("не разбирает чужие ссылки без исключения", () => {
    expect(tryParseTasksResourceRef("kanbaner.notes:task:task-1")).toBeNull();
    expect(tryParseTasksResourceRef("kanbaner.tasks:note:note-1")).toBeNull();
    expect(tryParseTasksResourceRef("kanbaner.tasks:task-column:column-1")).toEqual({
      kind: "task-column",
      id: "column-1",
    });
    expect(tryParseTasksResourceRef(undefined)).toBeNull();
  });

  it("запрещает двоеточие в opaque id", () => {
    expect(() => formatTaskRef("bad:id")).toThrowError(TypeError);
  });
});
