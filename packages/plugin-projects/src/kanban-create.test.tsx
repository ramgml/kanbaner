import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import {
  getKanbanQuerySnapshot,
  resetKanbanQueryForTests,
  updateKanbanQuery,
} from "./ui/query-state.ts";

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

function makeProject(id: string, title = `Проект ${id}`): Project {
  return {
    id,
    title,
    descriptionMarkdown: "",
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
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

interface FakeBoard {
  tasks: Task[];
  projects: Project[];
  nextProject: number;
  nextTask: number;
}

type Handler = (input: JsonValue) => UiOperationResult | Promise<UiOperationResult>;

interface FakeOperations {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ readonly operationId: string; readonly input: JsonValue }>;
  readonly counts: ReadonlyMap<string, number>;
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
    const tag = filters.tag.trim().toLowerCase();

    items = items.filter((task) => task.tags.includes(tag));
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

function summaryOf(board: FakeBoard, input: JsonValue): UiOperationResult {
  const projectId = inputOf(input).projectId;
  const projects =
    typeof projectId === "string"
      ? board.projects.filter((project) => project.id === projectId)
      : board.projects;
  const counts = { backlog: 0, todo: 0, in_progress: 0, done: 0 } as Record<TaskStatus, number>;

  for (const task of board.tasks) {
    counts[task.status] += 1;
  }

  return ok({
    items: projects.map((project) => ({
      project,
      total: board.tasks.filter((task) => task.projectId === project.id).length,
      counts,
      overdueCount: 0,
    })),
    total: projects.length,
    nextOffset: null,
    totals: {
      total: board.tasks.length,
      counts,
      overdueCount: 0,
    },
  });
}

function nextPosition(board: FakeBoard, projectId: string, status: TaskStatus): number {
  return board.tasks.filter((task) => task.projectId === projectId && task.status === status)
    .length;
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
    "kanbaner.tasks.project.summary": (input) => summaryOf(board, input),
    "kanbaner.tasks.project.create": (input) => {
      const values = inputOf(input);
      const project = makeProject(`project-${String(board.nextProject)}`, String(values.title));

      board.nextProject += 1;
      board.projects = [...board.projects, project];

      return ok({ project });
    },
    "kanbaner.tasks.task.list": (input) => listTasks(board, input),
    "kanbaner.tasks.task.get": (input) => {
      const found = board.tasks.find((task) => task.id === inputOf(input).id);

      return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
    },
    "kanbaner.tasks.task.create": (input) => {
      const values = inputOf(input);
      const projectId = String(values.projectId);
      const status = (values.status as TaskStatus | undefined) ?? "todo";
      const id = `task-${String(board.nextTask)}`;
      const task = makeTask(id, {
        projectId,
        title: String(values.title),
        descriptionMarkdown: String(values.descriptionMarkdown ?? ""),
        status,
        priority: (values.priority as Task["priority"] | undefined) ?? "medium",
        dueAt: (values.dueAt as string | null | undefined) ?? null,
        tags: (values.tags as string[] | undefined) ?? [],
        parentTaskId: (values.parentTaskId as string | undefined) ?? null,
        position: nextPosition(board, projectId, status),
      });

      board.nextTask += 1;
      board.tasks = [...board.tasks, task];

      return ok({ task });
    },
    "kanbaner.tasks.task.move": () => fail("INTERNAL_ERROR"),
    "kanbaner.tasks.task.delete": () => ok(null),
    "kanbaner.tasks.task.complete": () => fail("INTERNAL_ERROR"),
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

  return { invoke, calls, counts };
}

function setMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/view/kanban");
  resetKanbanQueryForTests("");
  setMatchMedia(true);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("создание на канбане", () => {
  it("показывает кнопки доски и колонок без внутреннего выбора проекта", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
    });

    for (const [status, label] of [
      ["backlog", "Бэклог"],
      ["todo", "К выполнению"],
      ["in_progress", "В работе"],
      ["done", "Готово"],
    ] as const) {
      expect(screen.getByTestId(`kanban-quick-add-${status}`)).toHaveAccessibleName(
        `Добавить карточку в колонку «${label}»`,
      );
    }

    // Отдельного пути «создать проект» и «создать с деталями» на доске нет.
    expect(screen.queryByTestId("kanban-create-project")).toBeNull();
    expect(screen.queryByTestId("kanban-create-task-todo")).toBeNull();
    expect(screen.queryByTestId("task-form-create")).toBeNull();
  });

  it("создаёт задачу только по названию из заголовка доски", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1", "Первый")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-create-task"));

    const form = screen.getByTestId("kanban-create-form");
    const input = within(form).getByTestId("kanban-create-input");

    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("type", "text");
    expect(screen.queryByTestId("task-form-create")).toBeNull();
    expect(within(form).queryByLabelText("Проект")).toBeNull();

    fireEvent.change(input, { target: { value: "Новая с доски" } });
    fireEvent.click(within(form).getByTestId("kanban-create-submit"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-create-form")).toBeNull();
    });

    const create = operations.calls.find(
      (call) => call.operationId === "kanbaner.tasks.task.create",
    );
    const payload = inputOf(create?.input ?? {});

    expect(payload).toMatchObject({
      projectId: "project-1",
      title: "Новая с доски",
      status: "todo",
      descriptionMarkdown: "",
      tags: [],
    });
    expect(payload).not.toHaveProperty("parentTaskId");
    expect(payload).not.toHaveProperty("position");
    expect(payload).not.toHaveProperty("expectedVersion");
  });

  it("создаёт задачу из колонки с project/status без ручной позиции", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1", "Первый")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-quick-add-done")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-quick-add-done"));
    fireEvent.change(screen.getByTestId("kanban-quick-add-done-input"), {
      target: { value: "Готовая без деталей" },
    });
    fireEvent.click(screen.getByTestId("kanban-quick-add-done-submit"));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-done")).getByText("Готовая без деталей"),
      ).toBeVisible();
    });

    const create = operations.calls.find(
      (call) => call.operationId === "kanbaner.tasks.task.create",
    );
    const payload = inputOf(create?.input ?? {});

    expect(payload).toMatchObject({
      projectId: "project-1",
      title: "Готовая без деталей",
      status: "done",
    });
    expect(payload).not.toHaveProperty("position");
  });

  it("оставляет composer открытым с введённым названием при ошибке", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.create": () => fail("INTERNAL_ERROR", "Сервер недоступен"),
    });

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-quick-add-todo")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    const form = screen.getByTestId("kanban-quick-add-todo-form");
    const input = within(form).getByTestId("kanban-quick-add-todo-input");

    fireEvent.change(input, { target: { value: "Не потерять ввод" } });
    fireEvent.click(within(form).getByTestId("kanban-quick-add-todo-submit"));

    await waitFor(() => {
      expect(within(form).getByRole("alert")).toHaveTextContent("Сервер недоступен");
    });

    expect(screen.getByTestId("kanban-quick-add-todo-form")).toBe(form);
    expect(input).toHaveValue("Не потерять ввод");
    expect(within(form).getByTestId("kanban-quick-add-todo-submit")).toBeEnabled();
  });

  it("блокирует повторную отправку и не создаёт дубль", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const pending = deferred<UiOperationResult>();
    let resolveCreate: ((result: UiOperationResult) => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.create": () => {
        resolveCreate = pending.resolve;

        return pending.promise;
      },
    });

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-create-task"));

    const form = screen.getByTestId("kanban-create-form");
    const submit = within(form).getByTestId("kanban-create-submit");

    fireEvent.change(within(form).getByTestId("kanban-create-input"), {
      target: { value: "Только одна" },
    });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(form);

    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(operations.counts.get("kanbaner.tasks.task.create")).toBe(1);

    const task = makeTask("created", {
      projectId: "project-1",
      title: "Только одна",
      status: "todo",
      position: 0,
    });

    await act(async () => {
      board.tasks = [task];
      resolveCreate?.(ok({ task }));
      await pending.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-create-form")).toBeNull();
    });
    expect(board.tasks).toHaveLength(1);
  });

  it("догружает колонку до созданной карточки за границей страницы", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: Array.from({ length: 10 }, (_, index) =>
        makeTask(`p${String(index).padStart(2, "0")}`, {
          projectId: "project-1",
          status: "backlog",
          title: `Старая ${String(index)}`,
          position: index,
        }),
      ),
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("10");
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-quick-add-backlog"));
    fireEvent.change(screen.getByTestId("kanban-quick-add-backlog-input"), {
      target: { value: "Одиннадцатая" },
    });
    fireEvent.click(screen.getByTestId("kanban-quick-add-backlog-submit"));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-backlog")).getByText("Одиннадцатая"),
      ).toBeVisible();
    });
    expect(screen.getByTestId("kanban-count-backlog")).toHaveTextContent("11");

    const backlogPages = operations.calls.filter(
      (call) =>
        call.operationId === "kanbaner.tasks.task.list" && inputOf(call.input).status === "backlog",
    );

    expect(backlogPages.some((call) => inputOf(call.input).offset === 10)).toBe(true);
  });

  it("не открывает формы вне /view/kanban и управляет фокусом на мобильном", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    const desktop = render(<KanbanView invoke={operations.invoke} pathname="/view/tasks" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-view")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("kanban-create-task")).toBeNull();
    expect(screen.queryByTestId("kanban-quick-add-todo")).toBeNull();

    desktop.unmount();
    setMatchMedia(false);
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    const opener = screen.getByTestId("kanban-create-task");

    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByTestId("kanban-create-dialog");

    expect(dialog.tagName).toBe("DIALOG");
    await waitFor(() => {
      expect(document.activeElement?.closest("dialog")).toBe(dialog);
    });

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByTestId("kanban-create-dialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it("сбрасывает фильтр тега, потому что созданная карточка не содержит тегов", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-quick-add-todo")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1", tag: "Other" });
    });

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));
    fireEvent.change(screen.getByTestId("kanban-quick-add-todo-input"), {
      target: { value: "Без чужого тега" },
    });
    fireEvent.click(screen.getByTestId("kanban-quick-add-todo-submit"));

    await waitFor(() => {
      expect(getKanbanQuerySnapshot().tag).toBe("");
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-todo")).getByText("Без чужого тега"),
      ).toBeVisible();
    });
  });

  it("не предлагает полную форму и отдельный путь с деталями", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-quick-add-todo")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-create-task"));

    expect(screen.getByTestId("kanban-create-form")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-quick-details-todo")).toBeNull();
    expect(screen.queryByTestId("task-form-create")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("kanban-create-input"), { key: "Escape" });

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    expect(screen.getByTestId("kanban-quick-add-todo-form")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-quick-details-todo")).toBeNull();
    expect(screen.queryByTestId("task-form-create")).toBeNull();
  });

  it("держит отдельное состояние открытых composer для каждой колонки", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-quick-add-todo")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));
    fireEvent.change(screen.getByTestId("kanban-quick-add-todo-input"), {
      target: { value: "Черновик todo" },
    });

    fireEvent.click(screen.getByTestId("kanban-quick-add-backlog"));
    fireEvent.change(screen.getByTestId("kanban-quick-add-backlog-input"), {
      target: { value: "Черновик backlog" },
    });

    expect(screen.getByTestId("kanban-quick-add-todo-form")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-quick-add-backlog-form")).toBeInTheDocument();

    const todoForm = screen.getByTestId("kanban-quick-add-todo-form");

    fireEvent.click(within(todoForm).getByRole("button", { name: "Закрыть добавление карточки" }));

    expect(screen.queryByTestId("kanban-quick-add-todo-form")).toBeNull();
    expect(screen.getByTestId("kanban-quick-add-todo")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-quick-add-backlog-input")).toHaveValue("Черновик backlog");
    expect(screen.getByTestId("kanban-quick-add-backlog-form")).toBeInTheDocument();
  });

  it("не создаёт проект из доски: это делает sidebar", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
    });

    expect(screen.queryByTestId("kanban-create-project")).toBeNull();
    expect(screen.queryByTestId("project-form")).toBeNull();
    expect(operations.counts.get("kanbaner.tasks.project.create") ?? 0).toBe(0);
  });
});
