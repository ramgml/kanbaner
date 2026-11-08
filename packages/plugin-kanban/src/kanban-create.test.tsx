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

function installMatchMedia(initial: boolean): (matches: boolean) => void {
  let current = initial;
  const listeners = new Set<() => void>();
  const mediaQuery = {
    get matches() {
      return current;
    },
    media: "",
    onchange: null,
    addEventListener: (_event: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: () => void) => {
      listeners.delete(listener);
    },
    addListener: (listener: () => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: () => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => mediaQuery,
  });

  return (matches) => {
    current = matches;

    for (const listener of listeners) {
      listener();
    }
  };
}

function taskForm(): HTMLElement {
  return screen.getByTestId("task-form-create");
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
  it("показывает кнопки доски и колонок с доступными названиями", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    expect(screen.getByTestId("kanban-create-project")).toHaveAccessibleName("Новый проект");
    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
    });

    for (const [status, label] of [
      ["backlog", "Бэклог"],
      ["todo", "К выполнению"],
      ["in_progress", "В работе"],
      ["done", "Готово"],
    ] as const) {
      expect(screen.getByTestId(`kanban-create-task-${status}`)).toHaveAccessibleName(
        `Новая задача в колонке «${label}»`,
      );
    }

    // Без активного фильтра проект не подставляется автоматически.
    fireEvent.click(screen.getByTestId("kanban-create-task"));

    const form = taskForm();

    expect(within(form).getByLabelText("Проект")).toHaveValue("");
    expect(within(form).getByLabelText("Статус")).toHaveValue("todo");
  });

  it("предустанавливает проект из фильтра, статус колонки и ограничивает родителей", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1", "Первый"), makeProject("project-2", "Второй")],
      tasks: [
        makeTask("root-1", { projectId: "project-1", title: "Корень первого" }),
        makeTask("root-2", { projectId: "project-2", title: "Корень второго" }),
        makeTask("child", { projectId: "project-1", title: "Подзадача", parentTaskId: "root-1" }),
      ],
      nextProject: 3,
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

    fireEvent.click(screen.getByTestId("kanban-create-task-in_progress"));

    const form = taskForm();

    expect(within(form).getByLabelText("Проект")).toHaveValue("project-1");
    expect(within(form).getByLabelText("Статус")).toHaveValue("in_progress");

    const parent = within(form).getByLabelText("Родительская задача");

    await waitFor(() => {
      expect(within(parent).getByRole("option", { name: "Корень первого" })).toBeInTheDocument();
    });
    expect(within(parent).queryByRole("option", { name: "Корень второго" })).toBeNull();
    expect(within(parent).queryByRole("option", { name: "Подзадача" })).toBeNull();
  });

  it("создаёт проект через project.create и не сбрасывает фильтр", async () => {
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

    fireEvent.click(screen.getByTestId("kanban-create-project"));

    const form = screen.getByTestId("project-form");

    fireEvent.change(within(form).getByLabelText("Название проекта"), {
      target: { value: "Проект с доски" },
    });
    fireEvent.change(within(form).getByLabelText("Описание (Markdown)"), {
      target: { value: "Описание" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать проект" }));

    await waitFor(() => {
      expect(screen.queryByTestId("project-form")).toBeNull();
    });

    const create = operations.calls.find(
      (call) => call.operationId === "kanbaner.tasks.project.create",
    );

    expect(inputOf(create?.input ?? {})).toMatchObject({
      title: "Проект с доски",
      descriptionMarkdown: "Описание",
    });
    expect(operations.counts.get("kanbaner.tasks.project.list")).toBeGreaterThan(1);
    expect(
      screen.getByTestId("kanban-filters").querySelector('select[name="projectId"]'),
    ).toHaveValue("project-1");
  });

  it("создаёт задачу из колонки с project/status/parent без ручной позиции", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1", "Первый")],
      tasks: [makeTask("root-1", { projectId: "project-1", title: "Родитель" })],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task-done")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1" });
    });

    fireEvent.click(screen.getByTestId("kanban-create-task-done"));

    const form = taskForm();

    await waitFor(() => {
      expect(within(form).getByRole("option", { name: "Родитель" })).toBeInTheDocument();
    });

    fireEvent.change(within(form).getByLabelText("Название", { exact: true }), {
      target: { value: "Новая с доски" },
    });
    fireEvent.change(within(form).getByLabelText("Теги через запятую"), {
      target: { value: "release, kanban" },
    });
    fireEvent.change(within(form).getByLabelText("Родительская задача"), {
      target: { value: "root-1" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать задачу" }));

    await waitFor(() => {
      expect(screen.queryByTestId("task-form-create")).toBeNull();
    });

    const create = operations.calls.find(
      (call) => call.operationId === "kanbaner.tasks.task.create",
    );
    const input = inputOf(create?.input ?? {});

    expect(input).toMatchObject({
      projectId: "project-1",
      title: "Новая с доски",
      status: "done",
      parentTaskId: "root-1",
      tags: ["release", "kanban"],
    });
    expect(input).not.toHaveProperty("position");
    expect(input).not.toHaveProperty("expectedVersion");

    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-done")).getByText("Новая с доски"),
      ).toBeVisible();
    });
  });

  it("оставляет форму открытой с введёнными значениями при ошибке", async () => {
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
      expect(screen.getByTestId("kanban-create-task-todo")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("kanban-create-task-todo"));

    const form = taskForm();
    const title = within(form).getByLabelText("Название", { exact: true });

    fireEvent.change(within(form).getByLabelText("Проект"), {
      target: { value: "project-1" },
    });
    fireEvent.change(title, { target: { value: "Не потерять ввод" } });
    fireEvent.change(within(form).getByLabelText("Описание (Markdown)"), {
      target: { value: "Черновик" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать задачу" }));

    await waitFor(() => {
      expect(within(form).getByRole("alert")).toHaveTextContent("Сервер недоступен");
    });

    expect(screen.getByTestId("task-form-create")).toBe(form);
    expect(title).toHaveValue("Не потерять ввод");
    expect(within(form).getByLabelText("Описание (Markdown)")).toHaveValue("Черновик");
    expect(within(form).getByRole("button", { name: "Создать задачу" })).toBeEnabled();
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
      expect(screen.getByTestId("kanban-create-task-todo")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("kanban-create-task-todo"));

    const form = taskForm();
    const submit = within(form).getByRole("button", { name: "Создать задачу" });

    fireEvent.change(within(form).getByLabelText("Проект"), {
      target: { value: "project-1" },
    });
    fireEvent.change(within(form).getByLabelText("Название", { exact: true }), {
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
      expect(screen.queryByTestId("task-form-create")).toBeNull();
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

    fireEvent.click(screen.getByTestId("kanban-create-task-backlog"));

    const form = taskForm();

    fireEvent.change(within(form).getByLabelText("Проект"), {
      target: { value: "project-1" },
    });
    fireEvent.change(within(form).getByLabelText("Название", { exact: true }), {
      target: { value: "Одиннадцатая" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать задачу" }));

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
    expect(screen.queryByTestId("kanban-create-project")).toBeNull();
    expect(screen.queryByTestId("kanban-create-task")).toBeNull();
    expect(screen.queryByTestId("kanban-create-task-todo")).toBeNull();

    desktop.unmount();
    setMatchMedia(false);
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    const opener = await screen.findByTestId("kanban-create-task-todo");

    await waitFor(() => {
      expect(opener).toBeEnabled();
    });
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

  it("сохраняет черновик и фокус при mobile → desktop → mobile", async () => {
    const toggleLayout = installMatchMedia(false);
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [makeTask("root-1", { projectId: "project-1", title: "Корень" })],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    const opener = await screen.findByTestId("kanban-create-task-todo");

    await waitFor(() => {
      expect(opener).toBeEnabled();
    });
    opener.focus();
    fireEvent.click(opener);

    let form = taskForm();

    fireEvent.change(within(form).getByLabelText("Проект"), {
      target: { value: "project-1" },
    });

    const parent = within(form).getByLabelText("Родительская задача");

    await waitFor(() => {
      expect(within(parent).getByRole("option", { name: "Корень" })).toBeInTheDocument();
    });
    fireEvent.change(within(form).getByLabelText("Название", { exact: true }), {
      target: { value: "Черновик переживает layout" },
    });
    fireEvent.change(within(form).getByLabelText("Описание (Markdown)"), {
      target: { value: "Описание черновика" },
    });
    fireEvent.change(within(form).getByLabelText("Теги через запятую"), {
      target: { value: "release, draft" },
    });
    fireEvent.change(within(form).getByLabelText("Статус"), {
      target: { value: "in_progress" },
    });
    fireEvent.change(parent, { target: { value: "root-1" } });

    const assertDraft = (): void => {
      const current = taskForm();

      expect(within(current).getByLabelText("Проект")).toHaveValue("project-1");
      expect(within(current).getByLabelText("Название", { exact: true })).toHaveValue(
        "Черновик переживает layout",
      );
      expect(within(current).getByLabelText("Описание (Markdown)")).toHaveValue(
        "Описание черновика",
      );
      expect(within(current).getByLabelText("Теги через запятую")).toHaveValue("release, draft");
      expect(within(current).getByLabelText("Статус")).toHaveValue("in_progress");
      expect(within(current).getByLabelText("Родительская задача")).toHaveValue("root-1");
    };

    act(() => {
      toggleLayout(true);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-create-dialog")).toBeNull();
    });
    expect(screen.getByTestId("kanban-create-panel")).toBeInTheDocument();
    assertDraft();

    // Перед возвратом на mobile фокус явно находится в desktop-форме.
    const desktopTitle = within(taskForm()).getByLabelText("Название", { exact: true });

    desktopTitle.focus();
    expect(document.activeElement).toBe(desktopTitle);

    act(() => {
      toggleLayout(false);
    });

    const dialog = await screen.findByTestId("kanban-create-dialog");

    expect(dialog.tagName).toBe("DIALOG");
    assertDraft();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByTestId("kanban-create-dialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });

    // Новая session создаёт чистый draft с предустановкой колонки.
    fireEvent.click(opener);

    form = taskForm();
    expect(within(form).getByLabelText("Проект")).toHaveValue("");
    expect(within(form).getByLabelText("Название", { exact: true })).toHaveValue("");
    expect(within(form).getByLabelText("Статус")).toHaveValue("todo");
  });

  it("сохраняет фильтр Release, если тег созданной задачи release", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task-todo")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1", tag: "Release" });
    });

    fireEvent.click(screen.getByTestId("kanban-create-task-todo"));

    const form = taskForm();

    fireEvent.change(within(form).getByLabelText("Название", { exact: true }), {
      target: { value: "Релиз с заглавной" },
    });
    fireEvent.change(within(form).getByLabelText("Теги через запятую"), {
      target: { value: "release" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать задачу" }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-todo")).getByText("Релиз с заглавной"),
      ).toBeVisible();
    });
    expect(getKanbanQuerySnapshot().tag).toBe("Release");
  });

  it("сбрасывает реально несовпадающий тег и показывает созданную карточку", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task-todo")).toBeEnabled();
    });

    act(() => {
      updateKanbanQuery({ projectId: "project-1", tag: "Other" });
    });

    fireEvent.click(screen.getByTestId("kanban-create-task-todo"));

    const form = taskForm();

    fireEvent.change(within(form).getByLabelText("Название", { exact: true }), {
      target: { value: "Без чужого тега" },
    });
    fireEvent.change(within(form).getByLabelText("Теги через запятую"), {
      target: { value: "release" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать задачу" }));

    await waitFor(() => {
      expect(getKanbanQuerySnapshot().tag).toBe("");
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("kanban-column-todo")).getByText("Без чужого тега"),
      ).toBeVisible();
    });
  });

  it("не отправляет project.create дважды", async () => {
    const board: FakeBoard = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextProject: 2,
      nextTask: 1,
    };
    const pending = deferred<UiOperationResult>();
    const operations = createOperations(board, {
      "kanbaner.tasks.project.create": () => pending.promise,
    });

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-create-task")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("kanban-create-project"));

    const form = screen.getByTestId("project-form");
    const submit = within(form).getByRole("button", { name: "Создать проект" });

    fireEvent.change(within(form).getByLabelText("Название проекта"), {
      target: { value: "Один проект" },
    });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(form);

    expect(submit).toBeDisabled();
    expect(operations.counts.get("kanbaner.tasks.project.create")).toBe(1);

    const project = makeProject("project-2", "Один проект");

    await act(async () => {
      board.projects = [...board.projects, project];
      pending.resolve(ok({ project }));
      await pending.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("project-form")).toBeNull();
    });
    expect(board.projects.filter((item) => item.title === "Один проект")).toHaveLength(1);
  });
});
