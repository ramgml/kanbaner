import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskColumn, TaskColumnType } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import { resetKanbanQueryForTests } from "./ui/query-state.ts";

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

const project: Project = {
  id: "project-1",
  title: "Проект колонок",
  descriptionMarkdown: "",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function makeColumn(
  id: string,
  title: string,
  status: TaskColumn["status"],
  position: number,
  version = 1,
): TaskColumn {
  return {
    id,
    projectId: "project-1",
    title,
    status,
    position,
    version,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function defaultColumns(): TaskColumn[] {
  return [
    makeColumn("column-project-1-todo", "ToDo", "todo", 0),
    makeColumn("column-project-1-in-progress", "In Progress", "in_progress", 1),
    makeColumn("column-project-1-done", "Done", "done", 2),
  ];
}

function makeTask(id: string, column: TaskColumn, position: number, title = id): Task {
  return {
    id,
    projectId: "project-1",
    parentTaskId: null,
    columnId: column.id,
    title,
    descriptionMarkdown: "",
    priority: "medium",
    dueAt: null,
    position,
    tags: [],
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    status: column.status,
    completedAt: column.status === "done" ? TIMESTAMP : null,
  } as Task;
}

interface Board {
  readonly tasks: Task[];
  readonly columns: TaskColumn[];
  nextColumn: number;
}

type Handler = (input: JsonValue) => UiOperationResult | Promise<UiOperationResult>;

function ok(data: JsonValue): UiOperationResult {
  return { ok: true, data };
}

function fail(code: string, message = code): UiOperationResult {
  return { ok: false, error: { code, message, retryable: code === "VERSION_CONFLICT" } };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function sortColumns(columns: readonly TaskColumn[]): TaskColumn[] {
  return [...columns].sort((left, right) =>
    left.position === right.position
      ? left.id.localeCompare(right.id)
      : left.position - right.position,
  );
}

function createOperations(
  board: Board,
  overrides: Record<string, Handler> = {},
): {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ operationId: string; input: JsonValue }>;
} {
  const calls: Array<{ operationId: string; input: JsonValue }> = [];
  const replaceColumns = (next: TaskColumn[]): void => {
    board.columns.splice(0, board.columns.length, ...next);
  };

  const defaults: Record<string, Handler> = {
    "kanbaner.tasks.project.list": () => ok({ items: [project], total: 1, nextOffset: null }),
    "kanbaner.tasks.project.summary": () => {
      const counts = { backlog: 0, todo: 0, in_progress: 0, done: 0 };

      for (const task of board.tasks) {
        counts[task.status] += 1;
      }

      return ok({
        items: [{ project, total: board.tasks.length, counts, overdueCount: 0 }],
        total: 1,
        nextOffset: null,
        totals: { total: board.tasks.length, counts, overdueCount: 0 },
      });
    },
    "kanbaner.tasks.project.get": () => ok({ project }),
    "kanbaner.tasks.column.list": () => {
      const columns = sortColumns(board.columns);

      return ok({ items: columns, total: columns.length, nextOffset: null });
    },
    "kanbaner.tasks.column.create": (input) => {
      const values = inputOf(input);
      const type = values.type as TaskColumnType;
      const column: TaskColumn = {
        id: `column-project-1-custom-${String(board.nextColumn)}`,
        projectId: "project-1",
        title: String(values.title),
        status: type === "done" ? "done" : "in_progress",
        position: board.columns.length,
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      };

      board.nextColumn += 1;
      board.columns.push(column);

      return ok({ column, resource: {}, eventId: "event" });
    },
    "kanbaner.tasks.column.update": (input) => {
      const values = inputOf(input);
      const index = board.columns.findIndex((column) => column.id === values.id);

      if (index === -1) {
        return fail("NOT_FOUND");
      }

      const current = board.columns[index] as TaskColumn;

      if (current.version !== values.expectedVersion) {
        return fail("VERSION_CONFLICT");
      }

      const updated = { ...current, title: String(values.title), version: current.version + 1 };

      board.columns[index] = updated;

      return ok({ column: updated, resource: {}, eventId: "event" });
    },
    "kanbaner.tasks.column.move": (input) => {
      const values = inputOf(input);
      const current = board.columns.find((column) => column.id === values.id);

      if (current === undefined) {
        return fail("NOT_FOUND");
      }

      if (current.version !== values.expectedVersion) {
        return fail("VERSION_CONFLICT");
      }

      const others = sortColumns(board.columns).filter((column) => column.id !== current.id);
      const index = Math.max(0, Math.min(Number(values.position), others.length));
      const next = [...others.slice(0, index), current, ...others.slice(index)].map(
        (column, position) =>
          column.position === position && column.id !== current.id
            ? column
            : { ...column, position, version: column.version + 1 },
      );

      replaceColumns(next);

      return ok({
        column: next.find((column) => column.id === current.id) ?? current,
        resource: {},
        eventId: "event",
      });
    },
    "kanbaner.tasks.column.delete": (input) => {
      const values = inputOf(input);
      const current = board.columns.find((column) => column.id === values.id);
      const target = board.columns.find((column) => column.id === values.targetColumnId);

      if (current === undefined || target === undefined) {
        return fail("NOT_FOUND");
      }

      if (current.version !== values.expectedVersion) {
        return fail("VERSION_CONFLICT");
      }

      if (current.id === target.id) {
        return fail("COLUMN_TARGET_SELF");
      }

      const moved = board.tasks.filter((task) => task.columnId === current.id);
      const targetTasks = board.tasks.filter((task) => task.columnId === target.id);
      const append = targetTasks.reduce((max, task) => Math.max(max, task.position), -1) + 1;

      for (const [index, task] of moved.entries()) {
        const position = board.tasks.indexOf(task);

        board.tasks[position] = {
          ...task,
          columnId: target.id,
          status: target.status,
          position: append + index,
          completedAt: target.status === "done" ? (task.completedAt ?? TIMESTAMP) : null,
          version: task.version + 1,
        } as Task;
      }

      board.columns.splice(
        0,
        board.columns.length,
        ...board.columns.filter((column) => column.id !== current.id),
      );

      return ok({
        deleted: true,
        resource: {},
        version: current.version,
        eventVersion: current.version + 1,
        targetColumnId: target.id,
        movedTasks: moved,
        eventId: "event",
      });
    },
    "kanbaner.tasks.task.list": (input) => {
      const values = inputOf(input);
      const columnId = typeof values.columnId === "string" ? values.columnId : null;
      const items = board.tasks
        .filter((task) => columnId === null || task.columnId === columnId)
        .sort((left, right) => left.position - right.position);

      return ok({ items, total: items.length, nextOffset: null });
    },
    "kanbaner.tasks.task.get": (input) => {
      const found = board.tasks.find((task) => task.id === valuesOf(input).id);

      return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
    },
    "kanbaner.tasks.task.move": () => fail("INTERNAL_ERROR"),
  };

  const invoke: UiOperationInvoker = async (operationId, input) => {
    calls.push({ operationId, input });
    const handler = overrides[operationId] ?? defaults[operationId];

    return handler === undefined ? fail("NOT_FOUND", operationId) : handler(input);
  };

  return { invoke, calls };
}

function valuesOf(input: JsonValue): Record<string, unknown> {
  return inputOf(input);
}

function renderBoard(
  board: Board,
  overrides: Record<string, Handler> = {},
): ReturnType<typeof createOperations> {
  const operations = createOperations(board, overrides);

  render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

  return operations;
}

async function openMenu(columnId: string, slug: string): Promise<void> {
  const column = document.querySelector<HTMLElement>(`[data-kanban-column-id="${columnId}"]`);
  const details = column?.querySelector("details");

  if (details !== null && details !== undefined) {
    details.open = true;
  }

  await waitFor(() => {
    expect(screen.getByTestId(`kanban-column-menu-${slug}`)).toBeInTheDocument();
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/view/kanban?project=project-1");
  resetKanbanQueryForTests("?project=project-1");
});

afterEach(() => {
  cleanup();
});

describe("управление колонками в KanbanView", () => {
  it("новый проект показывает три default-колонки и не навязывает Backlog", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };

    renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    expect(screen.getByTestId("kanban-column-title-in_progress")).toHaveTextContent("In Progress");
    expect(screen.getByTestId("kanban-column-title-done")).toHaveTextContent("Done");
    expect(screen.queryByTestId("kanban-column-backlog")).toBeNull();
    expect(screen.getByTestId("kanban-add-column")).toBeVisible();
  });

  it("добавляет open и Done-колонки через форму с валидацией и без дублей", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    const operations = renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-add-column")).toBeVisible();
    });

    fireEvent.click(screen.getByTestId("kanban-add-column"));
    expect(screen.getByTestId("kanban-column-title-input")).toHaveFocus();
    expect(screen.getByTestId("kanban-column-submit")).toBeDisabled();

    fireEvent.change(screen.getByTestId("kanban-column-title-input"), {
      target: { value: "Проверка" },
    });
    fireEvent.change(screen.getByTestId("kanban-column-type"), { target: { value: "done" } });
    fireEvent.click(screen.getByTestId("kanban-column-submit"));

    await waitFor(() => {
      expect(
        operations.calls.filter((call) => call.operationId === "kanbaner.tasks.column.create"),
      ).toHaveLength(1);
    });
    expect(
      inputOf(
        operations.calls.find((call) => call.operationId === "kanbaner.tasks.column.create")
          ?.input ?? {},
      ),
    ).toMatchObject({
      projectId: "project-1",
      title: "Проверка",
      type: "done",
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-kanban-column-id="column-project-1-custom-1"]'),
      ).not.toBeNull();
    });
    expect(
      screen.getByTestId("kanban-column-title-column-column-project-1-custom-1"),
    ).toHaveTextContent("Проверка");
  });

  it("переименовывает колонку с expectedVersion и сохраняет ввод при ошибке", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    const operations = renderBoard(board, {
      "kanbaner.tasks.column.update": () => fail("VALIDATION_ERROR", "Не удалось переименовать"),
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-rename-todo"));
    fireEvent.change(screen.getByTestId("kanban-column-rename-input-todo"), {
      target: { value: "Очередь" },
    });
    fireEvent.click(screen.getByTestId("kanban-column-rename-submit-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-rename-error-todo")).toHaveTextContent(
        "Не удалось переименовать",
      );
    });
    expect(screen.getByTestId("kanban-column-rename-input-todo")).toHaveValue("Очередь");
    expect(
      inputOf(
        operations.calls.find((call) => call.operationId === "kanbaner.tasks.column.update")
          ?.input ?? {},
      ),
    ).toMatchObject({
      id: "column-project-1-todo",
      expectedVersion: 1,
      title: "Очередь",
    });
  });

  it("переставляет колонки оптимистично и откатывает при ошибке", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    renderBoard(board, {
      "kanbaner.tasks.column.move": () => fail("INTERNAL_ERROR", "Сервер недоступен"),
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });

    const columns = (): Array<string | null> =>
      [...document.querySelectorAll<HTMLElement>("[data-kanban-column-id]")].map((element) =>
        element.getAttribute("data-kanban-column-id"),
      );

    expect(columns()).toEqual([
      "column-project-1-todo",
      "column-project-1-in-progress",
      "column-project-1-done",
    ]);

    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-move-right-todo"));

    await waitFor(() => {
      expect(columns()).toEqual([
        "column-project-1-in-progress",
        "column-project-1-todo",
        "column-project-1-done",
      ]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-error")).toHaveTextContent("Сервер недоступен");
    });
    await waitFor(() => {
      expect(columns()).toEqual([
        "column-project-1-todo",
        "column-project-1-in-progress",
        "column-project-1-done",
      ]);
    });
  });

  it("показывает конфликт версии колонки и перечитывает фактический порядок", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    renderBoard(board, {
      "kanbaner.tasks.column.move": () => fail("VERSION_CONFLICT"),
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-move-right-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-conflict-todo")).toHaveTextContent(
        "Конфликт версий",
      );
    });
    expect(screen.getByTestId("kanban-error")).toHaveTextContent("Колонка уже изменена");
  });

  it("удаляет колонку только с явным target и переносит задачи", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const done = columns[2] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A"), makeTask("b", todo, 1, "B")],
      nextColumn: 1,
    };
    const operations = renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("2");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));

    const dialog = await screen.findByTestId("kanban-column-delete-dialog");

    expect(within(dialog).getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("2");

    fireEvent.change(screen.getByTestId("kanban-column-delete-target"), {
      target: { value: done.id },
    });
    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-column-todo")).toBeNull();
    });
    expect(
      inputOf(
        operations.calls.find((call) => call.operationId === "kanbaner.tasks.column.delete")
          ?.input ?? {},
      ),
    ).toMatchObject({
      id: todo.id,
      expectedVersion: 1,
      confirm: true,
      targetColumnId: done.id,
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-done")).toHaveTextContent("2");
    });
    expect(within(screen.getByTestId("kanban-column-scroll-done")).getByText("A")).toBeVisible();
  });

  it("при переносе в Done проставляет completedAt и поддерживает несколько Done-колонок", async () => {
    const columns = [
      ...defaultColumns(),
      makeColumn("column-project-1-done-2", "Done 2", "done", 3),
    ];
    const todo = columns[0] as TaskColumn;
    const done2 = columns[3] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A")],
      nextColumn: 1,
    };

    renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("1");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));
    fireEvent.change(screen.getByTestId("kanban-column-delete-target"), {
      target: { value: done2.id },
    });
    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-column-todo")).toBeNull();
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-scroll-column-column-project-1-done-2")).getByText(
          "A",
        ),
      ).toBeVisible();
    });

    const moved = board.tasks.find((task) => task.id === "a");

    expect(moved?.columnId).toBe(done2.id);
    expect(moved?.status).toBe("done");
    expect(moved?.completedAt).toBe(TIMESTAMP);
    expect(
      screen.getByTestId("kanban-column-title-column-column-project-1-done-2"),
    ).toHaveTextContent("Done 2");
  });

  it("оставляет перемещение колонок доступным с клавиатуры и на мобильной ширине", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-tab-todo")).toBeVisible();
    });
    expect(screen.getByTestId("kanban-tab-in_progress")).toBeVisible();
    expect(screen.getByTestId("kanban-tab-done")).toBeVisible();
    expect(screen.getByTestId("kanban-add-column")).toBeVisible();

    await openMenu("column-project-1-in-progress", "in_progress");
    const left = screen.getByTestId("kanban-column-move-left-in_progress");
    const right = screen.getByTestId("kanban-column-move-right-in_progress");

    left.focus();
    expect(left).toHaveFocus();
    expect(left).toHaveClass("min-h-10");
    expect(right).toHaveClass("min-h-10");
    expect(screen.getByTestId("kanban-column-rename-in_progress")).toBeEnabled();
  });
});
