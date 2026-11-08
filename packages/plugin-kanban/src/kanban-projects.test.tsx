import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
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

interface FakeOperations {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ readonly operationId: string; readonly input: JsonValue }>;
  readonly board: Board;
}

function ok(data: JsonValue): UiOperationResult {
  return { ok: true, data };
}

function fail(code: string, message = code): UiOperationResult {
  return { ok: false, error: { code, message, retryable: false } };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });

  return {
    promise,
    resolve: (value) => {
      resolve?.(value);
    },
  };
}

function numberField(input: JsonValue, key: string): number | null {
  const value = inputOf(input)[key];

  return typeof value === "number" ? value : null;
}

function compareTasks(left: Task, right: Task): number {
  return left.position === right.position
    ? left.id.localeCompare(right.id)
    : left.position - right.position;
}

function isOverdue(task: Task): boolean {
  return task.status !== "done" && task.dueAt !== null && Date.parse(task.dueAt) < NOW;
}

function summarize(board: Board, input: JsonValue): UiOperationResult {
  const projectId = inputOf(input).projectId;
  const limit = numberField(input, "limit") ?? 12;
  const offset = numberField(input, "offset") ?? 0;
  const projects =
    typeof projectId === "string"
      ? board.projects.filter((project) => project.id === projectId)
      : board.projects;

  if (typeof projectId === "string" && projects.length === 0) {
    return fail("NOT_FOUND", "Проект не найден");
  }

  const all = projects.map((project) => {
    const tasks = board.tasks.filter((task) => task.projectId === project.id);

    return {
      project,
      total: tasks.length,
      counts: {
        backlog: tasks.filter((task) => task.status === "backlog").length,
        todo: tasks.filter((task) => task.status === "todo").length,
        in_progress: tasks.filter((task) => task.status === "in_progress").length,
        done: tasks.filter((task) => task.status === "done").length,
      },
      overdueCount: tasks.filter(isOverdue).length,
    };
  });
  const page = all.slice(offset, offset + limit);
  const totals = all.reduce(
    (aggregate, summary) => ({
      total: aggregate.total + summary.total,
      counts: {
        backlog: aggregate.counts.backlog + summary.counts.backlog,
        todo: aggregate.counts.todo + summary.counts.todo,
        in_progress: aggregate.counts.in_progress + summary.counts.in_progress,
        done: aggregate.counts.done + summary.counts.done,
      },
      overdueCount: aggregate.overdueCount + summary.overdueCount,
    }),
    {
      total: 0,
      counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
      overdueCount: 0,
    },
  );

  return ok({
    items: page,
    total: all.length,
    nextOffset: offset + page.length < all.length ? offset + page.length : null,
    totals,
  });
}

function listTasks(board: Board, input: JsonValue): UiOperationResult {
  const filters = inputOf(input);
  let items = [...board.tasks];

  if (typeof filters.status === "string") {
    items = items.filter((task) => task.status === filters.status);
  }

  if (typeof filters.projectId === "string") {
    items = items.filter((task) => task.projectId === filters.projectId);
  }

  items.sort(compareTasks);

  const offset = numberField(input, "offset") ?? 0;
  const limit = numberField(input, "limit") ?? 50;
  const page = items.slice(offset, offset + limit);

  return ok({
    items: page,
    total: items.length,
    nextOffset: offset + page.length < items.length ? offset + page.length : null,
  });
}

function createOperations(board: Board): FakeOperations {
  const calls: Array<{ readonly operationId: string; readonly input: JsonValue }> = [];
  let sequence = 0;

  const invoke: UiOperationInvoker = async (operationId, input) => {
    calls.push({ operationId, input });

    if (operationId === "kanbaner.tasks.project.list") {
      const offset = numberField(input, "offset") ?? 0;
      const limit = numberField(input, "limit") ?? 50;
      const page = board.projects.slice(offset, offset + limit);

      return ok({
        items: page,
        total: board.projects.length,
        nextOffset: offset + page.length < board.projects.length ? offset + page.length : null,
      });
    }

    if (operationId === "kanbaner.tasks.project.summary") {
      return summarize(board, input);
    }

    if (operationId === "kanbaner.tasks.project.create") {
      const values = inputOf(input);
      const project = makeProject(
        `project-${String(board.projects.length + 1)}`,
        String(values.title),
        String(values.descriptionMarkdown ?? ""),
      );

      board.projects = [...board.projects, project];

      return ok({ project });
    }

    if (operationId === "kanbaner.tasks.task.list") {
      return listTasks(board, input);
    }

    if (operationId === "kanbaner.tasks.task.create") {
      const values = inputOf(input);
      const projectId = String(values.projectId);
      const status = (values.status as TaskStatus | undefined) ?? "todo";
      const position = board.tasks.filter(
        (task) => task.projectId === projectId && task.status === status,
      ).length;

      sequence += 1;

      const task = makeTask(`task-${String(sequence)}`, {
        projectId,
        title: String(values.title),
        status,
        position,
      });

      board.tasks = [...board.tasks, task];

      return ok({ task });
    }

    if (operationId === "kanbaner.tasks.task.move") {
      const values = inputOf(input);
      const task = board.tasks.find((candidate) => candidate.id === values.id);

      if (task === undefined) {
        return fail("NOT_FOUND", "Нет задачи");
      }

      board.tasks = board.tasks.map((candidate) =>
        candidate.id === task.id
          ? ({
              ...candidate,
              status: values.status as TaskStatus,
              version: candidate.version + 1,
            } as Task)
          : candidate,
      );

      return ok({ task });
    }

    return fail("NOT_FOUND", operationId);
  };

  return { invoke, calls, board };
}

function summaryCallCount(operations: FakeOperations): number {
  return operations.calls.filter((call) => call.operationId === "kanbaner.tasks.project.summary")
    .length;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/view/kanban");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
});

describe("Проекты как доски", () => {
  it("показывает карточки с описанием, счётчиками по статусам и просроченными", async () => {
    const board: Board = {
      projects: [
        makeProject("project-1", "Релиз", "Описание релиза"),
        makeProject("project-2", "Второй"),
      ],
      tasks: [
        makeTask("a", { status: "backlog", dueAt: "2020-01-01T00:00:00.000Z" }),
        makeTask("b", { status: "todo", dueAt: "2020-01-02T00:00:00.000Z" }),
        makeTask("c", { status: "in_progress" }),
        makeTask("d", { status: "done", dueAt: "2020-01-03T00:00:00.000Z" }),
        makeTask("e", { projectId: "project-2", status: "done" }),
      ],
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-mode-projects")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("kanban-mode-projects"));

    const card = await screen.findByTestId("kanban-project-card-project-1");

    expect(card).toHaveTextContent("Релиз");
    expect(card).toHaveTextContent("Описание релиза");
    expect(screen.getByTestId("kanban-project-project-1-count-backlog")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-project-project-1-count-todo")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-project-project-1-count-in_progress")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-project-project-1-count-done")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-project-overdue-project-1")).toHaveTextContent(
      "Просрочено: 2",
    );
    expect(screen.getByTestId("kanban-project-overdue-project-2")).toHaveTextContent(
      "Просрочено: 0",
    );
    expect(screen.getByTestId("kanban-projects-total")).toHaveTextContent("5");
    expect(screen.getByTestId("kanban-projects-overdue")).toHaveTextContent("2");
  });

  it("открывает доску проекта по карточке и список по второй ссылке", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Релиз")],
      tasks: [makeTask("a")],
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-mode-projects")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("kanban-mode-projects"));
    await screen.findByTestId("kanban-project-card-project-1");

    const listLink = screen.getByTestId("kanban-project-list-project-1");

    expect(listLink).toHaveAttribute("href", "/view/tasks?project=project-1");

    fireEvent.click(screen.getByTestId("kanban-project-open-project-1"));

    await waitFor(() => {
      expect(window.location.search).toContain("project=project-1");
    });
    expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Релиз");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-columns")).toBeInTheDocument();
    });
  });

  it("загружает проекты страницами и добавляет следующую без потери", async () => {
    const board: Board = {
      projects: Array.from({ length: 14 }, (_, index) =>
        makeProject(`project-${String(index + 1)}`, `Проект ${String(index + 1)}`),
      ),
      tasks: [],
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-mode-projects")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("kanban-mode-projects"));

    await screen.findByTestId("kanban-project-card-project-1");
    expect(screen.queryByTestId("kanban-project-card-project-13")).toBeNull();
    expect(screen.getByTestId("kanban-projects-grid").children).toHaveLength(12);

    fireEvent.click(screen.getByTestId("kanban-projects-load-more"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-project-card-project-14")).toBeInTheDocument();
    });
    expect(screen.getByTestId("kanban-projects-grid").children).toHaveLength(14);
    expect(screen.getByTestId("kanban-project-card-project-1")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-projects-load-more")).toBeNull();

    const offsets = operations.calls
      .filter((call) => call.operationId === "kanbaner.tasks.project.summary")
      .map((call) => numberField(call.input, "offset"));

    expect(offsets).toContain(0);
    expect(offsets).toContain(12);
  });

  it("заголовок «Все проекты» показывает агрегат, выбранный проект — свою сводку", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Первый"), makeProject("project-2", "Второй")],
      tasks: [
        makeTask("a", { status: "backlog" }),
        makeTask("b", { status: "todo" }),
        makeTask("c", { projectId: "project-2", status: "done" }),
      ],
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-total")).toHaveTextContent("3");
    });
    expect(screen.getByTestId("kanban-summary-backlog")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-summary-todo")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-summary-done")).toHaveTextContent("1");

    act(() => {
      updateKanbanQuery({ projectId: "project-1", taskId: null });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-total")).toHaveTextContent("2");
    });
    expect(screen.getByTestId("kanban-summary-backlog")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-summary-done")).toHaveTextContent("0");

    const selectedCall = operations.calls
      .filter((call) => call.operationId === "kanbaner.tasks.project.summary")
      .map((call) => inputOf(call.input))
      .find((input) => input.projectId === "project-1");

    expect(selectedCall).toBeDefined();
  });

  it("обновляет сводку после перемещения карточки", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Релиз")],
      tasks: [makeTask("a", { status: "todo" })],
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-1");
    resetKanbanQueryForTests("?project=project-1");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-todo")).toHaveTextContent("1");
    });

    const before = summaryCallCount(operations);
    const card = await screen.findByTestId("kanban-card-a");
    const menu = card.querySelector("summary");

    expect(menu).not.toBeNull();
    fireEvent.click(menu as HTMLElement);
    fireEvent.click(within(card).getByRole("button", { name: "Переместить в Готово" }));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-done")).toHaveTextContent("1");
    });
    expect(screen.getByTestId("kanban-summary-todo")).toHaveTextContent("0");
    expect(summaryCallCount(operations)).toBeGreaterThan(before);
  });

  it("обновляет сводку после создания проекта", async () => {
    const board: Board = { projects: [], tasks: [] };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-empty-projects")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("kanban-mode-projects"));
    await screen.findByTestId("kanban-projects-empty");

    const before = summaryCallCount(operations);

    fireEvent.click(screen.getByTestId("kanban-projects-create-first"));

    const form = await screen.findByTestId("project-form");

    fireEvent.change(within(form).getByLabelText("Название проекта"), {
      target: { value: "Новый проект" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать проект" }));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-project-card-project-1")).toBeInTheDocument();
    });
    expect(summaryCallCount(operations)).toBeGreaterThan(before);
  });

  it("не считает счётчики по странице карточек", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Большой")],
      tasks: Array.from({ length: 30 }, (_, index) =>
        makeTask(`task-${String(index)}`, { status: "todo", position: index }),
      ),
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-1");
    resetKanbanQueryForTests("?project=project-1");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-total")).toHaveTextContent("30");
    });
    expect(screen.getByTestId("kanban-summary-todo")).toHaveTextContent("30");

    // Колонка показывает только первую страницу, но сводка остаётся полной.
    expect(screen.getByTestId("kanban-cards-todo").children).toHaveLength(10);
  });

  it("игнорирует запоздавший ответ сводки прежнего проекта", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Первый"), makeProject("project-2", "Второй")],
      tasks: [
        makeTask("a1", { projectId: "project-1", status: "backlog", position: 0 }),
        makeTask("a2", { projectId: "project-1", status: "backlog", position: 1 }),
        makeTask("a3", { projectId: "project-1", status: "backlog", position: 2 }),
        makeTask("b1", { projectId: "project-2", status: "todo" }),
      ],
    };
    const operations = createOperations(board);
    const pending = new Map<string, Deferred<UiOperationResult>>();
    const invoke: UiOperationInvoker = async (operationId, input) => {
      const projectId = inputOf(input).projectId;

      if (operationId === "kanbaner.tasks.project.summary" && typeof projectId === "string") {
        const request = deferred<UiOperationResult>();

        pending.set(projectId, request);

        return request.promise;
      }

      return operations.invoke(operationId, input);
    };

    window.history.replaceState(null, "", "/view/kanban?project=project-1");
    resetKanbanQueryForTests("?project=project-1");
    render(<KanbanView invoke={invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(pending.has("project-1")).toBe(true);
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-2", taskId: null });
    });
    await waitFor(() => {
      expect(pending.has("project-2")).toBe(true);
    });

    // Ответы приходят в обратном порядке: сначала B, затем устаревший A.
    act(() => {
      pending
        .get("project-2")
        ?.resolve(summarize(board, { projectId: "project-2", limit: 1, offset: 0 }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-total")).toHaveTextContent("1");
    });
    expect(screen.getByTestId("kanban-summary-todo")).toHaveTextContent("1");

    act(() => {
      pending
        .get("project-1")
        ?.resolve(summarize(board, { projectId: "project-1", limit: 1, offset: 0 }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-total")).toHaveTextContent("1");
    });
    expect(screen.getByTestId("kanban-summary-backlog")).toHaveTextContent("0");
    expect(screen.getByTestId("kanban-summary-todo")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Второй");
  });

  it("берёт выбранный проект за пределами первых 200 из сводки", async () => {
    const projects = Array.from({ length: 205 }, (_, index) =>
      makeProject(`project-${String(index + 1)}`, `Проект ${String(index + 1)}`),
    );

    projects[204] = makeProject("project-205", "Проект 205", "Описание 205");

    const board: Board = {
      projects,
      tasks: [
        makeTask("task-205-a", { projectId: "project-205", status: "todo", position: 0 }),
        makeTask("task-205-b", { projectId: "project-205", status: "done", position: 0 }),
      ],
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-205");
    resetKanbanQueryForTests("?project=project-205");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Проект 205");
    });
    expect(screen.getByTestId("kanban-board-description")).toHaveTextContent("Описание 205");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-summary-total")).toHaveTextContent("2");
    });
    expect(screen.getByTestId("kanban-summary-todo")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-summary-done")).toHaveTextContent("1");

    const select = screen
      .getByTestId("kanban-filters")
      .querySelector<HTMLSelectElement>('select[name="projectId"]');

    expect(select).not.toBeNull();
    expect(select).toHaveValue("project-205");
    expect([...(select as HTMLSelectElement).options].map((option) => option.value)).toContain(
      "project-205",
    );

    // project.list вернул только первые 200, но выбранный проект остаётся в
    // опциях и заголовке благодаря project.summary: 1 «Все проекты» + 200 + 1.
    expect((select as HTMLSelectElement).options).toHaveLength(202);
  });
});
