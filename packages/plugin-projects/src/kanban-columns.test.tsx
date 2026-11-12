import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskColumn, TaskColumnType } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import { resetKanbanQueryForTests, updateKanbanQuery } from "./ui/query-state.ts";

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
  projectId = "project-1",
): TaskColumn {
  return {
    id,
    projectId,
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

function emptyResult(): UiOperationResult {
  return ok({ items: [], total: 0, nextOffset: null });
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
      const tag = typeof values.tag === "string" ? values.tag : null;
      const items = board.tasks
        .filter((task) => columnId === null || task.columnId === columnId)
        .filter((task) => tag === null || task.tags.includes(tag))
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
    expect(screen.queryByTestId("kanban-add-column")).toBeNull();
  });

  it("создаёт open и Done-колонки из настроек и показывает их на доске", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    const operations = renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    expect(screen.queryByTestId("kanban-add-column")).toBeNull();

    fireEvent.click(screen.getByTestId("project-settings-button"));

    const input = (await screen.findByTestId(
      "project-settings-column-create-title",
    )) as HTMLInputElement;

    expect(screen.getByTestId("project-settings-column-create-submit")).toBeDisabled();

    fireEvent.change(input, { target: { value: "Проверка" } });
    fireEvent.change(screen.getByTestId("project-settings-column-create-type"), {
      target: { value: "done" },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-create-submit"));

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
      expect(screen.getByTestId("project-settings-column-create-notice")).toHaveTextContent(
        "Колонка добавлена",
      );
    });
    expect(
      screen.getByTestId("project-settings-column-input-column-project-1-custom-1"),
    ).toHaveValue("Проверка");
    expect(screen.getByTestId("project-settings-column-column-project-1-custom-1")).toHaveAttribute(
      "data-settings-column-id",
      "column-project-1-custom-1",
    );

    fireEvent.click(screen.getByTestId("project-settings-done"));

    await waitFor(() => {
      expect(
        screen.getByTestId("kanban-column-title-column-column-project-1-custom-1"),
      ).toHaveTextContent("Проверка");
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("kanban-column-empty-column-column-project-1-custom-1"),
      ).toBeVisible();
    });
  });

  it("после create просит повторить загрузку, а не создание, и не теряет факт создания", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    let listCalls = 0;
    let createCalls = 0;
    const operations = renderBoard(board, {
      "kanbaner.tasks.column.create": (input) => {
        createCalls += 1;
        const values = inputOf(input);
        const column = makeColumn(
          "column-project-1-custom-1",
          String(values.title),
          "in_progress",
          3,
        );

        board.columns.push(column);

        return ok({ column, resource: {}, eventId: "event" });
      },
      "kanbaner.tasks.column.list": () => {
        listCalls += 1;

        return listCalls <= 2
          ? ok({ items: board.columns, total: board.columns.length, nextOffset: null })
          : fail("INTERNAL_ERROR", "Список колонок недоступен");
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    fireEvent.click(screen.getByTestId("project-settings-button"));
    await screen.findByTestId("project-settings-column-create-title");
    fireEvent.change(screen.getByTestId("project-settings-column-create-title"), {
      target: { value: "Проверка" },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-create-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-columns-refresh-error")).toHaveTextContent(
        "создавать колонку повторно не нужно",
      );
    });
    expect(createCalls).toBe(1);
    expect(screen.getByTestId("project-settings-column-create-title")).toHaveValue("");
    expect(screen.queryByTestId("project-settings-column-create-error")).toBeNull();
    expect(
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.column.create"),
    ).toHaveLength(1);
    expect(screen.getByTestId("project-settings-columns-retry")).toBeEnabled();
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

  it("закрывает меню колонки по клику вне, Escape и после действия", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });

    const menuDetails = (): HTMLDetailsElement =>
      screen.getByTestId("kanban-column-menu-todo") as HTMLDetailsElement;

    await openMenu("column-project-1-todo", "todo");
    expect(menuDetails().open).toBe(true);

    fireEvent.pointerDown(document.body);
    expect(menuDetails().open).toBe(false);

    // Escape вне меню закрывает его, но не перехватывает событие и не
    // переносит фокус с активного контрола.
    const dragHandle = screen.getByTestId("kanban-column-drag-todo");

    await openMenu("column-project-1-todo", "todo");
    expect(menuDetails().open).toBe(true);
    dragHandle.focus();
    fireEvent.keyDown(dragHandle, { key: "Escape" });
    expect(menuDetails().open).toBe(false);
    expect(document.activeElement).toBe(dragHandle);

    // Открываем меню повторно: Escape внутри меню закрывает его и возвращает
    // фокус trigger-у.
    const summary = screen.getByLabelText("Действия колонки «ToDo»");

    await openMenu("column-project-1-todo", "todo");
    expect(menuDetails().open).toBe(true);
    fireEvent.keyDown(summary, { key: "Escape" });
    expect(menuDetails().open).toBe(false);
    expect(document.activeElement).toBe(summary);

    // Выбор действия не оставляет меню открытым.
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-move-right-todo"));
    expect(menuDetails().open).toBe(false);
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

    await waitFor(() => {
      expect(within(dialog).getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("2");
    });
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

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("1");
    });

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
    expect(screen.queryByTestId("kanban-add-column")).toBeNull();

    await openMenu("column-project-1-in-progress", "in_progress");
    const left = screen.getByTestId("kanban-column-move-left-in_progress");
    const right = screen.getByTestId("kanban-column-move-right-in_progress");

    left.focus();
    expect(left).toHaveFocus();
    expect(left).toHaveClass("min-h-10");
    expect(right).toHaveClass("min-h-10");
    expect(screen.getByTestId("kanban-column-rename-in_progress")).toBeEnabled();
  });

  it("не показывает колонки и карточки A после переключения на B до column.list B", async () => {
    const columnsA = defaultColumns().map((column) =>
      makeColumn(
        column.id.replace("project-1", "project-a"),
        column.title,
        column.status,
        column.position,
        1,
        "project-a",
      ),
    );
    const columnsB = defaultColumns().map((column) =>
      makeColumn(
        column.id.replace("project-1", "project-b"),
        column.title,
        column.status,
        column.position,
        1,
        "project-b",
      ),
    );
    const taskA = makeTask("task-a", columnsA[0] as TaskColumn, 0, "Задача A");

    let resolveB: ((value: UiOperationResult) => void) | null = null;
    const delayedB = new Promise<UiOperationResult>((settle) => {
      resolveB = settle;
    });
    const projects = [
      { ...project, id: "project-a", title: "Проект A" },
      { ...project, id: "project-b", title: "Проект B" },
    ];

    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok({ items: projects, total: 2, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.column.list") {
        const projectId = String(inputOf(input).projectId);

        if (projectId === "project-b") {
          return delayedB;
        }

        return ok({
          items: columnsA,
          total: columnsA.length,
          nextOffset: null,
        });
      }

      if (operationId === "kanbaner.tasks.task.list") {
        const values = inputOf(input);
        const projectId = String(values.projectId);
        const columnId = typeof values.columnId === "string" ? values.columnId : null;
        const items = projectId === "project-a" && columnId === columnsA[0]?.id ? [taskA] : [];

        return ok({ items, total: items.length, nextOffset: null });
      }

      return emptyResult();
    };

    window.history.replaceState(null, "", "/view/kanban?project=project-a");
    resetKanbanQueryForTests("?project=project-a");
    render(<KanbanView invoke={invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-task-a")).toBeVisible();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-b" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-loading")).toBeVisible();
    });
    expect(document.querySelectorAll("[data-kanban-column-id]")).toHaveLength(0);
    expect(screen.queryByTestId("kanban-card-task-a")).toBeNull();
    expect(screen.getByTestId("kanban-create-task")).toBeDisabled();
    expect(screen.queryByTestId("kanban-add-column")).toBeNull();

    await act(async () => {
      resolveB?.(
        ok({
          items: columnsB,
          total: columnsB.length,
          nextOffset: null,
        }),
      );
      await delayedB;
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-kanban-column-id="column-project-b-todo"]'),
      ).not.toBeNull();
    });
    expect(document.querySelector('[data-kanban-column-id="column-project-a-todo"]')).toBeNull();
    expect(screen.queryByTestId("kanban-card-task-a")).toBeNull();
    expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
  });

  it("считает задачи для удаления точным запросом без активного tag", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("hidden-by-tag", todo, 0, "Скрытая тегом")],
      nextColumn: 1,
    };

    window.history.replaceState(null, "", "/view/kanban?project=project-1&tag=release");
    resetKanbanQueryForTests("?project=project-1&tag=release");
    renderBoard(board);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("0");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("1");
    });
    expect(screen.getByTestId("kanban-column-delete-confirm")).toBeEnabled();
  });

  it("блокирует удаление до точного счётчика и показывает ошибку счётчика", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A")],
      nextColumn: 1,
    };
    let resolveCount: ((value: UiOperationResult) => void) | null = null;
    const delayedCount = new Promise<UiOperationResult>((settle) => {
      resolveCount = settle;
    });

    renderBoard(board, {
      "kanbaner.tasks.task.list": (input) => {
        const values = inputOf(input);

        if (
          values.limit === 1 &&
          values.offset === 0 &&
          values.tag === undefined &&
          typeof values.columnId === "string" &&
          values.parentTaskId === undefined
        ) {
          return delayedCount;
        }

        return ok({ items: board.tasks, total: board.tasks.length, nextOffset: null });
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("1");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));

    expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("…");
    expect(screen.getByTestId("kanban-column-delete-confirm")).toBeDisabled();

    await act(async () => {
      resolveCount?.(fail("INTERNAL_ERROR", "Счётчик недоступен"));
      await delayedCount;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-count-error")).toHaveTextContent(
        "Счётчик недоступен",
      );
    });
    expect(screen.getByTestId("kanban-column-delete-confirm")).toBeDisabled();
  });

  it("переименование ждёт refresh, показывает успех только после него", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    const todo = board.columns[0] as TaskColumn;
    let resolveRefresh: ((value: UiOperationResult) => void) | null = null;
    const delayedRefresh = new Promise<UiOperationResult>((settle) => {
      resolveRefresh = settle;
    });
    let listCalls = 0;

    renderBoard(board, {
      "kanbaner.tasks.column.list": () => {
        listCalls += 1;

        return listCalls === 1
          ? ok({ items: board.columns, total: board.columns.length, nextOffset: null })
          : delayedRefresh;
      },
      "kanbaner.tasks.column.update": () =>
        ok({
          column: { ...todo, title: "Очередь", version: 2 },
          resource: {},
          eventId: "event",
        }),
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
      expect(screen.getByTestId("kanban-column-rename-submit-todo")).toBeDisabled();
    });
    expect(screen.queryByTestId("kanban-column-notice")).toBeNull();

    await act(async () => {
      resolveRefresh?.(ok({ items: board.columns, total: board.columns.length, nextOffset: null }));
      await delayedRefresh;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-notice")).toHaveTextContent("Колонка переименована");
    });
  });

  it("при конфликте переименования обновляет версию до повторной отправки", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    let updateCalls = 0;
    const versions: unknown[] = [];

    renderBoard(board, {
      "kanbaner.tasks.column.update": (input) => {
        updateCalls += 1;
        const values = inputOf(input);

        versions.push(values.expectedVersion);

        if (updateCalls === 1) {
          board.columns[0] = { ...(board.columns[0] as TaskColumn), version: 2 };

          return fail("VERSION_CONFLICT");
        }

        return ok({
          column: {
            ...(board.columns[0] as TaskColumn),
            title: String(values.title),
            version: 3,
          },
          resource: {},
          eventId: "event",
        });
      },
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
        "Версия обновлена",
      );
    });

    fireEvent.click(screen.getByTestId("kanban-column-rename-submit-todo"));
    await waitFor(() => {
      expect(updateCalls).toBe(2);
    });
    expect(versions).toEqual([1, 2]);
  });

  it("reorder держит pending до refresh и показывает успех только после него", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    let listCalls = 0;
    let resolveRefresh: ((value: UiOperationResult) => void) | null = null;
    const delayedRefresh = new Promise<UiOperationResult>((settle) => {
      resolveRefresh = settle;
    });

    renderBoard(board, {
      "kanbaner.tasks.column.list": () => {
        listCalls += 1;

        return listCalls === 1
          ? ok({ items: board.columns, total: board.columns.length, nextOffset: null })
          : delayedRefresh;
      },
      "kanbaner.tasks.column.move": () =>
        ok({
          column: board.columns[0] as TaskColumn,
          resource: {},
          eventId: "event",
        }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-move-right-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-move-right-todo")).toBeDisabled();
    });
    expect(screen.queryByTestId("kanban-column-notice")).toBeNull();

    await act(async () => {
      resolveRefresh?.(ok({ items: board.columns, total: board.columns.length, nextOffset: null }));
      await delayedRefresh;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-notice")).toHaveTextContent(
        "Порядок колонок сохранён",
      );
    });
  });

  it("reorder показывает отдельную ошибку refresh и снимает pending", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    let listCalls = 0;

    renderBoard(board, {
      "kanbaner.tasks.column.list": () => {
        listCalls += 1;

        return listCalls === 1
          ? ok({ items: board.columns, total: board.columns.length, nextOffset: null })
          : fail("INTERNAL_ERROR", "Список колонок недоступен");
      },
      "kanbaner.tasks.column.move": () =>
        ok({
          column: board.columns[0] as TaskColumn,
          resource: {},
          eventId: "event",
        }),
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-move-right-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-error")).toHaveTextContent(
        "Порядок сохранён, но список колонок не обновлён",
      );
    });
    expect(screen.getByTestId("kanban-column-move-right-todo")).toBeEnabled();
    expect(screen.queryByTestId("kanban-column-notice")).toBeNull();
  });

  it("delete при конфликте обновляет версию и target до повторного confirm", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A")],
      nextColumn: 1,
    };
    let deleteCalls = 0;
    const payloads: Array<Record<string, unknown>> = [];

    renderBoard(board, {
      "kanbaner.tasks.column.delete": (input) => {
        deleteCalls += 1;
        const values = inputOf(input);

        payloads.push(values);

        if (deleteCalls === 1) {
          board.columns[0] = { ...(board.columns[0] as TaskColumn), version: 2 };
          board.columns[1] = makeColumn("column-project-1-next", "Next", "in_progress", 1);

          return fail("VERSION_CONFLICT");
        }

        board.columns.splice(
          0,
          board.columns.length,
          ...board.columns.filter((column) => column.id !== todo.id),
        );

        return ok({
          deleted: true,
          resource: {},
          version: 2,
          eventVersion: 3,
          targetColumnId: String(values.targetColumnId),
          movedTasks: [],
          eventId: "event",
        });
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("1");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("1");
    });
    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-error")).toHaveTextContent(
        "Версия обновлена",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-target")).toHaveValue(
        "column-project-1-next",
      );
    });

    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));

    await waitFor(() => {
      expect(deleteCalls).toBe(2);
    });
    expect(payloads[1]).toMatchObject({
      id: "column-project-1-todo",
      expectedVersion: 2,
      targetColumnId: "column-project-1-next",
    });
  });

  it("failed command + failed refresh восстанавливает snapshot порядка", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    let listCalls = 0;
    const baseline = defaultColumns().map((column) => column.id);

    renderBoard(board, {
      "kanbaner.tasks.column.list": () => {
        listCalls += 1;

        return listCalls === 1
          ? ok({ items: board.columns, total: board.columns.length, nextOffset: null })
          : fail("INTERNAL_ERROR", "Список колонок недоступен");
      },
      "kanbaner.tasks.column.move": () => fail("INTERNAL_ERROR", "Основная ошибка move"),
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-move-right-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-error")).toHaveTextContent("Основная ошибка move");
    });
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-kanban-column-id]")].map((element) =>
        element.getAttribute("data-kanban-column-id"),
      ),
    ).toEqual(baseline);
    expect(screen.getByTestId("kanban-column-move-right-todo")).toBeEnabled();
  });

  it("conflict + failed refresh откатывает порядок и скрывает недоверенную доску", async () => {
    const board: Board = { columns: defaultColumns(), tasks: [], nextColumn: 1 };
    let listCalls = 0;

    renderBoard(board, {
      "kanbaner.tasks.column.list": () => {
        listCalls += 1;

        return listCalls === 1
          ? ok({ items: board.columns, total: board.columns.length, nextOffset: null })
          : fail("INTERNAL_ERROR", "Список колонок недоступен");
      },
      "kanbaner.tasks.column.move": () => fail("VERSION_CONFLICT"),
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-title-todo")).toHaveTextContent("ToDo");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-move-right-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-loading")).toBeVisible();
    });
    expect(document.querySelectorAll("[data-kanban-column-id]")).toHaveLength(0);
    expect(screen.getByTestId("kanban-error")).toHaveTextContent("Доска скрыта");
  });

  it("delete перепроверяет счётчик и требует повторного confirm при изменении", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A")],
      nextColumn: 1,
    };
    let countCalls = 0;
    let deleteCalls = 0;

    renderBoard(board, {
      "kanbaner.tasks.task.list": (input) => {
        const values = inputOf(input);

        if (
          values.limit === 1 &&
          values.offset === 0 &&
          values.tag === undefined &&
          typeof values.columnId === "string" &&
          values.parentTaskId === undefined
        ) {
          countCalls += 1;

          return ok({
            items: [],
            total: countCalls === 1 ? 1 : 2,
            nextOffset: null,
          });
        }

        const columnId = typeof values.columnId === "string" ? values.columnId : null;
        const items = board.tasks.filter((task) => task.columnId === columnId);

        return ok({ items, total: items.length, nextOffset: null });
      },
      "kanbaner.tasks.column.delete": () => {
        deleteCalls += 1;

        return ok({
          deleted: true,
          resource: {},
          version: 1,
          eventVersion: 2,
          targetColumnId: "column-project-1-in-progress",
          movedTasks: [],
          eventId: "event",
        });
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("1");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("1");
    });
    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-error")).toHaveTextContent(
        "Последствия изменились",
      );
    });
    expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("2");
    expect(screen.getByTestId("kanban-column-delete-confirm")).toBeEnabled();
    expect(deleteCalls).toBe(0);

    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));

    await waitFor(() => {
      expect(deleteCalls).toBe(1);
    });
  });

  it("не отправляет task.move после deferred scope, если проект переключился", async () => {
    const columnsA = defaultColumns().map((column) =>
      makeColumn(
        column.id.replace("project-1", "project-a"),
        column.title,
        column.status,
        column.position,
        1,
        "project-a",
      ),
    );
    const columnsB = defaultColumns().map((column) =>
      makeColumn(
        column.id.replace("project-1", "project-b"),
        column.title,
        column.status,
        column.position,
        1,
        "project-b",
      ),
    );
    const taskA = makeTask("task-a", columnsA[0] as TaskColumn, 0, "Задача A");
    let moveCalls = 0;
    let resolveScope: ((value: UiOperationResult) => void) | null = null;
    const delayedScope = new Promise<UiOperationResult>((settle) => {
      resolveScope = settle;
    });
    const projects = [
      { ...project, id: "project-a", title: "Проект A" },
      { ...project, id: "project-b", title: "Проект B" },
    ];

    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok({ items: projects, total: 2, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.column.list") {
        const projectId = String(inputOf(input).projectId);
        const columns = projectId === "project-a" ? columnsA : columnsB;

        return ok({ items: columns, total: columns.length, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.task.list") {
        const values = inputOf(input);
        const projectId = String(values.projectId);
        const columnId = typeof values.columnId === "string" ? values.columnId : null;

        if (values.limit === 200 && projectId === "project-a") {
          return delayedScope;
        }

        const items = projectId === "project-a" && columnId === columnsA[0]?.id ? [taskA] : [];

        return ok({ items, total: items.length, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.task.move") {
        moveCalls += 1;
      }

      return emptyResult();
    };

    window.history.replaceState(null, "", "/view/kanban?project=project-a");
    resetKanbanQueryForTests("?project=project-a");
    render(<KanbanView invoke={invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-task-a")).toBeVisible();
    });

    fireEvent.click(screen.getByTestId("kanban-menu-task-a"));

    fireEvent.click(screen.getByRole("menuitem", { name: "Переместить в In Progress" }));

    act(() => {
      updateKanbanQuery({ projectId: "project-b" });
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-kanban-column-id="column-project-b-todo"]'),
      ).not.toBeNull();
    });

    await act(async () => {
      resolveScope?.(
        ok({
          items: [taskA],
          total: 1,
          nextOffset: null,
        }),
      );
      await delayedScope;
    });

    await waitFor(() => {
      expect(moveCalls).toBe(0);
    });
    expect(
      document.querySelector('[data-kanban-column-id="column-project-b-todo"]'),
    ).not.toBeNull();
  });

  it("unmount снимает pointer listeners активного drag", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A")],
      nextColumn: 1,
    };
    const operations = createOperations(board);
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const view = render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-a")).toBeVisible();
    });

    fireEvent.pointerDown(screen.getByTestId("kanban-open-a"), {
      clientX: 10,
      clientY: 10,
    });
    view.unmount();

    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));

    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window);

    expect(operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.move")).toBe(
      false,
    );
    removeSpy.mockRestore();
  });

  it("unmount отменяет deferred task.move после чтения scope", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A")],
      nextColumn: 1,
    };
    let resolveScope: ((value: UiOperationResult) => void) | null = null;
    const delayedScope = new Promise<UiOperationResult>((settle) => {
      resolveScope = settle;
    });
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        const values = inputOf(input);

        if (values.limit === 200) {
          return delayedScope;
        }

        const columnId = typeof values.columnId === "string" ? values.columnId : null;
        const items = board.tasks.filter((task) => task.columnId === columnId);

        return ok({ items, total: items.length, nextOffset: null });
      },
    });
    const view = render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-a")).toBeVisible();
    });

    fireEvent.click(screen.getByTestId("kanban-menu-a"));

    fireEvent.click(screen.getByRole("menuitem", { name: "Переместить в In Progress" }));
    view.unmount();

    await act(async () => {
      resolveScope?.(ok({ items: [board.tasks[0] as Task], total: 1, nextOffset: null }));
      await delayedScope;
    });

    expect(operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.move")).toBe(
      false,
    );
  });

  it("unmount отменяет deferred column.delete после revalidation", async () => {
    const columns = defaultColumns();
    const todo = columns[0] as TaskColumn;
    const board: Board = {
      columns,
      tasks: [makeTask("a", todo, 0, "A")],
      nextColumn: 1,
    };
    let countCalls = 0;
    let resolveRevalidate: ((value: UiOperationResult) => void) | null = null;
    const delayedRevalidate = new Promise<UiOperationResult>((settle) => {
      resolveRevalidate = settle;
    });
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        const values = inputOf(input);

        if (
          values.limit === 1 &&
          values.offset === 0 &&
          values.tag === undefined &&
          typeof values.columnId === "string" &&
          values.parentTaskId === undefined
        ) {
          countCalls += 1;

          return countCalls === 1
            ? ok({ items: [], total: 1, nextOffset: null })
            : delayedRevalidate;
        }

        const columnId = typeof values.columnId === "string" ? values.columnId : null;
        const items = board.tasks.filter((task) => task.columnId === columnId);

        return ok({ items, total: items.length, nextOffset: null });
      },
    });
    const view = render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-todo")).toHaveTextContent("1");
    });
    await openMenu("column-project-1-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("1");
    });
    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));
    view.unmount();

    await act(async () => {
      resolveRevalidate?.(ok({ items: [], total: 1, nextOffset: null }));
      await delayedRevalidate;
    });

    expect(
      operations.calls.some((call) => call.operationId === "kanbaner.tasks.column.delete"),
    ).toBe(false);
  });

  it("не отправляет column.delete после deferred revalidation, если проект переключился", async () => {
    const columnsA = defaultColumns().map((column) =>
      makeColumn(
        column.id.replace("project-1", "project-a"),
        column.title,
        column.status,
        column.position,
        1,
        "project-a",
      ),
    );
    const columnsB = defaultColumns().map((column) =>
      makeColumn(
        column.id.replace("project-1", "project-b"),
        column.title,
        column.status,
        column.position,
        1,
        "project-b",
      ),
    );
    const taskA = makeTask("task-a", columnsA[0] as TaskColumn, 0, "Задача A");
    let countCalls = 0;
    let deleteCalls = 0;
    let resolveRevalidate: ((value: UiOperationResult) => void) | null = null;
    const delayedRevalidate = new Promise<UiOperationResult>((settle) => {
      resolveRevalidate = settle;
    });
    const projects = [
      { ...project, id: "project-a", title: "Проект A" },
      { ...project, id: "project-b", title: "Проект B" },
    ];

    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok({ items: projects, total: 2, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.column.list") {
        const projectId = String(inputOf(input).projectId);
        const columns = projectId === "project-a" ? columnsA : columnsB;

        return ok({ items: columns, total: columns.length, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.task.list") {
        const values = inputOf(input);

        if (
          values.limit === 1 &&
          values.offset === 0 &&
          values.tag === undefined &&
          typeof values.columnId === "string" &&
          values.parentTaskId === undefined
        ) {
          countCalls += 1;

          return countCalls === 1
            ? ok({ items: [], total: 1, nextOffset: null })
            : delayedRevalidate;
        }

        const columnId = typeof values.columnId === "string" ? values.columnId : null;
        const items =
          String(values.projectId) === "project-a" && columnId === columnsA[0]?.id ? [taskA] : [];

        return ok({ items, total: items.length, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.column.delete") {
        deleteCalls += 1;
      }

      return emptyResult();
    };

    window.history.replaceState(null, "", "/view/kanban?project=project-a");
    resetKanbanQueryForTests("?project=project-a");
    render(<KanbanView invoke={invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-task-a")).toBeVisible();
    });
    await openMenu("column-project-a-todo", "todo");
    fireEvent.click(screen.getByTestId("kanban-column-delete-todo"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-delete-moved-count")).toHaveTextContent("1");
    });
    fireEvent.click(screen.getByTestId("kanban-column-delete-confirm"));

    act(() => {
      updateKanbanQuery({ projectId: "project-b" });
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-kanban-column-id="column-project-b-todo"]'),
      ).not.toBeNull();
    });

    await act(async () => {
      resolveRevalidate?.(ok({ items: [], total: 1, nextOffset: null }));
      await delayedRevalidate;
    });

    await waitFor(() => {
      expect(deleteCalls).toBe(0);
    });
    expect(
      document.querySelector('[data-kanban-column-id="column-project-b-todo"]'),
    ).not.toBeNull();
  });
});
