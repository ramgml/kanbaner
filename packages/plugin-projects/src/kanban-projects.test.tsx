import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type {
  Project,
  ProjectSummaryOutput,
  Task,
  TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import { ProjectsOverview } from "./ui/projects-overview.tsx";
import { resetKanbanQueryForTests, updateKanbanQuery } from "./ui/query-state.ts";

const TIMESTAMP = "2026-02-01T00:00:00.000Z";
const NOW = Date.now();

function makeProject(id: string, title = `Проект ${id}`, descriptionMarkdown = ""): Project {
  return { id, title, descriptionMarkdown, version: 1, createdAt: TIMESTAMP, updatedAt: TIMESTAMP };
}

function makeTask(
  id: string,
  overrides: Partial<Task> & { readonly status?: TaskStatus } = {},
): Task {
  const status = overrides.status ?? "todo";

  return {
    id,
    projectId: "project-1",
    parentTaskId: null,
    title: `Задача ${id}`,
    descriptionMarkdown: "",
    priority: "medium",
    dueAt: null,
    position: 0,
    tags: [],
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    status,
    completedAt: status === "done" ? TIMESTAMP : null,
    ...overrides,
  } as Task;
}

interface Board {
  projects: Project[];
  tasks: Task[];
}

function ok(data: JsonValue): UiOperationResult {
  return { ok: true, data };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function isOverdue(task: Task): boolean {
  return task.status !== "done" && task.dueAt !== null && Date.parse(task.dueAt) < NOW;
}

function summarize(board: Board, input: JsonValue): ProjectSummaryOutput {
  const projectId = inputOf(input).projectId;
  const limit = typeof inputOf(input).limit === "number" ? (inputOf(input).limit as number) : 12;
  const offset = typeof inputOf(input).offset === "number" ? (inputOf(input).offset as number) : 0;
  const projects =
    typeof projectId === "string"
      ? board.projects.filter((project) => project.id === projectId)
      : board.projects;
  const summaries = projects.map((project) => {
    const tasks = board.tasks.filter((task) => task.projectId === project.id);
    const counts: Record<TaskStatus, number> = { backlog: 0, todo: 0, in_progress: 0, done: 0 };

    for (const task of tasks) {
      counts[task.status] += 1;
    }

    return {
      project,
      total: tasks.length,
      counts,
      overdueCount: tasks.filter(isOverdue).length,
    };
  });
  const page = summaries.slice(offset, offset + limit);
  const allTasks = board.tasks;
  const allCounts: Record<TaskStatus, number> = { backlog: 0, todo: 0, in_progress: 0, done: 0 };

  for (const task of allTasks) {
    allCounts[task.status] += 1;
  }

  return {
    items: page,
    total: summaries.length,
    nextOffset: offset + page.length < summaries.length ? offset + page.length : null,
    totals: {
      total: allTasks.length,
      counts: allCounts,
      overdueCount: allTasks.filter(isOverdue).length,
    },
  };
}

function makeInvoke(board: Board): UiOperationInvoker {
  return async (operationId, input) => {
    if (operationId === "kanbaner.tasks.project.list") {
      return ok({ items: board.projects, total: board.projects.length, nextOffset: null });
    }

    if (operationId === "kanbaner.tasks.project.summary") {
      return ok(summarize(board, input) as unknown as JsonValue);
    }

    if (operationId === "kanbaner.tasks.task.list") {
      return ok({ items: [], total: 0, nextOffset: null });
    }

    return ok({ items: [], total: 0, nextOffset: null });
  };
}

function boardWithProjects(): Board {
  return {
    projects: [
      makeProject("project-1", "Релиз", "Описание релиза"),
      makeProject("project-2", "Поддержка"),
    ],
    tasks: [
      makeTask("a", { projectId: "project-1", status: "backlog" }),
      makeTask("b", { projectId: "project-1", status: "todo" }),
      makeTask("c", { projectId: "project-1", status: "in_progress" }),
      makeTask("d", { projectId: "project-1", status: "done" }),
      makeTask("e", {
        projectId: "project-1",
        status: "todo",
        dueAt: "2020-01-01T00:00:00.000Z",
      }),
      makeTask("f", {
        projectId: "project-2",
        status: "todo",
        dueAt: "2020-01-01T00:00:00.000Z",
      }),
    ],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/view/projects");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
});

describe("Обзор проектов", () => {
  it("показывает карточки с описанием, счётчиками по статусам и просроченными", async () => {
    const board = boardWithProjects();

    render(<ProjectsOverview invoke={makeInvoke(board)} search="" />);

    const card = await screen.findByTestId("projects-overview-card-project-1");

    expect(card).toHaveTextContent("Релиз");
    expect(card).toHaveTextContent("Описание релиза");
    expect(screen.getByTestId("projects-overview-total-project-1")).toHaveTextContent("5");
    expect(screen.getByTestId("projects-overview-count-project-1-backlog")).toHaveTextContent("1");
    expect(screen.getByTestId("projects-overview-count-project-1-todo")).toHaveTextContent("2");
    expect(screen.getByTestId("projects-overview-count-project-1-in_progress")).toHaveTextContent(
      "1",
    );
    expect(screen.getByTestId("projects-overview-count-project-1-done")).toHaveTextContent("1");
    expect(screen.getByTestId("projects-overview-overdue-project-1")).toHaveTextContent("1");
    expect(screen.getByTestId("projects-overview-overdue-project-2")).toHaveTextContent("1");
    expect(screen.getByTestId("projects-overview-total-tasks")).toHaveTextContent("6");
    expect(screen.getByTestId("projects-overview-overdue")).toHaveTextContent("2");
  });

  it("открывает доску проекта ссылкой и список второй ссылкой", async () => {
    const board = boardWithProjects();

    render(<ProjectsOverview invoke={makeInvoke(board)} search="" />);

    await screen.findByTestId("projects-overview-card-project-1");
    expect(screen.getByTestId("projects-overview-board-project-1")).toHaveAttribute(
      "href",
      "/view/kanban?project=project-1",
    );
    expect(screen.getByTestId("projects-overview-list-project-1")).toHaveAttribute(
      "href",
      "/view/tasks?project=project-1",
    );
    expect(screen.getByTestId("projects-overview-open-project-1")).toHaveAttribute(
      "href",
      "/view/kanban?project=project-1",
    );
  });

  it("загружает проекты страницами и добавляет следующую без потери", async () => {
    const board: Board = {
      projects: Array.from({ length: 14 }, (_, index) =>
        makeProject(`project-${String(index + 1)}`, `Проект ${String(index + 1)}`),
      ),
      tasks: [],
    };

    render(<ProjectsOverview invoke={makeInvoke(board)} search="" />);

    await screen.findByTestId("projects-overview-card-project-1");
    expect(screen.queryByTestId("projects-overview-card-project-13")).toBeNull();
    expect(screen.getByTestId("projects-overview-grid").children).toHaveLength(12);

    fireEvent.click(screen.getByTestId("projects-overview-load-more"));

    await waitFor(() => {
      expect(screen.getByTestId("projects-overview-card-project-14")).toBeInTheDocument();
    });
    expect(screen.getByTestId("projects-overview-grid").children).toHaveLength(14);
    expect(screen.getByTestId("projects-overview-card-project-1")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-overview-load-more")).toBeNull();
  });

  it("без проектов показывает пустой обзор", async () => {
    render(<ProjectsOverview invoke={makeInvoke({ projects: [], tasks: [] })} search="" />);

    expect(await screen.findByTestId("projects-overview-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-overview-grid")).toBeNull();
  });

  it("подсвечивает проект из ?project= и не показывает агрегированную доску", async () => {
    const board = boardWithProjects();

    render(<ProjectsOverview invoke={makeInvoke(board)} search="?project=project-2" />);

    const card = await screen.findByTestId("projects-overview-card-project-2");

    expect(card).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("projects-overview-card-project-1")).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("Канбан одного проекта", () => {
  it("при нескольких проектах без выбора показывает подсказку, а не агрегированную доску", async () => {
    const board = boardWithProjects();

    render(<KanbanView invoke={makeInvoke(board)} pathname="/view/kanban" />);

    expect(await screen.findByTestId("kanban-project-picker")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-project-card-project-1")).toBeNull();
    expect(screen.queryByTestId("kanban-projects-grid")).toBeNull();
    expect(screen.queryByTestId("kanban-mode-projects")).toBeNull();
  });

  it("выбранный проект показывает свою сводку и не показывает бейдж проекта", async () => {
    const board = boardWithProjects();
    const invoke = makeInvoke(board);

    render(<KanbanView invoke={invoke} pathname="/view/kanban" />);
    await screen.findByTestId("kanban-project-picker");

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Релиз");
    });

    const summary = await screen.findByTestId("kanban-board-summary");

    expect(within(summary).getByTestId("kanban-summary-total")).toHaveTextContent("5");
    expect(within(summary).getByTestId("kanban-summary-backlog")).toHaveTextContent("1");
    expect(within(summary).getByTestId("kanban-summary-todo")).toHaveTextContent("2");
    expect(within(summary).getByTestId("kanban-summary-in_progress")).toHaveTextContent("1");
    expect(within(summary).getByTestId("kanban-summary-done")).toHaveTextContent("1");
    expect(within(summary).getByTestId("kanban-summary-overdue")).toHaveTextContent("1");
    expect(screen.queryByTestId(/^kanban-project-badge-/u)).toBeNull();
  });
});
