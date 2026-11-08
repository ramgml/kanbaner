import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import { TaskOverlay } from "./ui/task-overlay.tsx";
import { resetKanbanQueryForTests, updateKanbanQuery } from "./ui/query-state.ts";

const project: Project = {
  id: "project-1",
  title: "Проект Trello",
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

interface FakeOperations {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ readonly operationId: string; readonly input: JsonValue }>;
  readonly board: FakeBoard;
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

function getTask(board: FakeBoard, id: string): Task | undefined {
  return board.tasks.find((task) => task.id === id);
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

function createOperations(
  board: FakeBoard,
  overrides: Record<string, Handler> = {},
): FakeOperations {
  const calls: Array<{ operationId: string; input: JsonValue }> = [];
  let created = 0;

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
    "kanbaner.tasks.task.create": (input) => {
      const values = inputOf(input);
      created += 1;
      const task = makeTask(`created-${String(created)}`, {
        projectId: String(values.projectId),
        parentTaskId: typeof values.parentTaskId === "string" ? values.parentTaskId : null,
        title: String(values.title),
        descriptionMarkdown:
          typeof values.descriptionMarkdown === "string" ? values.descriptionMarkdown : "",
        status: (values.status as TaskStatus | undefined) ?? "todo",
        priority: (values.priority as Task["priority"] | undefined) ?? "medium",
        position: board.tasks.length,
      });

      board.tasks = [...board.tasks, task];

      return ok({ task, resource: {}, eventId: "event" });
    },
    "kanbaner.tasks.task.update": (input) => {
      const values = inputOf(input);
      const task = getTask(board, String(values.id));

      if (task === undefined) {
        return fail("NOT_FOUND");
      }

      if (task.version !== values.expectedVersion) {
        return fail("VERSION_CONFLICT");
      }

      const updated: Task = {
        ...task,
        ...(typeof values.title === "string" ? { title: values.title } : {}),
        ...(typeof values.descriptionMarkdown === "string"
          ? { descriptionMarkdown: values.descriptionMarkdown }
          : {}),
        ...(typeof values.priority === "string"
          ? { priority: values.priority as Task["priority"] }
          : {}),
        ...("dueAt" in values ? { dueAt: values.dueAt as string | null } : {}),
        ...(Array.isArray(values.tags) ? { tags: values.tags as string[] } : {}),
        version: task.version + 1,
        updatedAt: TIMESTAMP,
      } as Task;

      board.tasks = board.tasks.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      );

      return ok({ task: updated, resource: {}, eventId: "event" });
    },
    "kanbaner.tasks.task.move": (input) => {
      const values = inputOf(input);
      const task = getTask(board, String(values.id));

      if (task === undefined) {
        return fail("NOT_FOUND");
      }

      if (task.version !== values.expectedVersion) {
        return fail("VERSION_CONFLICT");
      }

      const status = values.status as TaskStatus;
      const updated: Task = {
        ...task,
        status,
        completedAt: status === "done" ? (task.completedAt ?? TIMESTAMP) : null,
        version: task.version + 1,
        updatedAt: TIMESTAMP,
      } as Task;

      board.tasks = board.tasks.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      );

      return ok({ task: updated, resource: {}, eventId: "event" });
    },
    "kanbaner.tasks.task.complete": (input) => {
      const task = getTask(board, String(inputOf(input).id));

      if (task === undefined) {
        return fail("NOT_FOUND");
      }

      const updated: Task = {
        ...task,
        status: "done",
        completedAt: TIMESTAMP,
        version: task.version + 1,
        updatedAt: TIMESTAMP,
      } as Task;

      board.tasks = board.tasks.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      );

      return ok({ task: updated, resource: {}, eventId: "event" });
    },
    "kanbaner.tasks.task.delete": (input) => {
      const id = String(inputOf(input).id);

      board.tasks = board.tasks.filter((task) => task.id !== id);

      return ok(null);
    },
  };

  const invoke: UiOperationInvoker = async (operationId, input) => {
    calls.push({ operationId, input });
    const handler = overrides[operationId] ?? defaults[operationId];

    if (handler === undefined) {
      return fail("NOT_FOUND", `Нет обработчика ${operationId}`);
    }

    return handler(input);
  };

  return { invoke, calls, board };
}

function setDesktopViewport(desktop: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: desktop,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

function renderOverlay(operations: FakeOperations) {
  return render(
    <>
      <KanbanView invoke={operations.invoke} />
      <TaskOverlay invoke={operations.invoke} pathname="/view/kanban" />
    </>,
  );
}

async function openTask(taskId: string): Promise<void> {
  await screen.findByTestId(`kanban-card-${taskId}`);
  fireEvent.click(screen.getByTestId(`kanban-open-${taskId}`));
  await waitFor(() => {
    expect(screen.getByTestId("kanban-modal-title")).toBeInTheDocument();
  });
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  window.history.replaceState(null, "", "/view/kanban");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
});

describe("TaskOverlay Trello-модал", () => {
  it("на desktop показывает центрированный modal с двумя колонками и закрывает по X", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", {
          title: "Задача A",
          status: "in_progress",
          descriptionMarkdown: "Строка один\nСтрока два",
          tags: ["release"],
          dueAt: "2030-01-10T00:00:00.000Z",
        }),
      ],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    const modal = screen.getByTestId("kanban-details");

    expect(modal.tagName).not.toBe("DIALOG");
    expect(modal).toHaveAttribute("data-variant", "desktop");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    expect(screen.getByTestId("kanban-modal-project")).toHaveTextContent("Проект Trello");
    expect(screen.getByTestId("kanban-modal-status")).toHaveTextContent("В работе");
    expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent("Строка один");
    expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent("Строка два");
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-01-10");
    expect(screen.getByTestId("kanban-modal-tags")).toHaveValue("release");
    expect(screen.getByTestId("kanban-modal-move-field")).toBeInTheDocument();
    expect(screen.getByTestId("task-delete")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("kanban-details-close"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(window.location.search).not.toContain("task=");
  });

  it("при переходе A→B не показывает устаревшую задачу и не выполняет её команды", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let releaseB: ((result: UiOperationResult) => void) | null = null;
    const bLoad = new Promise<UiOperationResult>((resolve) => {
      releaseB = resolve;
    });
    const operations = createOperations(board, {
      "kanbaner.tasks.task.get": (input) => {
        const id = String(inputOf(input).id);

        if (id === "b") {
          return bLoad;
        }

        const found = getTask(board, id);

        return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
      },
    });

    renderOverlay(operations);
    await openTask("a");
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("task-ui-loading")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("kanban-modal-title")).toBeNull();
    expect(screen.queryByText("Завершить")).toBeNull();
    expect(
      operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.complete"),
    ).toBe(false);

    await act(async () => {
      releaseB?.(ok({ task: getTask(board, "b") as Task }));
      await bLoad;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-complete"));

    await waitFor(() => {
      const last = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.complete")
        .at(-1);

      expect(inputOf(last?.input ?? {})).toMatchObject({ id: "b" });
    });
  });

  it("создаёт подзадачу у корня, открывает её и возвращается к родителю", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("parent", { title: "Родитель", status: "todo" }),
        makeTask("child", {
          title: "Существующая подзадача",
          status: "backlog",
          parentTaskId: "parent",
          position: 1,
        }),
      ],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("parent");

    const subtaskList = await screen.findByTestId("kanban-modal-subtasks");

    expect(within(subtaskList).getByTestId("kanban-subtask-child")).toHaveTextContent(
      "Существующая подзадача",
    );
    expect(within(subtaskList).getByTestId("kanban-subtask-child")).toHaveTextContent("Бэклог");

    fireEvent.click(screen.getByTestId("kanban-subtask-create"));
    fireEvent.change(screen.getByTestId("kanban-subtask-input"), {
      target: { value: "Новая подзадача" },
    });
    fireEvent.change(
      within(screen.getByTestId("kanban-subtask-form")).getByRole("combobox", {
        name: "Статус подзадачи",
      }),
      { target: { value: "in_progress" } },
    );
    fireEvent.click(screen.getByTestId("kanban-subtask-submit"));

    await waitFor(() => {
      const create = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.create")
        .at(-1);

      expect(inputOf(create?.input ?? {})).toMatchObject({
        projectId: "project-1",
        parentTaskId: "parent",
        title: "Новая подзадача",
        status: "in_progress",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtask-created-1")).toHaveTextContent("Новая подзадача");
    });

    fireEvent.click(screen.getByTestId("kanban-subtask-child"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Существующая подзадача");
    });
    expect(screen.queryByTestId("kanban-subtask-create")).toBeNull();
    expect(screen.getByTestId("kanban-modal-parent")).toHaveTextContent("Родитель");

    fireEvent.click(screen.getByTestId("kanban-modal-parent"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Родитель");
    });
    expect(screen.getByTestId("kanban-subtask-create")).toBeInTheDocument();
  });

  it("не теряет черновик при Escape и закрывает только после явного подтверждения", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-edit"));

    const form = await screen.findByTestId("task-form-edit");
    const title = within(form).getByLabelText("Название");

    fireEvent.change(title, { target: { value: "Новый заголовок" } });
    fireEvent.keyDown(window, { key: "Escape" });

    const confirm = await screen.findByTestId("kanban-draft-confirm");

    expect(confirm).toHaveTextContent("несохранённые изменения");
    expect(screen.getByTestId("kanban-details")).toBeInTheDocument();
    expect(within(form).getByLabelText("Название")).toHaveValue("Новый заголовок");
    expect(window.location.search).toContain("task=a");

    fireEvent.click(screen.getByTestId("kanban-draft-keep"));
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    expect(within(form).getByLabelText("Название")).toHaveValue("Новый заголовок");

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(await screen.findByTestId("kanban-draft-discard"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(window.location.search).not.toContain("task=");

    await openTask("a");
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
  });

  it("сохраняет редактирование через expectedVersion и перечитывает задачу", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-edit"));

    const form = await screen.findByTestId("task-form-edit");

    fireEvent.change(within(form).getByLabelText("Название"), {
      target: { value: "Обновлённая задача" },
    });
    fireEvent.change(form.querySelector('textarea[name="descriptionMarkdown"]') as Element, {
      target: { value: "Новое описание" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Сохранить задачу" }));

    await waitFor(() => {
      const update = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.update")
        .at(-1);

      expect(inputOf(update?.input ?? {})).toMatchObject({
        id: "a",
        expectedVersion: 1,
        title: "Обновлённая задача",
        descriptionMarkdown: "Новое описание",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Обновлённая задача");
    });
    expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent("Новое описание");
    expect(board.tasks.find((task) => task.id === "a")?.version).toBe(2);
  });

  it("при VERSION_CONFLICT показывает сообщение и перечитывает серверную версию", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () => {
        // Другая вкладка уже переименовала задачу и повысила версию.
        board.tasks = board.tasks.map((task) =>
          task.id === "a" ? { ...task, title: "Серверная версия", version: 2 } : task,
        );

        return fail("VERSION_CONFLICT");
      },
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-edit"));

    const form = await screen.findByTestId("task-form-edit");

    fireEvent.change(within(form).getByLabelText("Название"), {
      target: { value: "Локальная правка" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Сохранить задачу" }));

    await waitFor(() => {
      expect(screen.getByTestId("task-details-error")).toHaveTextContent(
        "Задача уже изменена в другом месте",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Серверная версия");
    });
    expect(
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update"),
    ).toHaveLength(1);
  });

  it("удаляет задачу только после inline-подтверждения", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("task-delete"));

    expect(screen.getByTestId("task-delete-confirm-panel")).toBeInTheDocument();
    expect(operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.delete")).toBe(
      false,
    );

    fireEvent.click(screen.getByTestId("task-delete-cancel"));
    expect(screen.queryByTestId("task-delete-confirm-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("task-delete"));
    fireEvent.click(screen.getByTestId("task-delete-confirm"));

    await waitFor(() => {
      const remove = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.delete")
        .at(-1);

      expect(inputOf(remove?.input ?? {})).toMatchObject({
        id: "a",
        expectedVersion: 1,
        confirm: true,
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(board.tasks.some((task) => task.id === "a")).toBe(false);
  });
});
