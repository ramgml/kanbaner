import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KANBAN_ROUTE, TASK_LIST_ROUTE } from "../metadata.ts";
import { readLastProjectView, rememberProjectView } from "./workspace.ts";

const LAST_VIEW_KEY = "kanbaner.projects.lastView";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readLastProjectView", () => {
  it("возвращает сохранённый список", () => {
    rememberProjectView(TASK_LIST_ROUTE);

    expect(readLastProjectView()).toBe(TASK_LIST_ROUTE);
  });

  it("возвращает сохранённый канбан", () => {
    rememberProjectView(KANBAN_ROUTE);

    expect(readLastProjectView()).toBe(KANBAN_ROUTE);
  });

  it("без сохранённого значения открывает канбан", () => {
    expect(readLastProjectView()).toBe(KANBAN_ROUTE);
  });

  it("неизвестное значение трактуется как канбан", () => {
    window.localStorage.setItem(LAST_VIEW_KEY, "/view/unknown");

    expect(readLastProjectView()).toBe(KANBAN_ROUTE);
  });

  it("служебный обзор не сохраняется как последний вид и трактуется как канбан", () => {
    window.localStorage.setItem(LAST_VIEW_KEY, "/view/projects");

    expect(readLastProjectView()).toBe(KANBAN_ROUTE);
  });

  it("возвращает канбан, если storage бросает SecurityError", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Доступ запрещён", "SecurityError");
    });

    // Чтение storage не должно ронять вход: fallback — канбан.
    expect(readLastProjectView()).toBe(KANBAN_ROUTE);
  });
});
