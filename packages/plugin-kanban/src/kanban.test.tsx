import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import { TaskOverlay } from "./ui/task-overlay.tsx";
import { resetKanbanQueryForTests } from "./ui/query-state.ts";

const project: Project = {
  id: "project-1",
  title: "Проект один",
  descriptionMarkdown: "",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

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

interface FakeBoard {
  tasks: Task[];
  projects: Project[];
}

type Handler = (input: JsonValue) => UiOperationResult | Promise<UiOperationResult>;

interface FakeOperations {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ readonly operationId: string; readonly input: JsonValue }>;
  readonly counts: ReadonlyMap<string, number>;
  readonly board: FakeBoard;
}

function ok(data: JsonValue): UiOperationResult {
  return { ok: true, data };
}

function fail(code: string, message = code): UiOperationResult {
  return { ok: false, error: { code, message, retryable: code === "VERSION_CONFLICT" } };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function compareTasks(left: Task, right: Task): number {
  return left.position === right.position
    ? left.id.localeCompare(right.id)
    : left.position - right.position;
}

function listTasks(board: FakeBoard, input: JsonValue): UiOperationResult {
  const filters = inputOf(input);
  let items = [...board.tasks];

  if (typeof filters.status === "string") {
    items = items.filter((task) => task.status === filters.status);
  }

  if (typeof filters.projectId === "string") {
    items = items.filter((task) => task.projectId === filters.projectId);
  }

  if (typeof filters.tag === "string") {
    items = items.filter((task) => task.tags.includes(filters.tag as string));
  }

  if ("parentTaskId" in filters) {
    items = items.filter((task) => task.parentTaskId === filters.parentTaskId);
  }

  items.sort(compareTasks);

  const offset = typeof filters.offset === "number" ? filters.offset : 0;
  const limit = typeof filters.limit === "number" ? filters.limit : 50;
  const page = items.slice(offset, offset + limit);

  return ok({
    items: page,
    total: items.length,
    nextOffset: offset + page.length < items.length ? offset + page.length : null,
  });
}

function getTask(board: FakeBoard, id: string): Task | undefined {
  return board.tasks.find((task) => task.id === id);
}

/**
 * Доменная модель перемещения для тестов: позиции пересчитываются в области
 * `(projectId, status)`, версия сдвинутой карточки повышается.
 */
function applyMove(
  board: FakeBoard,
  input: JsonValue,
): { readonly ok: true; readonly task: Task } | { readonly ok: false; readonly code: string } {
  const values = inputOf(input);
  const id = String(values.id);
  const task = getTask(board, id);

  if (task === undefined) {
    return { ok: false, code: "NOT_FOUND" };
  }

  if (task.version !== values.expectedVersion) {
    return { ok: false, code: "VERSION_CONFLICT" };
  }

  const status = values.status as TaskStatus;
  const position = Number(values.position);
  const projectTasks = board.tasks.filter((candidate) => candidate.projectId === task.projectId);
  const target = projectTasks
    .filter((candidate) => candidate.status === status && candidate.id !== id)
    .sort(compareTasks);
  const source = projectTasks
    .filter((candidate) => candidate.status === task.status && candidate.id !== id)
    .sort(compareTasks);

  target.splice(Math.min(position, target.length), 0, task);

  const updated = new Map<string, Task>();

  target.forEach((candidate, index) => {
    updated.set(candidate.id, {
      ...candidate,
      status,
      position: index,
      version: candidate.id === id ? candidate.version + 1 : candidate.version,
      completedAt: status === "done" ? (candidate.completedAt ?? TIMESTAMP) : null,
      updatedAt: TIMESTAMP,
    } as Task);
  });

  if (task.status !== status) {
    source.forEach((candidate, index) => {
      updated.set(candidate.id, { ...candidate, position: index } as Task);
    });
  }

  board.tasks = board.tasks.map((candidate) => updated.get(candidate.id) ?? candidate);

  return { ok: true, task: updated.get(id) ?? task };
}

function createOperations(
  board: FakeBoard,
  overrides: Record<string, Handler> = {},
): FakeOperations {
  const calls: Array<{ operationId: string; input: JsonValue }> = [];
  const counts = new Map<string, number>();

  const defaults: Record<string, Handler> = {
    "kanbaner.tasks.project.list": () =>
      ok({ items: board.projects, total: board.projects.length, nextOffset: null }),
    "kanbaner.tasks.project.get": (input) => {
      const found = board.projects.find((item) => item.id === inputOf(input).id);

      return found === undefined ? fail("NOT_FOUND") : ok({ project: found });
    },
    "kanbaner.tasks.task.list": (input) => listTasks(board, input),
    "kanbaner.tasks.task.get": (input) => {
      const found = getTask(board, String(inputOf(input).id));

      return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
    },
    "kanbaner.tasks.task.move": (input) => {
      const result = applyMove(board, input);

      return result.ok ? ok({ task: result.task }) : fail(result.code);
    },
  };

  const invoke: UiOperationInvoker = async (operationId, input) => {
    calls.push({ operationId, input });
    counts.set(operationId, (counts.get(operationId) ?? 0) + 1);
    const handler = overrides[operationId] ?? defaults[operationId];

    if (handler === undefined) {
      return fail("NOT_FOUND", `Нет обработчика ${operationId}`);
    }

    return handler(input);
  };

  return { invoke, calls, counts, board };
}

function cardTitles(status: TaskStatus): string[] {
  const column = screen.getByTestId(`kanban-cards-${status}`);

  return within(column)
    .getAllByRole("button", { name: /Открыть карточку задачи/u })
    .map((button) => button.textContent ?? "");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/view/kanban");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
});

describe("KanbanView", () => {
  it("показывает четыре колонки, карточки, поля и число подзадач", async () => {
    const parent = makeTask("parent", {
      title: "Родитель",
      status: "backlog",
      priority: "high",
      dueAt: "2030-01-10T00:00:00.000Z",
      tags: ["release"],
    });
    const child = makeTask("child", {
      title: "Подзадача",
      status: "backlog",
      position: 1,
      parentTaskId: "parent",
    });
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        parent,
        child,
        makeTask("todo-task", { status: "todo" }),
        makeTask("progress-task", { status: "in_progress" }),
        makeTask("done-task", { status: "done" }),
      ],
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-parent");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("2");
    });

    expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-count-in_progress")).toHaveTextContent("1");
    expect(screen.getByTestId("kanban-count-done")).toHaveTextContent("1");

    const parentCard = screen.getByTestId("kanban-card-parent");

    expect(parentCard).toHaveTextContent("Родитель");
    expect(parentCard).toHaveTextContent("Высокий");
    expect(parentCard).toHaveTextContent("10.01.2030");
    expect(parentCard).toHaveTextContent("release");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtasks-parent")).toHaveTextContent("Подзадачи: 1");
    });
    expect(screen.getByTestId("kanban-subtasks-child")).toHaveTextContent("Подзадачи: 0");
    expect(cardTitles("todo")).toEqual(["Задача todo-task"]);
  });

  it("перемещает через меню с expectedVersion, статусом и позицией", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: ["a", "b", "c"].map((id, index) =>
        makeTask(id, { title: id, status: "todo", position: index }),
      ),
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-a");
    expect(cardTitles("todo")).toEqual(["a", "b", "c"]);

    fireEvent.click(
      within(screen.getByTestId("kanban-card-a")).getByRole("button", { name: "Ниже" }),
    );

    await waitFor(() => {
      const lastMove = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.move")
        .at(-1);

      expect(inputOf(lastMove?.input ?? {})).toMatchObject({
        id: "a",
        expectedVersion: 1,
        status: "todo",
        position: 1,
      });
    });

    await waitFor(() => {
      expect(cardTitles("todo")).toEqual(["b", "a", "c"]);
    });

    fireEvent.click(
      within(screen.getByTestId("kanban-card-c")).getByRole("button", {
        name: "Переместить в Готово",
      }),
    );

    await waitFor(() => {
      const lastMove = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.move")
        .at(-1);

      expect(inputOf(lastMove?.input ?? {})).toMatchObject({
        id: "c",
        expectedVersion: 1,
        status: "done",
        position: 0,
      });
    });

    await waitFor(() => {
      expect(cardTitles("done")).toEqual(["c"]);
    });
  });

  it("показывает оптимистичное перемещение и откатывает его при ошибке", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "A", status: "todo" })],
    };
    let resolveMove: ((result: UiOperationResult) => void) | null = null;
    const pending = new Promise<UiOperationResult>((resolve) => {
      resolveMove = resolve;
    });
    const operations = createOperations(board, {
      "kanbaner.tasks.task.move": () => pending,
    });

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-a");
    fireEvent.click(
      within(screen.getByTestId("kanban-card-a")).getByRole("button", {
        name: "Переместить в Готово",
      }),
    );

    // Карточка сразу в целевой колонке, pending — только на ней.
    expect(
      within(screen.getByTestId("kanban-column-done")).getByTestId("kanban-card-a"),
    ).toBeTruthy();
    expect(screen.getByTestId("kanban-pending-a")).toHaveTextContent("Сохранение…");
    expect(screen.getByTestId("kanban-count-done")).toHaveTextContent("1");
    expect(
      screen.getByTestId("kanban-column-todo").contains(screen.getByTestId("kanban-card-a")),
    ).toBe(false);

    await act(async () => {
      resolveMove?.(fail("INTERNAL_ERROR", "Сервер недоступен"));
      await pending;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-error")).toHaveTextContent("Сервер недоступен");
    });
    expect(
      within(screen.getByTestId("kanban-column-todo")).getByTestId("kanban-card-a"),
    ).toBeTruthy();
    expect(screen.queryByTestId("kanban-pending-a")).toBeNull();
  });

  it("при VERSION_CONFLICT откатывает карточку, перечитывает доску и не перезаписывает чужие данные", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "A", status: "todo" })],
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.move": () => {
        // Другая вкладка уже перевела задачу в done.
        applyMove(board, {
          id: "a",
          expectedVersion: 1,
          status: "done",
          position: 0,
        } as unknown as JsonValue);

        return fail("VERSION_CONFLICT");
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-a");
    fireEvent.click(
      within(screen.getByTestId("kanban-card-a")).getByRole("button", {
        name: "Переместить в Готово",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("kanban-error")).toHaveTextContent(
        "Задача уже изменена в другом месте",
      );
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-done")).getByTestId("kanban-card-a"),
      ).toBeTruthy();
    });
    expect(screen.getByTestId("kanban-conflict-a")).toHaveTextContent("Конфликт версий");
    expect(screen.getByTestId("kanban-count-done")).toHaveTextContent("1");
    expect(operations.counts.get("kanbaner.tasks.task.move")).toBe(1);
    expect(board.tasks.find((task) => task.id === "a")?.title).toBe("A");
  });

  it("догружает колонку страницами, сохраняя порядок и без дублей", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 12 }, (_, index) =>
        makeTask(`p${String(index).padStart(2, "0")}`, {
          title: `P${String(index).padStart(2, "0")}`,
          status: "backlog",
          position: index,
        }),
      ),
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("12");
    });
    expect(cardTitles("backlog")).toHaveLength(10);
    expect(screen.getByTestId("kanban-load-more-backlog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(cardTitles("backlog")).toHaveLength(12);
    });
    expect(cardTitles("backlog")).toEqual(
      Array.from({ length: 12 }, (_, index) => `P${String(index).padStart(2, "0")}`),
    );
    expect(new Set(cardTitles("backlog")).size).toBe(12);
    expect(screen.queryByTestId("kanban-load-more-backlog")).toBeNull();

    const pageCalls = operations.calls.filter(
      (call) =>
        call.operationId === "kanbaner.tasks.task.list" && inputOf(call.input).status === "backlog",
    );

    expect(pageCalls.some((call) => inputOf(call.input).offset === 10)).toBe(true);
  });
});

describe("TaskOverlay", () => {
  it("открывается только на /view/kanban и при выбранной карточке, закрывается Escape", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "A", status: "todo" })],
    };
    const operations = createOperations(board);

    const view = render(
      <>
        <KanbanView invoke={operations.invoke} />
        <TaskOverlay invoke={operations.invoke} pathname="/view/kanban" />
      </>,
    );

    await screen.findByTestId("kanban-card-a");
    expect(screen.queryByTestId("kanban-details")).toBeNull();

    fireEvent.click(screen.getByTestId("kanban-open-a"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-details")).toHaveTextContent("A");
    });
    expect(window.location.search).toContain("task=a");
    expect(screen.getByTestId("kanban-details").tagName).toBe("DIALOG");
    expect(screen.getByTestId("kanban-details").contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(window.location.search).not.toContain("task=");
    expect(document.activeElement).toBe(screen.getByTestId("kanban-open-a"));

    // Повторно открываем и уходим на другой маршрут: overlay исчезает.
    fireEvent.click(screen.getByTestId("kanban-open-a"));
    await waitFor(() => {
      expect(screen.getByTestId("kanban-details")).toBeInTheDocument();
    });

    view.rerender(
      <>
        <KanbanView invoke={operations.invoke} />
        <TaskOverlay invoke={operations.invoke} pathname="/view/tasks" />
      </>,
    );

    expect(screen.queryByTestId("kanban-details")).toBeNull();
  });
});
