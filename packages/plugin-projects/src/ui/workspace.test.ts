import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readLastProjectView } from "./workspace.ts";

const LAST_VIEW_KEY = "kanbaner.projects.lastView";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readLastProjectView", () => {
  it("возвращает сохранённое представление", () => {
    window.localStorage.setItem(LAST_VIEW_KEY, "/view/tasks");

    expect(readLastProjectView()).toBe("/view/tasks");
  });

  it("игнорирует неизвестное значение", () => {
    window.localStorage.setItem(LAST_VIEW_KEY, "/view/unknown");

    expect(readLastProjectView()).toBeNull();
  });

  it("возвращает null, если storage бросает SecurityError", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Доступ запрещён", "SecurityError");
    });

    // Вход должен остаться в обзоре, а не падать на чтении localStorage.
    expect(readLastProjectView()).toBeNull();
  });
});
