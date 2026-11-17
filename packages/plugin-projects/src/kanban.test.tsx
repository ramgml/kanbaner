import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_COMMAND_IDS,
  matchesTaskText,
  type Project,
  type Task,
  type TaskColumn,
  type TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import { TaskOverlay } from "./ui/task-overlay.tsx";
import {
  bumpKanbanRevision,
  resetKanbanQueryForTests,
  updateKanbanQuery,
} from "./ui/query-state.ts";

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
  columns?: TaskColumn[];
}

const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: "Бэклог",
  todo: "К выполнению",
  in_progress: "В работе",
  done: "Готово",
};

function columnIdFor(projectId: string, status: TaskStatus): string {
  return `column-${projectId}-legacy-${status}`;
}

function columnStatus(board: FakeBoard, projectId: string, columnId: string): TaskStatus {
  const column = boardColumns(board, projectId).find((entry) => entry.id === columnId);

  if (column === undefined) {
    throw new Error(`Неизвестная колонка ${projectId}/${columnId}`);
  }

  return column.status;
}

function boardColumns(board: FakeBoard, projectId: string): readonly TaskColumn[] {
  const own = board.columns?.filter((column) => column.projectId === projectId) ?? [];

  if (own.length > 0) {
    return own;
  }

  const statuses: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "done"];

  return statuses.map((status, position) => ({
    id: columnIdFor(projectId, status),
    projectId,
    title: STATUS_LABELS[status],
    status,
    position,
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  }));
}

function statusOfTask(board: FakeBoard, task: Task): TaskStatus {
  const columns = boardColumns(board, task.projectId);
  const column =
    task.columnId === undefined
      ? columns.find((entry) => entry.status === task.status)
      : columns.find((entry) => entry.id === task.columnId);

  if (column === undefined) {
    throw new Error(`Задача ${task.id} ссылается на неизвестную колонку`);
  }

  return column.status;
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return {
    promise,
    resolve: (value) => {
      resolve?.(value);
    },
  };
}

function statusOf(board: FakeBoard, input: JsonValue): string | null {
  const values = inputOf(input);

  if (typeof values.columnId === "string") {
    return columnStatus(board, String(values.projectId), values.columnId);
  }

  const value = values.status;

  return typeof value === "string" ? value : null;
}

function offsetOf(input: JsonValue): number {
  const value = inputOf(input).offset;

  return typeof value === "number" ? value : 0;
}

function compareTasks(left: Task, right: Task): number {
  return left.position === right.position
    ? left.id.localeCompare(right.id)
    : left.position - right.position;
}

function listTasks(board: FakeBoard, input: JsonValue): UiOperationResult {
  const filters = inputOf(input);
  let items = [...board.tasks];

  if (typeof filters.columnId === "string") {
    const columnId = filters.columnId;

    items = items.filter(
      (task) =>
        (task.columnId ?? columnIdFor(task.projectId, statusOfTask(board, task))) === columnId,
    );
  }

  if (typeof filters.projectId === "string") {
    items = items.filter((task) => task.projectId === filters.projectId);
  }

  if (typeof filters.tag === "string") {
    items = items.filter((task) => task.tags.includes(filters.tag as string));
  }

  if (typeof filters.text === "string") {
    items = items.filter((task) => matchesTaskText(task, filters.text as string));
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

  const columnId =
    typeof values.columnId === "string"
      ? values.columnId
      : columnIdFor(task.projectId, values.status as TaskStatus);
  const status = columnStatus(board, task.projectId, columnId);
  const position = Number(values.position);
  const projectTasks = board.tasks.filter((candidate) => candidate.projectId === task.projectId);
  const target = projectTasks
    .filter(
      (candidate) =>
        (candidate.columnId ?? columnIdFor(candidate.projectId, statusOfTask(board, candidate))) ===
          columnId && candidate.id !== id,
    )
    .sort(compareTasks);
  const source = projectTasks
    .filter(
      (candidate) =>
        (candidate.columnId ?? columnIdFor(candidate.projectId, statusOfTask(board, candidate))) ===
          (task.columnId ?? columnIdFor(task.projectId, task.status)) && candidate.id !== id,
    )
    .sort(compareTasks);

  target.splice(Math.min(position, target.length), 0, task);

  const updated = new Map<string, Task>();

  target.forEach((candidate, index) => {
    const next = {
      ...candidate,
      columnId,
      status,
      position: index,
      version: candidate.id === id ? candidate.version + 1 : candidate.version,
      completedAt: status === "done" ? (candidate.completedAt ?? TIMESTAMP) : null,
      updatedAt: TIMESTAMP,
    } as Task;

    if (columnStatus(board, next.projectId, columnId) !== next.status) {
      throw new Error(`Нарушено зеркало status/columnId для ${next.id}`);
    }

    updated.set(candidate.id, next);
  });

  if (statusOfTask(board, task) !== status) {
    source.forEach((candidate, index) => {
      updated.set(candidate.id, { ...candidate, position: index } as Task);
    });
  }

  board.tasks = board.tasks.map((candidate) => updated.get(candidate.id) ?? candidate);

  return { ok: true, task: updated.get(id) ?? task };
}

/**
 * Массовый перенос для тестов: сначала валидируется весь вход, затем задачи
 * дописываются в target в порядке `items`.
 */
function applyBulkMove(board: FakeBoard, input: JsonValue): UiOperationResult {
  const values = inputOf(input);
  const columnId = String(values.columnId);
  const rawItems = Array.isArray(values.items) ? values.items : [];
  const entries = rawItems.map((item) => {
    const entry = inputOf(item as JsonValue);

    return { id: String(entry.id), expectedVersion: Number(entry.expectedVersion) };
  });
  const ids = new Set(entries.map((entry) => entry.id));

  if (entries.length === 0 || ids.size !== entries.length) {
    return fail("VALIDATION");
  }

  const tasks = entries.map((entry) => getTask(board, entry.id));
  const projectIds = new Set(tasks.map((task) => task?.projectId));

  if (tasks.some((task) => task === undefined) || projectIds.size !== 1) {
    return fail("NOT_FOUND");
  }

  const projectId = tasks[0]?.projectId ?? "";

  if (!boardColumns(board, projectId).some((column) => column.id === columnId)) {
    return fail("VALIDATION");
  }

  for (const [index, entry] of entries.entries()) {
    if (tasks[index]?.version !== entry.expectedVersion) {
      return fail("VERSION_CONFLICT");
    }
  }

  const moved: Task[] = [];

  for (const entry of entries) {
    const task = getTask(board, entry.id);

    if (task === undefined) {
      return fail("NOT_FOUND");
    }

    const targetSize = board.tasks.filter(
      (candidate) =>
        candidate.projectId === task.projectId &&
        (candidate.columnId ?? columnIdFor(candidate.projectId, statusOfTask(board, candidate))) ===
          columnId &&
        candidate.id !== entry.id,
    ).length;
    const result = applyMove(board, {
      id: entry.id,
      expectedVersion: entry.expectedVersion,
      columnId,
      position: targetSize,
    } as unknown as JsonValue);

    if (!result.ok) {
      return fail(result.code);
    }

    moved.push(result.task);
  }

  return ok({ tasks: moved });
}

/** Массовое удаление: выбранные задачи и их потомки без повторной обработки. */
function applyBulkDelete(board: FakeBoard, input: JsonValue): UiOperationResult {
  const values = inputOf(input);

  if (values.confirm !== true) {
    return fail("VALIDATION");
  }

  const rawItems = Array.isArray(values.items) ? values.items : [];
  const entries = rawItems.map((item) => inputOf(item as JsonValue));
  const ids = new Set(entries.map((entry) => String(entry.id)));

  if (entries.length === 0 || ids.size !== entries.length) {
    return fail("VALIDATION");
  }

  for (const entry of entries) {
    const task = getTask(board, String(entry.id));

    if (task === undefined) {
      return fail("NOT_FOUND");
    }

    if (task.version !== Number(entry.expectedVersion)) {
      return fail("VERSION_CONFLICT");
    }
  }

  const toDelete = new Set(ids);
  let grew = true;

  while (grew) {
    grew = false;

    for (const task of board.tasks) {
      if (task.parentTaskId !== null && toDelete.has(task.parentTaskId) && !toDelete.has(task.id)) {
        toDelete.add(task.id);
        grew = true;
      }
    }
  }

  board.tasks = board.tasks.filter((task) => !toDelete.has(task.id));

  return ok({ deleted: toDelete.size });
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
    "kanbaner.tasks.column.list": (input) => {
      const projectId = String(inputOf(input).projectId);
      const columns = boardColumns(board, projectId);

      return ok({ items: [...columns], total: columns.length, nextOffset: null });
    },
    "kanbaner.tasks.task.get": (input) => {
      const found = getTask(board, String(inputOf(input).id));

      return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
    },
    "kanbaner.tasks.task.move": (input) => {
      const result = applyMove(board, input);

      return result.ok ? ok({ task: result.task }) : fail(result.code);
    },
    [TASKS_COMMAND_IDS.taskMoveMany]: (input) => applyBulkMove(board, input),
    [TASKS_COMMAND_IDS.taskDeleteMany]: (input) => applyBulkDelete(board, input),
    "kanbaner.tasks.task.delete": (input) => {
      const id = String(inputOf(input).id);

      board.tasks = board.tasks.filter((task) => task.id !== id);

      return ok(null);
    },
    "kanbaner.tasks.task.complete": (input) => {
      const task = getTask(board, String(inputOf(input).id));

      if (task === undefined) {
        return fail("NOT_FOUND");
      }

      board.tasks = board.tasks.map((candidate) =>
        candidate.id === task.id
          ? (() => {
              const columnId = columnIdFor(candidate.projectId, "done");

              return {
                ...candidate,
                columnId,
                status: columnStatus(board, candidate.projectId, columnId),
                completedAt: TIMESTAMP,
                version: candidate.version + 1,
              } as Task;
            })()
          : candidate,
      );

      return ok({ task: getTask(board, task.id) ?? task });
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

function openCardMenu(taskId: string): HTMLElement {
  if (screen.queryByTestId(`kanban-card-menu-${taskId}`) === null) {
    fireEvent.click(screen.getByTestId(`kanban-menu-${taskId}`));
  }

  return screen.getByTestId(`kanban-card-menu-${taskId}`);
}

function clickCardAction(taskId: string, name: string): void {
  const menu = openCardMenu(taskId);

  fireEvent.click(within(menu).getByRole("menuitem", { name }));
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
    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtasks-child")).toHaveTextContent("Подзадачи: 0");
    });
    expect(cardTitles("todo")).toEqual(["Задача todo-task"]);
  });

  it("ищет по названию и описанию, скрывает неподходящие карточки и очищает q", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("release", { title: "Релизная задача", status: "todo", position: 0 }),
        makeTask("backend", { title: "Бэкенд задача", status: "todo", position: 1 }),
        makeTask("docs", {
          title: "Документация",
          descriptionMarkdown: "Инструкция по релизу",
          status: "in_progress",
          position: 0,
        }),
      ],
    };
    const operations = createOperations(board);

    window.history.replaceState(
      null,
      "",
      "/view/kanban?project=project-1&q=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7",
    );
    resetKanbanQueryForTests("?project=project-1&q=релиз");

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-release");
    await screen.findByTestId("kanban-card-docs");
    expect(screen.queryByTestId("kanban-card-backend")).toBeNull();

    const columnCalls = operations.calls.filter((call) => {
      const input = inputOf(call.input);

      return call.operationId === "kanbaner.tasks.task.list" && !("parentTaskId" in input);
    });

    expect(columnCalls.length).toBeGreaterThan(0);
    expect(columnCalls.every((call) => inputOf(call.input).text === "релиз")).toBe(true);

    const search = screen.getByRole("searchbox", { name: "Поиск задач" });

    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "бэкенд" } });

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("q")).toBe("бэкенд");
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-backend")).toBeVisible();
    });
    expect(screen.queryByTestId("kanban-card-release")).toBeNull();
    expect(screen.queryByTestId("kanban-card-docs")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("q")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-release")).toBeVisible();
      expect(screen.getByTestId("kanban-card-docs")).toBeVisible();
      expect(screen.getByTestId("kanban-card-backend")).toBeVisible();
    });
    expect(screen.getByRole("searchbox", { name: "Поиск задач" })).toHaveValue("");
  });

  it("сочетает поиск с тегом и очищает оба фильтра", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("release-a", {
          title: "Релиз A",
          status: "todo",
          position: 0,
          tags: ["release"],
        }),
        makeTask("release-b", {
          title: "Релиз B",
          status: "todo",
          position: 1,
          tags: ["backend"],
        }),
        makeTask("other", { title: "Другое", status: "todo", position: 2, tags: ["release"] }),
      ],
    };
    const operations = createOperations(board);

    window.history.replaceState(
      null,
      "",
      "/view/kanban?project=project-1&q=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7",
    );
    resetKanbanQueryForTests("?project=project-1&q=релиз");

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-release-a");
    expect(screen.getByTestId("kanban-card-release-b")).toBeVisible();
    expect(screen.queryByTestId("kanban-card-other")).toBeNull();

    fireEvent.focus(screen.getByRole("searchbox", { name: "Тег" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Тег" }), {
      target: { value: "release" },
    });

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("tag")).toBe("release");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("kanban-card-release-b")).toBeNull();
    });
    expect(screen.getByTestId("kanban-card-release-a")).toBeVisible();
    expect(screen.queryByTestId("kanban-card-other")).toBeNull();

    await waitFor(() => {
      const last = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.list")
        .filter((call) => !("parentTaskId" in inputOf(call.input)))
        .at(-1);

      expect(inputOf(last?.input ?? {})).toMatchObject({ tag: "release", text: "релиз" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("tag")).toBeNull();
      expect(new URLSearchParams(window.location.search).get("q")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-release-b")).toBeVisible();
      expect(screen.getByTestId("kanban-card-other")).toBeVisible();
    });
  });

  it("переставляет filtered-карточку по полному scope, не теряя скрытого поиском соседа", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Релиз A", status: "todo", position: 0 }),
        makeTask("b", { title: "Скрытая B", status: "todo", position: 1 }),
        makeTask("c", { title: "Релиз C", status: "todo", position: 2 }),
      ],
    };
    const operations = createOperations(board);

    window.history.replaceState(
      null,
      "",
      "/view/kanban?project=project-1&q=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7",
    );
    resetKanbanQueryForTests("?project=project-1&q=релиз");

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-a");
    await screen.findByTestId("kanban-card-c");
    expect(screen.queryByTestId("kanban-card-b")).toBeNull();
    expect(cardTitles("todo")).toEqual(["Релиз A", "Релиз C"]);

    clickCardAction("a", "В конец");

    await waitFor(() => {
      const lastMove = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.move")
        .at(-1);

      expect(inputOf(lastMove?.input ?? {})).toMatchObject({
        id: "a",
        expectedVersion: 1,
        position: 2,
      });
    });

    const scopeCall = operations.calls.find((call) => {
      const input = inputOf(call.input);

      return (
        call.operationId === "kanbaner.tasks.task.list" &&
        input.limit === 200 &&
        !("parentTaskId" in input)
      );
    });

    // Полный scope для position считается без поиска: скрытый сосед учтён.
    expect(inputOf(scopeCall?.input ?? {})).toMatchObject({
      columnId: "column-project-1-legacy-todo",
    });
    expect(inputOf(scopeCall?.input ?? {})).not.toHaveProperty("text");

    await waitFor(() => {
      expect(cardTitles("todo")).toEqual(["Релиз C", "Релиз A"]);
    });
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

    clickCardAction("a", "Ниже");

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

    clickCardAction("c", "Переместить в Готово");

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
    clickCardAction("a", "Переместить в Готово");

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
    clickCardAction("a", "Переместить в Готово");

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
        call.operationId === "kanbaner.tasks.task.list" &&
        inputOf(call.input).columnId === "column-project-1-legacy-backlog",
    );

    expect(pageCalls.some((call) => inputOf(call.input).offset === 10)).toBe(true);
  });

  it("переупорядочивает по полному scope, не теряя скрытого фильтром соседа", async () => {
    window.history.replaceState(null, "", "/view/kanban?project=project-1&tag=show");
    resetKanbanQueryForTests("?project=project-1&tag=show");
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("visible-a", { title: "A", status: "todo", position: 0, tags: ["show"] }),
        makeTask("hidden", { title: "Скрытая", status: "todo", position: 1, tags: ["other"] }),
        makeTask("visible-c", { title: "C", status: "todo", position: 2, tags: ["show"] }),
      ],
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-visible-a");
    expect(cardTitles("todo")).toEqual(["A", "C"]);

    // Видимый список [A, C] дал бы position 1, полный [A, скрытая, C] — 2.
    clickCardAction("visible-a", "В конец");

    await waitFor(() => {
      const lastMove = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.move")
        .at(-1);

      expect(inputOf(lastMove?.input ?? {})).toMatchObject({
        id: "visible-a",
        status: "todo",
        position: 2,
      });
    });

    await waitFor(() => {
      expect(cardTitles("todo")).toEqual(["C", "A"]);
    });
    expect(board.tasks.find((task) => task.id === "hidden")?.position).toBe(0);
  });

  it.each([
    {
      action: "Ниже",
      taskId: "visible-a",
      expectedPosition: 4,
      expectedFull: ["hidden-before", "hidden-middle", "visible-c", "hidden-after", "visible-a"],
    },
    {
      action: "Выше",
      taskId: "visible-c",
      expectedPosition: 1,
      expectedFull: ["hidden-before", "visible-c", "visible-a", "hidden-middle", "hidden-after"],
    },
  ])(
    "«$action» в filtered-колонке относится к видимому порядку при скрытых соседях с обеих сторон",
    async ({ action, taskId, expectedPosition, expectedFull }) => {
      window.history.replaceState(null, "", "/view/kanban?project=project-1&tag=show");
      resetKanbanQueryForTests("?project=project-1&tag=show");
      const board: FakeBoard = {
        projects: [project],
        tasks: [
          makeTask("hidden-before", {
            title: "H1",
            status: "todo",
            position: 0,
            tags: ["other"],
          }),
          makeTask("visible-a", { title: "A", status: "todo", position: 1, tags: ["show"] }),
          makeTask("hidden-middle", {
            title: "H2",
            status: "todo",
            position: 2,
            tags: ["other"],
          }),
          makeTask("visible-c", { title: "C", status: "todo", position: 3, tags: ["show"] }),
          makeTask("hidden-after", {
            title: "H3",
            status: "todo",
            position: 4,
            tags: ["other"],
          }),
        ],
      };
      const operations = createOperations(board);

      render(<KanbanView invoke={operations.invoke} />);

      await screen.findByTestId("kanban-card-visible-a");
      expect(cardTitles("todo")).toEqual(["A", "C"]);

      clickCardAction(taskId, action);

      await waitFor(() => {
        const lastMove = operations.calls
          .filter((call) => call.operationId === "kanbaner.tasks.task.move")
          .at(-1);

        expect(inputOf(lastMove?.input ?? {})).toMatchObject({
          id: taskId,
          status: "todo",
          position: expectedPosition,
        });
      });
      await waitFor(() => {
        expect(cardTitles("todo")).toEqual(["C", "A"]);
      });

      const fullOrder = board.tasks
        .filter((candidate) => candidate.status === "todo")
        .sort(compareTasks)
        .map((candidate) => candidate.id);

      expect(fullOrder).toEqual(expectedFull);
    },
  );

  it.each([10, 12])(
    "догружает target колонку после перемещения при %i существующих задачах",
    async (existingCount) => {
      const board: FakeBoard = {
        projects: [project],
        tasks: [
          ...Array.from({ length: existingCount }, (_, index) =>
            makeTask(`done-${String(index)}`, {
              title: `Готовая ${String(index)}`,
              status: "done",
              position: index,
            }),
          ),
          makeTask("mover", { title: "Mover", status: "todo" }),
        ],
      };
      const operations = createOperations(board);

      render(<KanbanView invoke={operations.invoke} />);

      await screen.findByTestId("kanban-card-mover");
      clickCardAction("mover", "Переместить в Готово");

      await waitFor(() => {
        expect(screen.getByTestId("kanban-count-done")).toHaveTextContent(
          String(existingCount + 1),
        );
      });
      await waitFor(() => {
        expect(
          within(screen.getByTestId("kanban-column-done")).getByTestId("kanban-card-mover"),
        ).toBeTruthy();
      });
      await waitFor(() => {
        const lastMove = operations.calls
          .filter((call) => call.operationId === "kanbaner.tasks.task.move")
          .at(-1);

        expect(inputOf(lastMove?.input ?? {})).toMatchObject({
          id: "mover",
          status: "done",
          position: existingCount,
        });
      });

      const moveIndex = operations.calls.findIndex(
        (call) => call.operationId === "kanbaner.tasks.task.move",
      );
      const pagesAfterMove = operations.calls
        .slice(moveIndex + 1)
        .filter(
          (call) =>
            call.operationId === "kanbaner.tasks.task.list" &&
            statusOf(board, call.input) === "done" &&
            offsetOf(call.input) > 0,
        );

      expect(pagesAfterMove.length).toBeGreaterThan(0);
    },
  );

  it("сохраняет обе карточки при одновременных append за границей страницы", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        ...Array.from({ length: 12 }, (_, index) =>
          makeTask(`done-${String(index).padStart(2, "0")}`, {
            title: `Готовая ${String(index)}`,
            status: "done",
            position: index,
          }),
        ),
        makeTask("mover-a", { title: "A", status: "todo" }),
        makeTask("mover-b", { title: "B", status: "todo" }),
      ],
    };
    let deferDoneReload = false;
    const pendingLists: Array<{
      readonly input: JsonValue;
      readonly gate: Deferred<UiOperationResult>;
    }> = [];
    const operations = createOperations(board, {
      "kanbaner.tasks.task.move": (input) => {
        const result = applyMove(board, input);

        // Reload после move придерживаем, чтобы второй move начался, пока
        // первый ещё не применил результаты.
        deferDoneReload = true;

        return result.ok ? ok({ task: result.task }) : fail(result.code);
      },
      "kanbaner.tasks.task.list": (input) => {
        const limit = inputOf(input).limit;

        // Полный scope (limit 200) не придерживаем: второй move должен
        // увидеть уже применённую первую команду.
        if (statusOf(board, input) === "done" && deferDoneReload && limit !== 200) {
          const gate = deferred<UiOperationResult>();

          pendingLists.push({ input, gate });

          return gate.promise;
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-mover-a");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-done")).toHaveTextContent("12");
    });

    clickCardAction("mover-a", "Переместить в Готово");

    await waitFor(() => {
      const move = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.move")
        .at(0);

      expect(inputOf(move?.input ?? {})).toMatchObject({
        id: "mover-a",
        status: "done",
        position: 12,
      });
    });

    clickCardAction("mover-b", "Переместить в Готово");

    await waitFor(() => {
      const move = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.move")
        .at(1);

      expect(inputOf(move?.input ?? {})).toMatchObject({
        id: "mover-b",
        status: "done",
        position: 13,
      });
    });

    // Обе reload-цепочки получают пагинацию за границей первой страницы.
    // Дожидаемся и первых страниц, и следующих запросов, которые появляются
    // после разрешения предыдущих.
    await act(async () => {
      let idleRounds = 0;

      for (let round = 0; round < 30 && idleRounds < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (pendingLists.length === 0) {
          idleRounds += 1;

          continue;
        }

        idleRounds = 0;

        const batch = pendingLists.splice(0, pendingLists.length);

        for (const entry of batch) {
          entry.gate.resolve(listTasks(board, entry.input));
        }

        await Promise.all(batch.map((entry) => entry.gate.promise));
      }
    });

    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-done")).getByTestId("kanban-card-mover-a"),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("kanban-column-done")).getByTestId("kanban-card-mover-b"),
      ).toBeTruthy();
    });
    expect(cardTitles("done")).toHaveLength(14);
    expect(board.tasks.find((task) => task.id === "mover-a")?.position).toBe(12);
    expect(board.tasks.find((task) => task.id === "mover-b")?.position).toBe(13);
    expect(screen.queryByTestId("kanban-pending-mover-a")).toBeNull();
    expect(screen.queryByTestId("kanban-pending-mover-b")).toBeNull();
  });

  it("ставит карточку в конец после догрузки и не теряет её за границей страницы", async () => {
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
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));
    await waitFor(() => {
      expect(cardTitles("backlog")).toHaveLength(12);
    });

    clickCardAction("p00", "В конец");

    await waitFor(() => {
      expect(cardTitles("backlog").at(-1)).toBe("P00");
    });
    expect(
      within(screen.getByTestId("kanban-column-backlog")).getByTestId("kanban-card-p00"),
    ).toBeTruthy();

    const lastMove = operations.calls
      .filter((call) => call.operationId === "kanbaner.tasks.task.move")
      .at(-1);

    expect(inputOf(lastMove?.input ?? {})).toMatchObject({ id: "p00", position: 11 });
  });

  it("не применяет запоздавший loadMore после смены фильтра", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 12 }, (_, index) =>
        makeTask(`t${String(index).padStart(2, "0")}`, {
          title: `T${String(index).padStart(2, "0")}`,
          status: "backlog",
          position: index,
          tags: [index < 2 ? "keep" : "other"],
        }),
      ),
    };
    const stale = deferred<UiOperationResult>();
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        const values = inputOf(input);

        if (
          statusOf(board, input) === "backlog" &&
          offsetOf(input) === 10 &&
          values.tag === undefined &&
          values.parentTaskId === undefined
        ) {
          return stale.promise;
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("12");
    });
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    act(() => {
      updateKanbanQuery({ tag: "keep" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("2");
    });

    await act(async () => {
      stale.resolve(
        ok({
          items: [makeTask("stale-page", { title: "Stale", status: "backlog", position: 10 })],
          total: 12,
          nextOffset: null,
        }),
      );
      await stale.promise;
    });

    expect(screen.queryByTestId("kanban-card-stale-page")).toBeNull();
    expect(cardTitles("backlog")).toEqual(["T00", "T01"]);
  });

  it("блокирует loadMore до первой страницы filterKey и не применяет stale cursor", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 30 }, (_, index) => {
        const group = index < 15 ? "Match" : "Other";
        const number = String(index % 15).padStart(2, "0");

        return makeTask(`${group.toLowerCase()}-${number}`, {
          title: `${group} ${number}`,
          status: "backlog",
          position: index,
        });
      }),
    };
    const matchFirstPage = deferred<UiOperationResult>();
    const staleMatchPage = deferred<UiOperationResult>();
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        const values = inputOf(input);

        if (values.parentTaskId !== undefined) {
          return listTasks(board, input);
        }

        if (values.text === "Match" && values.offset === 0) {
          return matchFirstPage.promise;
        }

        if (values.text === "Match" && values.offset === 10) {
          return staleMatchPage.promise;
        }

        return listTasks(board, input);
      },
    });
    const matchTasks = board.tasks.filter((task) => task.title.startsWith("Match"));
    const otherTasks = board.tasks.filter((task) => task.title.startsWith("Other"));

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-match-00");
    expect(screen.getByTestId("kanban-load-more-backlog")).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск задач" }), {
      target: { value: "Match" },
    });

    // Первая страница нового filterKey ещё не применена: старый nextOffset
    // не должен открывать loadMore.
    await waitFor(() => {
      expect(screen.queryByTestId("kanban-load-more-backlog")).toBeNull();
    });

    await act(async () => {
      matchFirstPage.resolve(
        ok({
          items: matchTasks.slice(0, 10),
          total: matchTasks.length,
          nextOffset: 10,
        }),
      );
      await matchFirstPage.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("15");
    });
    expect(screen.getByTestId("kanban-load-more-backlog")).toBeVisible();

    // Стартует loadMore со свежим курсором первой страницы и сразу устаревает:
    // фильтр меняется до ответа. Ответ не должен ни дописаться, ни сдвинуть
    // nextOffset новой страницы.
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(
        operations.calls.some((call) => {
          const values = inputOf(call.input);

          return values.text === "Match" && values.offset === 10;
        }),
      ).toBe(true);
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск задач" }), {
      target: { value: "Other" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("15");
      expect(screen.getByTestId("kanban-card-other-00")).toBeVisible();
    });
    expect(cardTitles("backlog")).toEqual(otherTasks.slice(0, 10).map((task) => task.title));

    await act(async () => {
      staleMatchPage.resolve(
        ok({
          items: matchTasks.slice(10, 15),
          total: matchTasks.length,
          nextOffset: null,
        }),
      );
      await staleMatchPage.promise;
    });

    expect(cardTitles("backlog")).toEqual(otherTasks.slice(0, 10).map((task) => task.title));
    expect(screen.getByTestId("kanban-load-more-backlog")).toBeVisible();

    // Следующая страница нового фильтра начинается с его курсора: без
    // пропусков и без повторного использования stale offset.
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(cardTitles("backlog")).toEqual(otherTasks.map((task) => task.title));
    });
    expect(screen.queryByTestId("kanban-load-more-backlog")).toBeNull();
  });

  it("после смены фильтра во время move перечитывает колонку актуальным фильтром", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("visible-a", { title: "A", status: "todo", position: 0, tags: ["show"] }),
        makeTask("hidden", { title: "Скрытая", status: "todo", position: 1, tags: ["other"] }),
        makeTask("visible-c", { title: "C", status: "todo", position: 2, tags: ["show"] }),
      ],
    };
    const moveDeferred = deferred<UiOperationResult>();
    const operations = createOperations(board, {
      "kanbaner.tasks.task.move": (input) => {
        applyMove(board, input);

        return moveDeferred.promise;
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await screen.findByTestId("kanban-card-visible-a");
    expect(screen.getByTestId("kanban-card-hidden")).toBeInTheDocument();

    clickCardAction("visible-a", "Переместить в Готово");

    await waitFor(() => {
      expect(operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.move")).toBe(
        true,
      );
    });

    // Фильтр меняется, пока команда ещё не завершилась. Запоздавший reload
    // после move обязан использовать новый фильтр, а не замыкание клика.
    act(() => {
      updateKanbanQuery({ tag: "show" });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-card-hidden")).toBeNull();
    });

    await act(async () => {
      moveDeferred.resolve(ok({ task: getTask(board, "visible-a") as Task }));
      await moveDeferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-visible-a")).toBeInTheDocument();
    });
    expect(screen.getByTestId("kanban-card-visible-c")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-card-hidden")).toBeNull();
    expect(screen.getByTestId("kanban-count-done")).toHaveTextContent("1");
    expect(
      within(screen.getByTestId("kanban-column-todo")).getByTestId("kanban-card-visible-c"),
    ).toBeTruthy();
  });

  it("не применяет запоздавший loadMore после перемещения карточки", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 12 }, (_, index) =>
        makeTask(`m${String(index).padStart(2, "0")}`, {
          title: `M${String(index).padStart(2, "0")}`,
          status: "backlog",
          position: index,
        }),
      ),
    };
    const stale = deferred<UiOperationResult>();
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        const values = inputOf(input);

        if (
          statusOf(board, input) === "backlog" &&
          offsetOf(input) === 10 &&
          values.parentTaskId === undefined
        ) {
          return stale.promise;
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("12");
    });
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    clickCardAction("m00", "Переместить в Готово");

    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-done")).getByTestId("kanban-card-m00"),
      ).toBeTruthy();
    });

    await act(async () => {
      stale.resolve(
        ok({
          items: [
            makeTask("stale-after-move", { title: "Stale", status: "backlog", position: 10 }),
          ],
          total: 12,
          nextOffset: null,
        }),
      );
      await stale.promise;
    });

    expect(screen.queryByTestId("kanban-card-stale-after-move")).toBeNull();
  });

  it("перечитывает колонку с начала при полностью дублированной странице и не закрывает пагинацию", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 12 }, (_, index) =>
        makeTask(`d${String(index).padStart(2, "0")}`, {
          title: `D${String(index).padStart(2, "0")}`,
          status: "backlog",
          position: index,
        }),
      ),
    };
    let serveDuplicate = true;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        if (statusOf(board, input) === "backlog" && offsetOf(input) === 10 && serveDuplicate) {
          return ok({ items: board.tasks.slice(0, 10), total: 12, nextOffset: 10 });
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("12");
    });
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-load-more-backlog")).not.toBeDisabled();
    });
    expect(cardTitles("backlog")).toHaveLength(10);
    expect(new Set(cardTitles("backlog")).size).toBe(10);
    expect(screen.getByTestId("kanban-load-more-backlog")).toBeInTheDocument();

    serveDuplicate = false;
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(cardTitles("backlog")).toHaveLength(12);
    });
    expect(new Set(cardTitles("backlog")).size).toBe(12);
    expect(screen.queryByTestId("kanban-load-more-backlog")).toBeNull();
  });

  it("не закрывает пагинацию при terminal-дубликате с items.length < total и восстанавливает скрытые задачи", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 12 }, (_, index) =>
        makeTask(`t${String(index).padStart(2, "0")}`, {
          title: `T${String(index).padStart(2, "0")}`,
          status: "backlog",
          position: index,
        }),
      ),
    };
    const terminal = deferred<UiOperationResult>();
    let serveDuplicate = true;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        if (statusOf(board, input) === "backlog" && offsetOf(input) === 10 && serveDuplicate) {
          return terminal.promise;
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("12");
    });
    expect(cardTitles("backlog")).toHaveLength(10);

    const firstPageCallsBefore = operations.calls.filter(
      (call) =>
        call.operationId === "kanbaner.tasks.task.list" &&
        statusOf(board, call.input) === "backlog" &&
        offsetOf(call.input) === 0,
    ).length;

    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await act(async () => {
      // Сервер отдал полностью дублированную страницу и nextOffset=null,
      // хотя total всё ещё больше числа уникально загруженных карточек.
      terminal.resolve(ok({ items: board.tasks.slice(0, 10), total: 12, nextOffset: null }));
      await terminal.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-load-more-backlog")).not.toBeDisabled();
    });
    expect(cardTitles("backlog")).toHaveLength(10);
    expect(new Set(cardTitles("backlog")).size).toBe(10);

    // Пагинация не закрыта, а колонка перечитана с начала.
    const firstPageCallsAfter = operations.calls.filter(
      (call) =>
        call.operationId === "kanbaner.tasks.task.list" &&
        statusOf(board, call.input) === "backlog" &&
        offsetOf(call.input) === 0,
    ).length;

    expect(firstPageCallsAfter).toBeGreaterThan(firstPageCallsBefore);

    serveDuplicate = false;
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(cardTitles("backlog")).toHaveLength(12);
    });
    expect(new Set(cardTitles("backlog")).size).toBe(12);
    expect(screen.queryByTestId("kanban-load-more-backlog")).toBeNull();
  });

  it("убирает stale ID после пустой догрузки при уменьшении total", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 12 }, (_, index) =>
        makeTask(`r${String(index).padStart(2, "0")}`, {
          title: `R${String(index).padStart(2, "0")}`,
          status: "backlog",
          position: index,
        }),
      ),
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        // Другая вкладка удалила задачи, и страница за новым концом пуста.
        if (statusOf(board, input) === "backlog" && offsetOf(input) === 10) {
          return ok({ items: [], total: 10, nextOffset: null });
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("12");
    });
    expect(cardTitles("backlog")).toHaveLength(10);
    expect(cardTitles("backlog")).toContain("R00");
    expect(cardTitles("backlog")).toContain("R01");

    // Из первых десяти удалены две задачи; хвостовые R10/R11 ещё не были
    // загружены. Пустая страница loadMore не должна оставлять stale ID.
    board.tasks = board.tasks.filter((task) => task.id !== "r00" && task.id !== "r01");

    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(cardTitles("backlog")).toHaveLength(10);
    });
    expect(cardTitles("backlog")).not.toContain("R00");
    expect(cardTitles("backlog")).not.toContain("R01");
    expect(cardTitles("backlog")).toContain("R10");
    expect(cardTitles("backlog")).toContain("R11");
    expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("10");
    expect(screen.queryByTestId("kanban-load-more-backlog")).toBeNull();
  });

  it("добавляет только новые карточки из частично дублированной страницы", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: Array.from({ length: 12 }, (_, index) =>
        makeTask(`q${String(index).padStart(2, "0")}`, {
          title: `Q${String(index).padStart(2, "0")}`,
          status: "backlog",
          position: index,
        }),
      ),
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        if (statusOf(board, input) === "backlog" && offsetOf(input) === 10) {
          return ok({
            items: [board.tasks[0] as Task, board.tasks[10] as Task, board.tasks[11] as Task],
            total: 12,
            nextOffset: null,
          });
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("12");
    });
    fireEvent.click(screen.getByTestId("kanban-load-more-backlog"));

    await waitFor(() => {
      expect(cardTitles("backlog")).toHaveLength(12);
    });
    expect(new Set(cardTitles("backlog")).size).toBe(12);
    expect(screen.queryByTestId("kanban-load-more-backlog")).toBeNull();
  });

  it("пишет query через router-writer shell вместо history.replaceState", () => {
    const writer = vi.fn();
    const board: FakeBoard = { projects: [project], tasks: [] };
    const operations = createOperations(board);
    const view = render(<KanbanView invoke={operations.invoke} replaceSearch={writer} search="" />);

    act(() => {
      updateKanbanQuery({ taskId: "a" });
    });

    expect(writer).toHaveBeenCalledWith("?task=a");

    view.unmount();

    act(() => {
      updateKanbanQuery({ taskId: null });
    });

    expect(writer).not.toHaveBeenCalledWith("");
  });

  it("не кэширует ошибку счётчика подзадач как ноль и перезапрашивает по ревизии", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("parent", { title: "Родитель", status: "todo" }),
        makeTask("child", { title: "Ребёнок", status: "todo", parentTaskId: "parent" }),
      ],
    };
    let failCounts = true;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.list": (input) => {
        if (inputOf(input).parentTaskId === "parent") {
          return failCounts
            ? fail("INTERNAL_ERROR", "счётчик недоступен")
            : ok({ items: [board.tasks[1] as Task], total: 1, nextOffset: null });
        }

        return listTasks(board, input);
      },
    });

    render(<KanbanView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtasks-parent")).toHaveTextContent("Подзадачи: —");
    });
    expect(screen.getByTestId("kanban-subtasks-parent")).not.toHaveTextContent("Подзадачи: 0");

    failCounts = false;

    act(() => {
      bumpKanbanRevision();
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtasks-parent")).toHaveTextContent("Подзадачи: 1");
    });
  });

  it("обновляет счётчик родителя после удаления подзадачи без remount доски", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("parent", { title: "Родитель", status: "todo" }),
        makeTask("child", { title: "Ребёнок", status: "todo", parentTaskId: "parent" }),
      ],
    };
    const operations = createOperations(board);

    render(
      <>
        <KanbanView invoke={operations.invoke} />
        <TaskOverlay invoke={operations.invoke} pathname="/view/kanban" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtasks-parent")).toHaveTextContent("Подзадачи: 1");
    });

    const parentCard = screen.getByTestId("kanban-card-parent");

    fireEvent.click(screen.getByTestId("kanban-open-child"));
    await waitFor(() => {
      expect(screen.getByTestId("kanban-details")).toHaveTextContent("Ребёнок");
    });

    fireEvent.click(screen.getByTestId("task-delete"));
    fireEvent.click(screen.getByTestId("task-delete-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtasks-parent")).toHaveTextContent("Подзадачи: 0");
    });
    expect(screen.getByTestId("kanban-card-parent")).toBe(parentCard);
    expect(board.tasks.some((task) => task.id === "child")).toBe(false);
  });
});

describe("массовые действия с карточками", () => {
  function select(taskId: string): void {
    fireEvent.click(screen.getByTestId(`kanban-bulk-check-${taskId}`));
  }

  function bulkBar(): HTMLElement | null {
    return screen.queryByTestId("kanban-bulk-bar");
  }

  function moveTo(status: "backlog" | "todo" | "in_progress" | "done" = "in_progress"): void {
    fireEvent.change(screen.getByTestId("kanban-bulk-target"), {
      target: { value: columnIdFor("project-1", status) },
    });
  }

  function bulkCalls(operationId: string): Array<Record<string, unknown>> {
    return operationsWithCalls
      .filter((call) => call.operationId === operationId)
      .map((call) => inputOf(call.input));
  }

  let operationsWithCalls: FakeOperations["calls"] = [];

  function renderBoard(board: FakeBoard, overrides: Record<string, Handler> = {}): FakeOperations {
    // Без alias/fallback: UI обязан использовать ровно эти ключи контракта.
    expect(TASKS_COMMAND_IDS.taskMoveMany).toBe("kanbaner.tasks.task.moveMany");
    expect(TASKS_COMMAND_IDS.taskDeleteMany).toBe("kanbaner.tasks.task.deleteMany");

    const operations = createOperations(board, overrides);

    operationsWithCalls = operations.calls;
    render(<KanbanView invoke={operations.invoke} />);

    return operations;
  }

  it("перемещает выбранные задачи одной командой в порядке выбора", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { status: "todo", position: 0 }),
        makeTask("b", { status: "todo", position: 1 }),
        makeTask("c", { status: "in_progress", position: 0 }),
      ],
    };
    const operations = renderBoard(board);

    await screen.findByTestId("kanban-card-a");
    select("b");
    select("a");

    expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 2");
    expect(screen.getByTestId(`kanban-bulk-check-b`)).toBeChecked();

    const summaryBefore = operations.counts.get("kanbaner.tasks.project.summary") ?? 0;

    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });

    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);
    expect(operations.counts.get("kanbaner.tasks.task.move")).toBeUndefined();
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany)).toEqual([
      {
        items: [
          { id: "b", expectedVersion: 1 },
          { id: "a", expectedVersion: 1 },
        ],
        columnId: columnIdFor("project-1", "in_progress"),
      },
    ]);

    await waitFor(() => {
      expect(cardTitles("in_progress")).toEqual(["Задача c", "Задача b", "Задача a"]);
    });
    expect(operations.counts.get("kanbaner.tasks.project.summary") ?? 0).toBeGreaterThan(
      summaryBefore,
    );
  });

  it("не открывает карточку и не запускает drag с чекбокса", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" })],
    };
    const operations = renderBoard(board);

    await screen.findByTestId("kanban-card-a");
    const checkbox = screen.getByRole("checkbox", { name: "Выбрать задачу Задача a" });

    expect(checkbox).not.toBeChecked();
    expect(screen.getByTestId("kanban-card-a")).not.toHaveAttribute("aria-current");

    fireEvent.pointerDown(checkbox, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 90, clientY: 90 });
    fireEvent.pointerUp(window, { clientX: 90, clientY: 90 });

    expect(screen.queryByTestId("kanban-drag-preview")).toBeNull();
    expect(operations.counts.get("kanbaner.tasks.task.move")).toBeUndefined();

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");
    });
    expect(checkbox).toBeChecked();
    expect(screen.getByTestId("kanban-card-a")).not.toHaveAttribute("aria-current");
    expect(window.location.search).not.toContain("task=");
  });

  it("сохраняет выбор и показывает ошибку при неуспешной команде", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" }), makeTask("b", { status: "todo", position: 1 })],
    };
    const operations = renderBoard(board, {
      [TASKS_COMMAND_IDS.taskMoveMany]: () => fail("INTERNAL", "Домен недоступен"),
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");

    moveTo();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-error")).toHaveTextContent("Домен недоступен");
    });

    expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 2");
    expect(screen.getByTestId("kanban-bulk-check-a")).toBeChecked();
    expect(screen.getByTestId("kanban-bulk-check-b")).toBeChecked();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);
  });

  it("при VERSION_CONFLICT обновляет версии, убирает исчезнувшие задачи и повторяет по свежим", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" }), makeTask("b", { status: "todo", position: 1 })],
    };
    let firstAttempt = true;
    const operations = renderBoard(board, {
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          board.tasks = board.tasks
            .map((task) => (task.id === "a" ? ({ ...task, version: 2 } as Task) : task))
            .filter((task) => task.id !== "b");

          return fail("VERSION_CONFLICT");
        }

        return applyBulkMove(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");

    moveTo();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-error")).toHaveTextContent("уже изменены");
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");
    });

    expect(screen.getByTestId("kanban-bulk-check-a")).toBeChecked();
    expect(screen.queryByTestId("kanban-card-b")).toBeNull();

    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });

    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany).at(-1)).toEqual({
      items: [{ id: "a", expectedVersion: 2 }],
      columnId: columnIdFor("project-1", "in_progress"),
    });
    expect(operations.counts.get("kanbaner.tasks.task.delete")).toBeUndefined();
  });

  it("удаляет выбранные задачи только после подтверждения одной командой", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("parent", { status: "todo", position: 0 }),
        makeTask("child", { status: "todo", position: 1, parentTaskId: "parent" }),
        makeTask("other", { status: "todo", position: 2 }),
      ],
    };
    const operations = renderBoard(board);

    await screen.findByTestId("kanban-card-parent");
    select("parent");
    select("child");

    fireEvent.click(screen.getByTestId("kanban-bulk-delete"));

    const dialog = screen.getByTestId("kanban-bulk-delete-dialog");

    expect(dialog).toBeVisible();
    expect(within(dialog).getByTestId("kanban-bulk-delete-count")).toHaveTextContent("2");
    expect(dialog).toHaveTextContent("Выбрано задач:");
    expect(dialog).toHaveTextContent("Подзадачи в это число не входят");
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskDeleteMany)).toBeUndefined();

    fireEvent.click(screen.getByTestId("kanban-bulk-delete-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-bulk-delete-dialog")).toBeNull();
    });

    expect(operations.counts.get(TASKS_COMMAND_IDS.taskDeleteMany)).toBe(1);
    expect(operations.counts.get("kanbaner.tasks.task.delete")).toBeUndefined();
    expect(bulkCalls(TASKS_COMMAND_IDS.taskDeleteMany)).toEqual([
      {
        items: [
          { id: "parent", expectedVersion: 1 },
          { id: "child", expectedVersion: 1 },
        ],
        confirm: true,
      },
    ]);

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-card-parent")).toBeNull();
      expect(screen.queryByTestId("kanban-card-child")).toBeNull();
    });
    expect(screen.getByTestId("kanban-card-other")).toBeVisible();
    expect(bulkBar()).toBeNull();
  });

  it("во время удаления pending блокирует повтор и закрытие", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" })],
    };
    const deletion = deferred<UiOperationResult>();
    const operations = renderBoard(board, {
      [TASKS_COMMAND_IDS.taskDeleteMany]: () => deletion.promise,
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    fireEvent.click(screen.getByTestId("kanban-bulk-delete"));

    const confirm = screen.getByTestId("kanban-bulk-delete-confirm");

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(screen.getByTestId("kanban-bulk-target")).toBeDisabled();
    expect(screen.queryByTestId("kanban-bulk-move-pending")).toBeNull();
    expect(screen.getByTestId("kanban-bulk-delete")).toBeDisabled();

    fireEvent.click(screen.getByTestId("kanban-bulk-delete-cancel"));
    fireEvent.keyDown(screen.getByTestId("kanban-bulk-delete-dialog"), { key: "Escape" });

    expect(screen.getByTestId("kanban-bulk-delete-dialog")).toBeVisible();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskDeleteMany)).toBe(1);

    await act(async () => {
      deletion.resolve(ok({ deleted: 1 }));
      await deletion.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-bulk-delete-dialog")).toBeNull();
    });
    expect(bulkBar()).toBeNull();
  });

  it("при ошибке удаления сохраняет существующий выбор со свежими версиями", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" }), makeTask("b", { status: "todo", position: 1 })],
    };
    let firstAttempt = true;
    renderBoard(board, {
      [TASKS_COMMAND_IDS.taskDeleteMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          board.tasks = board.tasks
            .map((task) => (task.id === "a" ? ({ ...task, version: 3 } as Task) : task))
            .filter((task) => task.id !== "b");

          return fail("VERSION_CONFLICT");
        }

        return applyBulkDelete(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");
    fireEvent.click(screen.getByTestId("kanban-bulk-delete"));
    fireEvent.click(screen.getByTestId("kanban-bulk-delete-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-delete-error")).toHaveTextContent("уже изменены");
    });
    expect(screen.getByTestId("kanban-bulk-delete-dialog")).toBeVisible();
    expect(screen.getByTestId("kanban-bulk-delete-count")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("kanban-bulk-delete-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-bulk-delete-dialog")).toBeNull();
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskDeleteMany).at(-1)).toEqual({
      items: [{ id: "a", expectedVersion: 3 }],
      confirm: true,
    });
  });

  it("смена tag снимает скрытый выбор и не оставляет действий над невидимыми", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("release-task", { status: "todo", tags: ["release"] }),
        makeTask("other-task", { status: "todo", position: 1, tags: ["other"] }),
      ],
    };
    renderBoard(board);

    await screen.findByTestId("kanban-card-release-task");
    select("release-task");
    select("other-task");
    expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 2");

    act(() => {
      updateKanbanQuery({ tag: "release" });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-card-other-task")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");
    });
    expect(screen.getByTestId("kanban-bulk-check-release-task")).toBeChecked();

    act(() => {
      updateKanbanQuery({ tag: "other" });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-bulk-bar")).toBeNull();
    });
  });

  it("смена проекта очищает выбор", async () => {
    const secondProject: Project = {
      ...project,
      id: "project-2",
      title: "Проект два",
    };
    const board: FakeBoard = {
      projects: [project, secondProject],
      tasks: [
        makeTask("a", { status: "todo" }),
        makeTask("b", { projectId: "project-2", status: "todo" }),
      ],
    };
    renderBoard(board);

    await screen.findByTestId("kanban-card-a");
    select("a");
    expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");

    act(() => {
      updateKanbanQuery({ projectId: "project-2", taskId: null });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-b")).toBeVisible();
    });
    expect(screen.queryByTestId("kanban-bulk-bar")).toBeNull();
    expect(screen.queryByTestId("kanban-card-a")).toBeNull();
  });

  it("сохраняет выбор при обычном refresh и обновляет версии", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" })],
    };
    const operations = renderBoard(board);

    await screen.findByTestId("kanban-card-a");
    select("a");
    expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");

    board.tasks = board.tasks.map((task) =>
      task.id === "a" ? ({ ...task, version: 4 } as Task) : task,
    );

    act(() => {
      bumpKanbanRevision();
    });

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.list")).toBeGreaterThan(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");
    });
    expect(screen.getByTestId("kanban-bulk-check-a")).toBeChecked();

    moveTo("backlog");

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany)).toEqual([
      {
        items: [{ id: "a", expectedVersion: 4 }],
        columnId: columnIdFor("project-1", "backlog"),
      },
    ]);
  });

  it("pending переноса блокирует повторную отправку", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" })],
    };
    const move = deferred<UiOperationResult>();
    const operations = renderBoard(board, {
      [TASKS_COMMAND_IDS.taskMoveMany]: () => move.promise,
    });

    await screen.findByTestId("kanban-card-a");
    select("a");

    const target = screen.getByTestId("kanban-bulk-target");
    const input = { target: { value: columnIdFor("project-1", "in_progress") } };

    fireEvent.change(target, input);
    fireEvent.change(target, input);

    await waitFor(() => {
      expect(target).toBeDisabled();
    });
    expect(screen.getByTestId("kanban-bulk-delete")).toBeDisabled();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);

    await act(async () => {
      move.resolve(ok({ tasks: [] }));
      await move.promise;
    });

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);
  });

  it("дописывает same-column в порядке выбора и сразу показывает карточки", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { status: "todo", position: 0 }),
        makeTask("b", { status: "todo", position: 1 }),
        makeTask("c", { status: "todo", position: 2 }),
      ],
    };
    const operations = renderBoard(board);

    await screen.findByTestId("kanban-card-a");
    select("b");
    select("a");
    moveTo("todo");

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    await waitFor(() => {
      expect(cardTitles("todo")).toEqual(["Задача c", "Задача b", "Задача a"]);
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany)).toEqual([
      {
        items: [
          { id: "b", expectedVersion: 1 },
          { id: "a", expectedVersion: 1 },
        ],
        columnId: columnIdFor("project-1", "todo"),
      },
    ]);
    expect(operations.counts.get("kanbaner.tasks.task.move")).toBeUndefined();
  });

  it("показывает перемещённые карточки за границей страницы target", async () => {
    const targetTasks = Array.from({ length: 12 }, (_, index) =>
      makeTask(`target-${String(index)}`, { status: "in_progress", position: index }),
    );
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("mover", { status: "todo" }), ...targetTasks],
    };
    renderBoard(board);

    await screen.findByTestId("kanban-card-mover");
    await waitFor(() => {
      expect(cardTitles("in_progress")).toHaveLength(10);
    });

    select("mover");
    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    await waitFor(() => {
      const titles = cardTitles("in_progress");

      expect(titles).toHaveLength(13);
      expect(titles.at(-1)).toBe("Задача mover");
    });
    expect(screen.getByTestId("kanban-count-in_progress")).toHaveTextContent("13");
  });

  it("снимает из выбора задачу, переставшую соответствовать активному tag после конфликта", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { status: "todo", tags: ["release"] }),
        makeTask("b", { status: "todo", position: 1, tags: ["release"] }),
      ],
    };
    let firstAttempt = true;
    renderBoard(board, {
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          board.tasks = board.tasks.map((task) =>
            task.id === "a" ? ({ ...task, tags: [], version: 2 } as Task) : task,
          );

          return fail("VERSION_CONFLICT");
        }

        return applyBulkMove(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    act(() => {
      updateKanbanQuery({ tag: "release" });
    });
    await waitFor(() => {
      expect(cardTitles("todo")).toEqual(["Задача a", "Задача b"]);
    });

    select("a");
    select("b");
    moveTo();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");
    });
    expect(screen.queryByTestId("kanban-bulk-check-a")).toBeNull();
    expect(screen.getByTestId("kanban-bulk-check-b")).toBeChecked();

    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany).at(-1)).toEqual({
      items: [{ id: "b", expectedVersion: 1 }],
      columnId: columnIdFor("project-1", "in_progress"),
    });
  });

  it("блокирует повтор после конфликта с неудачной перечиткой и использует свежие версии", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" }), makeTask("b", { status: "todo", position: 1 })],
    };
    let firstAttempt = true;
    let failReload = false;
    const operations = renderBoard(board, {
      "kanbaner.tasks.column.list": (input) => {
        if (failReload) {
          return fail("INTERNAL", "reload failed");
        }

        const projectId = String(inputOf(input).projectId);
        const columns = boardColumns(board, projectId);

        return ok({ items: [...columns], total: columns.length, nextOffset: null });
      },
      "kanbaner.tasks.task.list": (input) =>
        failReload ? fail("INTERNAL", "reload failed") : listTasks(board, input),
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          failReload = true;
          board.tasks = board.tasks.map((task) =>
            task.id === "a" ? ({ ...task, version: 2 } as Task) : task,
          );

          return fail("VERSION_CONFLICT");
        }

        return applyBulkMove(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");
    moveTo();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-error")).toHaveTextContent("НЕ обновлены");
    });
    expect(screen.getByTestId("kanban-bulk-refresh")).toBeVisible();
    expect(screen.getByTestId("kanban-bulk-target")).toBeDisabled();
    expect(screen.getByTestId("kanban-bulk-clear")).toBeDisabled();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);

    moveTo();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);

    failReload = false;
    fireEvent.click(screen.getByTestId("kanban-bulk-refresh"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-bulk-refresh")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-target")).toBeEnabled();
    });

    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany).at(-1)).toEqual({
      items: [
        { id: "a", expectedVersion: 2 },
        { id: "b", expectedVersion: 1 },
      ],
      columnId: columnIdFor("project-1", "in_progress"),
    });
  });

  it("снимает блокировку refresh, если после неудачной перечитки выбор опустел", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { status: "todo", tags: ["release"] }),
        makeTask("b", { status: "todo", position: 1, tags: ["release"] }),
        makeTask("c", { status: "todo", position: 2, tags: ["release"] }),
      ],
    };
    let firstAttempt = true;
    let failReload = false;
    renderBoard(board, {
      "kanbaner.tasks.column.list": (input) => {
        if (failReload) {
          return fail("INTERNAL", "reload failed");
        }

        const projectId = String(inputOf(input).projectId);
        const columns = boardColumns(board, projectId);

        return ok({ items: [...columns], total: columns.length, nextOffset: null });
      },
      "kanbaner.tasks.task.list": (input) =>
        failReload ? fail("INTERNAL", "reload failed") : listTasks(board, input),
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          failReload = true;
          board.tasks = board.tasks.map((task) =>
            task.id === "a" || task.id === "b" ? ({ ...task, tags: [], version: 2 } as Task) : task,
          );

          return fail("VERSION_CONFLICT");
        }

        return applyBulkMove(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    act(() => {
      updateKanbanQuery({ tag: "release" });
    });
    await waitFor(() => {
      expect(cardTitles("todo")).toHaveLength(3);
    });

    select("a");
    select("b");
    moveTo();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-error")).toHaveTextContent("НЕ обновлены");
    });

    // Успешная перечитка видит только c; a и b больше не соответствуют tag.
    failReload = false;
    fireEvent.click(screen.getByTestId("kanban-bulk-refresh"));

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(screen.queryByTestId("kanban-bulk-refresh")).toBeNull();

    const checkbox = screen.getByTestId("kanban-bulk-check-c");

    expect(checkbox).toBeEnabled();
    select("c");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");
    });
    expect(screen.getByTestId("kanban-bulk-target")).toBeEnabled();
  });

  it("не выставляет блокировку из устаревшей R1 после успешной R2", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" }), makeTask("b", { status: "todo", position: 1 })],
    };
    let firstAttempt = true;
    let conflictStarted = false;
    let r1Started = false;
    const r1 = deferred<UiOperationResult>();
    const operations = renderBoard(board, {
      "kanbaner.tasks.column.list": (input) => {
        if (conflictStarted && !r1Started) {
          r1Started = true;

          return r1.promise;
        }

        const projectId = String(inputOf(input).projectId);
        const columns = boardColumns(board, projectId);

        return ok({ items: [...columns], total: columns.length, nextOffset: null });
      },
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          conflictStarted = true;
          board.tasks = board.tasks.map((task) =>
            task.id === "a" ? ({ ...task, version: 2 } as Task) : task,
          );

          return fail("VERSION_CONFLICT");
        }

        return applyBulkMove(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");
    moveTo();

    await waitFor(() => {
      expect(r1Started).toBe(true);
    });

    const listCallsBefore = operations.counts.get("kanbaner.tasks.task.list") ?? 0;

    // R2 стартует позже и завершается раньше R1.
    act(() => {
      bumpKanbanRevision();
    });
    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.list") ?? 0).toBeGreaterThan(
        listCallsBefore,
      );
    });
    await act(async () => {});

    const projectId = "project-1";
    const columns = boardColumns(board, projectId);

    await act(async () => {
      r1.resolve(ok({ items: [...columns], total: columns.length, nextOffset: null }));
      await r1.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-error")).toHaveTextContent("перечитана");
    });
    expect(screen.queryByTestId("kanban-bulk-refresh")).toBeNull();
    expect(screen.getByTestId("kanban-bulk-target")).toBeEnabled();

    // R2 обновил версии, поэтому повтор не использует stale expectedVersion.
    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany).at(-1)).toEqual({
      items: [
        { id: "a", expectedVersion: 2 },
        { id: "b", expectedVersion: 1 },
      ],
      columnId: columnIdFor("project-1", "in_progress"),
    });
  });

  it("регистрирует visibility только для moved задач текущего tag", async () => {
    const targetId = columnIdFor("project-1", "in_progress");
    const targetTasks = Array.from({ length: 25 }, (_, index) =>
      makeTask(`target-${String(index)}`, {
        status: "in_progress",
        position: index,
        tags: ["other"],
      }),
    );
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { status: "todo", tags: ["release", "other"] }),
        makeTask("b", { status: "todo", position: 1, tags: ["release"] }),
        ...targetTasks,
      ],
    };
    const move = deferred<UiOperationResult>();
    const operations = renderBoard(board, {
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) =>
        new Promise<UiOperationResult>((resolve) => {
          void move.promise.then(() => {
            resolve(applyBulkMove(board, input));
          });
        }),
    });

    await screen.findByTestId("kanban-card-a");
    await waitFor(() => {
      expect(cardTitles("in_progress")).toHaveLength(10);
    });

    select("a");
    select("b");
    fireEvent.change(screen.getByTestId("kanban-bulk-target"), {
      target: { value: targetId },
    });

    // Tag меняется до завершения move: b больше не виден.
    act(() => {
      updateKanbanQuery({ tag: "other" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("kanban-card-b")).toBeNull();
    });

    await act(async () => {
      move.resolve(ok({}));
      await move.promise;
    });

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    await waitFor(() => {
      const titles = cardTitles("in_progress");

      expect(titles).toHaveLength(26);
      expect(titles.at(-1)).toBe("Задача a");
    });

    const targetListCalls = operations.calls
      .filter((call) => call.operationId === "kanbaner.tasks.task.list")
      .map((call) => inputOf(call.input))
      .filter((input) => input.columnId === targetId);
    const lastLimit = targetListCalls.at(-1)?.limit;

    // a (position 25) даёт 26 загружаемых записей → 10+10+6. Если бы b
    // (position 26) ошибочно попал в required, последняя страница была бы 7.
    expect(lastLimit).toBe(6);
    expect(screen.queryByTestId("kanban-card-b")).toBeNull();
  });

  it("блокирует retry при ошибке task.list до полного refresh", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" }), makeTask("b", { status: "todo", position: 1 })],
    };
    let firstAttempt = true;
    let failList = false;
    const operations = renderBoard(board, {
      "kanbaner.tasks.task.list": (input) =>
        failList ? fail("INTERNAL", "task.list failed") : listTasks(board, input),
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          failList = true;
          board.tasks = board.tasks.map((task) =>
            task.id === "a" ? ({ ...task, version: 2 } as Task) : task,
          );

          return fail("VERSION_CONFLICT");
        }

        return applyBulkMove(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");
    moveTo();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-error")).toHaveTextContent("НЕ обновлены");
    });
    expect(screen.getByTestId("kanban-bulk-refresh")).toBeVisible();
    expect(screen.getByTestId("kanban-bulk-target")).toBeDisabled();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);

    failList = false;
    fireEvent.click(screen.getByTestId("kanban-bulk-refresh"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-bulk-refresh")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-target")).toBeEnabled();
    });

    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany).at(-1)).toEqual({
      items: [
        { id: "a", expectedVersion: 2 },
        { id: "b", expectedVersion: 1 },
      ],
      columnId: columnIdFor("project-1", "in_progress"),
    });
  });

  it("блокирует retry при временной ошибке task.get до полного refresh", async () => {
    const targetTasks = Array.from({ length: 12 }, (_, index) =>
      makeTask(`target-${String(index)}`, { status: "in_progress", position: index }),
    );
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { status: "todo" }),
        makeTask("b", { status: "todo", position: 1 }),
        ...targetTasks,
      ],
    };
    let firstAttempt = true;
    let failTaskGet = false;
    const operations = renderBoard(board, {
      "kanbaner.tasks.task.get": (input) => {
        if (failTaskGet && String(inputOf(input).id) === "a") {
          failTaskGet = false;

          return fail("INTERNAL", "task.get temporary");
        }

        const found = getTask(board, String(inputOf(input).id));

        return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
      },
      [TASKS_COMMAND_IDS.taskMoveMany]: (input) => {
        if (firstAttempt) {
          firstAttempt = false;
          failTaskGet = true;
          board.tasks = board.tasks.map((task) =>
            task.id === "a"
              ? ({
                  ...task,
                  columnId: columnIdFor("project-1", "in_progress"),
                  status: "in_progress",
                  position: 12,
                  version: 2,
                } as Task)
              : task,
          );

          return fail("VERSION_CONFLICT");
        }

        return applyBulkMove(board, input);
      },
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");
    moveTo();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-error")).toHaveTextContent("НЕ обновлены");
    });
    expect(screen.getByTestId("kanban-bulk-refresh")).toBeVisible();
    expect(screen.getByTestId("kanban-bulk-target")).toBeDisabled();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBe(1);

    fireEvent.click(screen.getByTestId("kanban-bulk-refresh"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-bulk-refresh")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-target")).toBeEnabled();
    });

    moveTo();

    await waitFor(() => {
      expect(bulkBar()).toBeNull();
    });
    expect(bulkCalls(TASKS_COMMAND_IDS.taskMoveMany).at(-1)).toEqual({
      items: [
        { id: "a", expectedVersion: 2 },
        { id: "b", expectedVersion: 1 },
      ],
      columnId: columnIdFor("project-1", "in_progress"),
    });
  });

  it("не оставляет hidden block, если tag очистил selection во время failed refresh", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { status: "todo", tags: ["release"] }),
        makeTask("b", { status: "todo", position: 1, tags: ["release"] }),
        makeTask("c", { status: "todo", position: 2, tags: ["other"] }),
      ],
    };
    let conflictStarted = false;
    let r1Started = false;
    let r2Failed = false;
    const r1 = deferred<UiOperationResult>();
    renderBoard(board, {
      "kanbaner.tasks.column.list": (input) => {
        if (conflictStarted && !r1Started) {
          r1Started = true;

          return r1.promise;
        }

        if (conflictStarted && !r2Failed) {
          r2Failed = true;

          return fail("INTERNAL", "R2 failed");
        }

        const projectId = String(inputOf(input).projectId);
        const columns = boardColumns(board, projectId);

        return ok({ items: [...columns], total: columns.length, nextOffset: null });
      },
      [TASKS_COMMAND_IDS.taskMoveMany]: () => {
        conflictStarted = true;

        return fail("VERSION_CONFLICT");
      },
    });

    await screen.findByTestId("kanban-card-a");
    select("a");
    select("b");
    moveTo();

    await waitFor(() => {
      expect(r1Started).toBe(true);
    });

    // Tag меняет selection на 0 и запускает R2, которая падает.
    act(() => {
      updateKanbanQuery({ tag: "other" });
    });
    await waitFor(() => {
      expect(r2Failed).toBe(true);
    });
    expect(screen.queryByTestId("kanban-bulk-bar")).toBeNull();

    const projectId = "project-1";
    const columns = boardColumns(board, projectId);

    await act(async () => {
      r1.resolve(ok({ items: [...columns], total: columns.length, nextOffset: null }));
      await r1.promise;
    });

    // Hidden block не вернулся: после успешной R3 выбор c доступен.
    act(() => {
      bumpKanbanRevision();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-check-c")).toBeEnabled();
    });
    expect(screen.queryByTestId("kanban-bulk-refresh")).toBeNull();
    select("c");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-bulk-count")).toHaveTextContent("Выбрано 1");
    });
    expect(screen.getByTestId("kanban-bulk-target")).toBeEnabled();
  });

  it("снимает выбор кнопкой и не отправляет операцию", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { status: "todo" })],
    };
    const operations = renderBoard(board);

    await screen.findByTestId("kanban-card-a");
    select("a");
    fireEvent.click(screen.getByTestId("kanban-bulk-clear"));

    expect(screen.queryByTestId("kanban-bulk-bar")).toBeNull();
    expect(screen.getByTestId("kanban-bulk-check-a")).not.toBeChecked();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskMoveMany)).toBeUndefined();
    expect(operations.counts.get(TASKS_COMMAND_IDS.taskDeleteMany)).toBeUndefined();
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

  it("при переключении A→B не показывает и не меняет устаревшую задачу A", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    const bLoad = deferred<UiOperationResult>();
    const operations = createOperations(board, {
      "kanbaner.tasks.task.get": (input) => {
        const id = String(inputOf(input).id);

        if (id === "b") {
          return bLoad.promise;
        }

        const found = getTask(board, id);

        return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
      },
    });

    render(
      <>
        <KanbanView invoke={operations.invoke} />
        <TaskOverlay invoke={operations.invoke} pathname="/view/kanban" />
      </>,
    );

    await screen.findByTestId("kanban-card-a");
    fireEvent.click(screen.getByTestId("kanban-open-a"));
    await waitFor(() => {
      expect(screen.getByTestId("kanban-details")).toHaveTextContent("Задача A");
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("task-ui-loading")).toBeInTheDocument();
    });

    const loadingDialog = screen.getByTestId("kanban-details");

    expect(within(loadingDialog).queryByText("Задача A")).toBeNull();
    expect(within(loadingDialog).queryByRole("button", { name: "Завершить" })).toBeNull();
    expect(
      operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.complete"),
    ).toBe(false);

    await act(async () => {
      bLoad.resolve(ok({ task: getTask(board, "b") as Task }));
      await bLoad.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-details")).toHaveTextContent("Задача B");
    });

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));

    await waitFor(() => {
      const lastComplete = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.complete")
        .at(-1);

      expect(inputOf(lastComplete?.input ?? {})).toMatchObject({ id: "b" });
    });
  });

  it("синхронизирует overlay с search из router-aware shell", async () => {
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "todo", position: 1 }),
      ],
    };
    const operations = createOperations(board);

    const view = render(
      <>
        <KanbanView invoke={operations.invoke} search="?task=a" />
        <TaskOverlay invoke={operations.invoke} pathname="/view/kanban" search="?task=a" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("kanban-details")).toHaveTextContent("Задача A");
    });

    // Настоящий Link на том же маршруте меняет только query string.
    view.rerender(
      <>
        <KanbanView invoke={operations.invoke} search="?task=b" />
        <TaskOverlay invoke={operations.invoke} pathname="/view/kanban" search="?task=b" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("kanban-details")).toHaveTextContent("Задача B");
    });

    view.rerender(
      <>
        <KanbanView invoke={operations.invoke} search="" />
        <TaskOverlay invoke={operations.invoke} pathname="/view/kanban" search="" />
      </>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
  });
});
