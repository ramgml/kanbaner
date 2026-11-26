import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KANBAN_ROUTE, TASK_LIST_ROUTE } from "../metadata.ts";
import { ViewToggle } from "./view-toggle.tsx";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("ViewToggle", () => {
  it("переносит project/tag/task в оба представления и держит aria-pressed в обоих состояниях", () => {
    render(<ViewToggle route={TASK_LIST_ROUTE} search="?project=p&tag=t&task=x" />);

    const list = screen.getByTestId("project-view-list");
    const kanban = screen.getByTestId("project-view-kanban");

    expect(list.tagName).toBe("A");
    expect(kanban.tagName).toBe("A");
    expect(list).toHaveAttribute("href", "/view/tasks?project=p&tag=t&task=x");
    expect(kanban).toHaveAttribute("href", "/view/kanban?project=p&tag=t&task=x");
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(kanban).toHaveAttribute("aria-pressed", "false");
    expect(list).toHaveAttribute("aria-current", "page");
    expect(kanban).not.toHaveAttribute("aria-current");

    cleanup();

    render(<ViewToggle route={KANBAN_ROUTE} search="?project=p&tag=t&task=x" />);

    expect(screen.getByTestId("project-view-list")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("project-view-kanban")).toHaveAttribute("aria-pressed", "true");
  });

  it("запоминает выбранное представление для входа из shell", () => {
    render(<ViewToggle route={TASK_LIST_ROUTE} search="" />);

    fireEvent.click(screen.getByTestId("project-view-kanban"));

    expect(window.localStorage.getItem("kanbaner.projects.lastView")).toBe(KANBAN_ROUTE);
  });
});
