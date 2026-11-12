import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  normalizeTags,
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

function columnForStatus(board: FakeBoard, projectId: string, status: TaskStatus): TaskColumn {
  const column = boardColumns(board, projectId).find((entry) => entry.status === status);

  if (column === undefined) {
    throw new Error(`Нет колонки со статусом ${status}`);
  }

  return column;
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
    "kanbaner.tasks.column.list": (input) => {
      const projectId = String(inputOf(input).projectId);
      const columns = boardColumns(board, projectId);

      return ok({ items: [...columns], total: columns.length, nextOffset: null });
    },
    "kanbaner.tasks.task.get": (input) => {
      const found = getTask(board, String(inputOf(input).id));

      return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
    },
    "kanbaner.tasks.task.create": (input) => {
      const values = inputOf(input);
      created += 1;
      const projectId = String(values.projectId);
      const requestedColumnId = typeof values.columnId === "string" ? values.columnId : undefined;
      const fallbackStatus = (values.status as TaskStatus | undefined) ?? "todo";
      const resolvedColumn =
        requestedColumnId === undefined ? columnForStatus(board, projectId, fallbackStatus) : null;
      const columnId = requestedColumnId ?? resolvedColumn?.id;
      const task = makeTask(`created-${String(created)}`, {
        projectId,
        ...(columnId === undefined ? {} : { columnId }),
        parentTaskId: typeof values.parentTaskId === "string" ? values.parentTaskId : null,
        title: String(values.title),
        descriptionMarkdown:
          typeof values.descriptionMarkdown === "string" ? values.descriptionMarkdown : "",
        status: columnId === undefined ? fallbackStatus : columnStatus(board, projectId, columnId),
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
        ...(Array.isArray(values.tags)
          ? { tags: [...normalizeTags(values.tags as readonly string[])] }
          : {}),
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

      const columnId = typeof values.columnId === "string" ? values.columnId : undefined;
      const status =
        columnId === undefined
          ? (values.status as TaskStatus)
          : columnStatus(board, task.projectId, columnId);
      const updated: Task = {
        ...task,
        status,
        ...(columnId === undefined ? {} : { columnId }),
        completedAt: status === "done" ? (task.completedAt ?? TIMESTAMP) : null,
        version: task.version + 1,
        updatedAt: TIMESTAMP,
      } as Task;

      if (
        updated.columnId !== undefined &&
        columnStatus(board, updated.projectId, updated.columnId) !== updated.status
      ) {
        throw new Error(`Нарушено зеркало status/columnId для ${updated.id}`);
      }

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
        columnId: columnIdFor(task.projectId, "done"),
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

function touchTap(element: HTMLElement, x = 12, y = 12): void {
  fireEvent.pointerDown(element, {
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
  fireEvent.pointerUp(element, {
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
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

    expect(modal.tagName).toBe("DIALOG");
    expect(modal).toHaveAttribute("data-variant", "desktop");
    expect(modal).toHaveAttribute("aria-label", "Детали задачи");
    expect(modal).toHaveAttribute("open");
    expect((modal as HTMLDialogElement).open).toBe(true);
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

  it("очищает ошибку чтения после retry, не смешивая её с командной", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    let failGet = true;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.get": (input) => {
        if (failGet) {
          return fail("INTERNAL", "Ошибка чтения");
        }

        const found = getTask(board, String(inputOf(input).id));

        return found === undefined ? fail("NOT_FOUND") : ok({ task: found });
      },
    });

    renderOverlay(operations);
    act(() => {
      updateKanbanQuery({ taskId: "a" });
    });

    expect(await screen.findByTestId("task-ui-error")).toHaveTextContent("Ошибка чтения");

    failGet = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    });
    expect(screen.queryByTestId("task-ui-error")).toBeNull();
    expect(screen.queryByTestId("task-details-error")).toBeNull();
  });

  it("не показывает переключатель внутри модала, оставляя его в шапке", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    expect(screen.queryByTestId("project-view-modal-list")).toBeNull();
    expect(screen.queryByTestId("project-view-modal-kanban")).toBeNull();
    expect(screen.queryByTestId("kanban-modal-edit")).toBeNull();
    expect(screen.getByTestId("project-view-list")).toBeInTheDocument();
    expect(screen.getByTestId("project-view-kanban")).toHaveAttribute("aria-pressed", "true");
  });

  it("не теряет quick draft и inline draft, переключатель остаётся только в шапке", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    const headerToggle = screen.getByTestId("project-view-list");

    expect(headerToggle).toBeInTheDocument();
    expect(screen.queryByTestId("project-view-modal-list")).toBeNull();

    const move = screen.getByTestId("kanban-modal-move-field");

    fireEvent.change(move, { target: { value: "column-project-1-legacy-in_progress" } });
    expect(move).toHaveValue("column-project-1-legacy-in_progress");

    const due = screen.getByTestId("kanban-modal-due");

    fireEvent.change(due, { target: { value: "2030-05-05" } });
    expect(due).toHaveValue("2030-05-05");

    const tags = screen.getByTestId("kanban-modal-tags");

    fireEvent.change(tags, { target: { value: "release" } });
    expect(tags).toHaveValue("release");

    fireEvent.click(screen.getByTestId("kanban-subtask-create"));

    const subtaskTitle = screen.getByTestId("kanban-subtask-input");

    fireEvent.change(subtaskTitle, { target: { value: "Новая подзадача" } });
    expect(subtaskTitle).toHaveValue("Новая подзадача");

    // Закрытие с этим черновиком требует подтверждения, а не теряет ввод.
    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });
    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
    expect(subtaskTitle).toHaveValue("Новая подзадача");
    fireEvent.click(screen.getByTestId("kanban-draft-keep"));

    fireEvent.click(screen.getByTestId("kanban-subtask-cancel"));

    // Inline-редактор заголовка открывается поверх быстрых полей.
    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    expect(titleInput.tagName).toBe("TEXTAREA");
    fireEvent.change(titleInput, { target: { value: "Первая строка\nвторая строка" } });
    expect(titleInput).toHaveValue("Первая строка вторая строка");
    fireEvent.change(titleInput, { target: { value: "Новый заголовок" } });
    expect(screen.queryByTestId("project-view-modal-list")).toBeNull();
    expect(headerToggle).toBeInTheDocument();

    // Escape внутри редактора отменяет только его, а не модал.
    fireEvent.keyDown(titleInput, { key: "Escape" });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    expect(screen.getByTestId("kanban-details")).toBeInTheDocument();

    // X запускает autosave inline, но подтверждение остаётся из-за quick drafts.
    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const dirtyTitle = await screen.findByTestId("kanban-title-input");

    fireEvent.change(dirtyTitle, { target: { value: "Черновик заголовка" } });
    fireEvent.click(screen.getByTestId("kanban-details-close"));
    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("kanban-draft-keep"));
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Черновик заголовка");
    });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();
    expect(screen.queryByTestId("project-view-modal-list")).toBeNull();
    expect(headerToggle).toBeInTheDocument();
  });

  it("открывает редактор одинарным кликом, но не после выделения текста", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };

    renderOverlay(createOperations(board));
    await openTask("a");

    const title = screen.getByTestId("kanban-modal-title");
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      anchorNode: title.firstChild,
      focusNode: title.firstChild,
    } as Selection);

    fireEvent.click(title);
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();

    selection.mockReturnValue({
      isCollapsed: true,
      anchorNode: null,
      focusNode: null,
    } as Selection);
    fireEvent.click(title);
    expect(await screen.findByTestId("kanban-title-input")).toBeInTheDocument();
    selection.mockRestore();
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
        name: "Колонка подзадачи",
      }),
      { target: { value: "column-project-1-legacy-in_progress" } },
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
        columnId: "column-project-1-legacy-in_progress",
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

  it("Escape отменяет inline-редактор, а X автосохраняет черновик и закрывает карточку", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    const display = screen.getByTestId("kanban-modal-title");

    // Клавиатурный путь: Tab на заголовок, Enter открывает редактор.
    display.focus();
    expect(document.activeElement).toBe(display);
    fireEvent.keyDown(display, { key: "Enter" });

    const titleInput = await screen.findByTestId("kanban-title-input");

    expect(document.activeElement).toBe(titleInput);
    fireEvent.change(titleInput, { target: { value: "Новый заголовок" } });

    // Escape — только отмена редактора: native dialog не закрывается и
    // подтверждение закрытия не появляется.
    fireEvent.keyDown(titleInput, { key: "Escape" });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    expect(screen.getByTestId("kanban-details")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    expect(document.activeElement).toBe(screen.getByTestId("kanban-modal-title"));
    expect(window.location.search).toContain("task=a");

    // X сначала запускает autosave, поэтому отдельное подтверждение для
    // единственного inline-черновика больше не требуется.
    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const dirtyInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(dirtyInput, { target: { value: "Черновик заголовка" } });
    fireEvent.blur(dirtyInput, {
      relatedTarget: screen.getByTestId("kanban-details-close"),
    });
    fireEvent.click(screen.getByTestId("kanban-details-close"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    expect(window.location.search).not.toContain("task=");
    expect(board.tasks.find((task) => task.id === "a")?.title).toBe("Черновик заголовка");

    await openTask("a");
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Черновик заголовка");
  });

  it("сохраняет title и description строго partial и возвращает фокус", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);
    const updateCalls = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update");

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "  Обновлённая задача  " } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(inputOf(updateCalls().at(-1)?.input ?? {})).toEqual({
        id: "a",
        expectedVersion: 1,
        title: "Обновлённая задача",
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Обновлённая задача");
    });
    expect(document.activeElement).toBe(screen.getByTestId("kanban-modal-title"));

    fireEvent.click(screen.getByTestId("kanban-modal-description"));

    const descriptionInput = await screen.findByTestId("kanban-description-input");

    expect(document.activeElement).toBe(descriptionInput);
    expect(descriptionInput).toHaveClass("resize-none", "overflow-hidden");
    fireEvent.change(descriptionInput, {
      target: { value: "Новое описание\nвторая строка" },
    });
    fireEvent.keyDown(descriptionInput, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(inputOf(updateCalls().at(-1)?.input ?? {})).toEqual({
        id: "a",
        expectedVersion: 2,
        descriptionMarkdown: "Новое описание\nвторая строка",
      });
    });

    // В команде нет ни одного незатронутого поля.
    expect(Object.keys(inputOf(updateCalls().at(-1)?.input ?? {})).sort()).toEqual([
      "descriptionMarkdown",
      "expectedVersion",
      "id",
    ]);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent("Новое описание");
    });
    expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent("вторая строка");
    expect(document.activeElement).toBe(screen.getByTestId("kanban-modal-description"));
    expect(board.tasks.find((task) => task.id === "a")?.version).toBe(3);

    // Описание можно очистить до пустого значения.
    fireEvent.click(screen.getByTestId("kanban-modal-description"));

    const emptyInput = await screen.findByTestId("kanban-description-input");

    fireEvent.change(emptyInput, { target: { value: "" } });
    fireEvent.keyDown(emptyInput, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(inputOf(updateCalls().at(-1)?.input ?? {})).toEqual({
        id: "a",
        expectedVersion: 3,
        descriptionMarkdown: "",
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent(
        "Добавить описание…",
      );
    });
  });

  it("сохраняет title и description при уходе фокуса из редактора", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);
    const updateCalls = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update");

    renderOverlay(operations);
    await openTask("a");
    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Сохранено кликом снаружи" } });
    fireEvent.pointerDown(screen.getByTestId("kanban-modal-project"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent(
        "Сохранено кликом снаружи",
      );
    });
    expect(updateCalls()).toHaveLength(1);

    fireEvent.click(screen.getByTestId("kanban-modal-description"));

    const descriptionInput = await screen.findByTestId("kanban-description-input");
    const priority = screen.getByTestId("kanban-modal-priority");

    fireEvent.change(descriptionInput, {
      target: { value: "Описание сохранено кликом снаружи" },
    });
    priority.focus();
    fireEvent.blur(descriptionInput, { relatedTarget: priority });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent(
        "Описание сохранено кликом снаружи",
      );
    });
    expect(updateCalls()).toHaveLength(2);
    expect(document.activeElement).toBe(priority);
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

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Локальная правка" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("task-details-error")).toHaveTextContent(
        "Задача уже изменена в другом месте",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Серверная версия");
    });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();
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

  it("сохраняет draft при stale refresh и не перезаписывает серверную правку", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const title = await screen.findByTestId("kanban-title-input");

    fireEvent.change(title, { target: { value: "Локальная правка" } });

    // Другая вкладка обновила задачу, а карточка успела перечитать сервер.
    board.tasks = board.tasks.map((task) =>
      task.id === "a" ? { ...task, title: "Серверная версия", version: 2 } : task,
    );

    act(() => {
      bumpKanbanRevision();
    });

    const stale = await screen.findByTestId("kanban-inline-stale");

    expect(stale).toBeInTheDocument();
    expect(title).toHaveValue("Локальная правка");
    expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    expect(screen.queryByTestId("kanban-modal-title")).toBeNull();

    fireEvent.keyDown(title, { key: "Enter" });

    await waitFor(() => {
      const update = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.update")
        .at(-1);

      expect(inputOf(update?.input ?? {})).toEqual({
        id: "a",
        expectedVersion: 1,
        title: "Локальная правка",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("task-details-error")).toHaveTextContent(
        "Задача уже изменена в другом месте",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Серверная версия");
    });

    expect(screen.queryByTestId("kanban-title-input")).toBeNull();
    expect(board.tasks.find((task) => task.id === "a")).toMatchObject({
      title: "Серверная версия",
      version: 2,
    });
  });

  it("сохраняет черновики срока, тегов, статуса и подзадачи после чужой команды", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-05-05" },
    });
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    // Успешная команда по приоритету поднимает версию и перечитывает задачу.
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");

    fireEvent.change(screen.getByTestId("kanban-modal-tags"), {
      target: { value: "alpha, beta" },
    });
    fireEvent.change(screen.getByTestId("kanban-modal-move-field"), {
      target: { value: "column-project-1-legacy-in_progress" },
    });
    fireEvent.click(screen.getByTestId("kanban-subtask-create"));
    fireEvent.change(screen.getByTestId("kanban-subtask-input"), {
      target: { value: "Черновик подзадачи" },
    });

    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });

    const confirm = await screen.findByTestId("kanban-draft-confirm");

    expect(confirm).toBeInTheDocument();
    expect(confirm.contains(document.activeElement)).toBe(true);

    const discard = screen.getByTestId("kanban-draft-discard");
    const keep = screen.getByTestId("kanban-draft-keep");

    discard.focus();
    fireEvent.keyDown(confirm, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(keep);

    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(discard);

    fireEvent.click(keep);

    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");
    expect(screen.getByTestId("kanban-modal-tags")).toHaveValue("alpha, beta");
    expect(screen.getByTestId("kanban-modal-move-field")).toHaveValue(
      "column-project-1-legacy-in_progress",
    );
    expect(screen.getByTestId("kanban-subtask-input")).toHaveValue("Черновик подзадачи");
    expect(document.activeElement).toBe(screen.getByTestId("kanban-modal-due"));

    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });
    fireEvent.click(await screen.findByTestId("kanban-draft-discard"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(window.location.search).not.toContain("task=");
  });

  it("дочитывает подзадачи после границы 200 и показывает созданную в конце", async () => {
    setDesktopViewport(true);
    const subtasks = Array.from({ length: 250 }, (_, index) =>
      makeTask(`sub-${index}`, {
        title: `Подзадача ${index}`,
        parentTaskId: "parent",
        position: index,
      }),
    );
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("parent", { title: "Родитель", status: "todo" }), ...subtasks],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("parent");

    const list = await screen.findByTestId("kanban-modal-subtasks");

    await waitFor(() => {
      expect(within(list).getAllByRole("button")).toHaveLength(250);
    });
    expect(screen.getByTestId("kanban-subtask-sub-249")).toBeInTheDocument();

    const listCalls = operations.calls.filter(
      (call) =>
        call.operationId === "kanbaner.tasks.task.list" &&
        inputOf(call.input).parentTaskId === "parent",
    );

    expect(listCalls.length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByTestId("kanban-subtask-create"));
    fireEvent.change(screen.getByTestId("kanban-subtask-input"), {
      target: { value: "После границы" },
    });
    fireEvent.click(screen.getByTestId("kanban-subtask-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtask-created-1")).toHaveTextContent("После границы");
    });
  });

  it("передаёт expectedVersion и patch для приоритета, срока, тегов и завершения", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    const updateCalls = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update");

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(inputOf(updateCalls().at(-1)?.input ?? {})).toEqual({
        id: "a",
        expectedVersion: 1,
        priority: "high",
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-07-01" },
    });
    fireEvent.click(screen.getByTestId("kanban-modal-due-save"));

    await waitFor(() => {
      expect(inputOf(updateCalls().at(-1)?.input ?? {})).toEqual({
        id: "a",
        expectedVersion: 2,
        dueAt: "2030-07-01T00:00:00.000Z",
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "3");
    });

    fireEvent.change(screen.getByTestId("kanban-modal-tags"), {
      target: { value: "alpha, beta" },
    });
    fireEvent.click(screen.getByTestId("kanban-modal-tags-save"));

    await waitFor(() => {
      expect(inputOf(updateCalls().at(-1)?.input ?? {})).toEqual({
        id: "a",
        expectedVersion: 3,
        tags: ["alpha", "beta"],
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "4");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-complete"));

    await waitFor(() => {
      const complete = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.complete")
        .at(-1);

      expect(inputOf(complete?.input ?? {})).toEqual({ id: "a", expectedVersion: 4 });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-status")).toHaveTextContent("Готово");
    });
  });

  it("не отправляет вторую команду, пока первая выполняется", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    let release: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () =>
        new Promise<UiOperationResult>((resolve) => {
          release = () => {
            const task = getTask(board, "a") as Task;
            const updated: Task = { ...task, priority: "high", version: 2 } as Task;

            board.tasks = board.tasks.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            );
            resolve(ok({ task: updated, resource: {}, eventId: "event" }));
          };
        }),
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "low" },
    });
    fireEvent.click(screen.getByTestId("kanban-modal-complete"));

    expect(
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update"),
    ).toHaveLength(1);
    expect(
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.complete"),
    ).toHaveLength(0);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toHaveValue("high");
    });
    expect(
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update"),
    ).toHaveLength(1);
  });

  it("при ошибке команды не теряет введённый срок и требует подтверждения", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () => fail("INTERNAL", "Сервер недоступен"),
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-08-08" },
    });
    fireEvent.click(screen.getByTestId("kanban-modal-due-save"));

    await waitFor(() => {
      expect(screen.getByTestId("task-details-error")).toHaveTextContent("Сервер недоступен");
    });

    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-08-08");
    expect(board.tasks.find((task) => task.id === "a")?.version).toBe(1);

    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });

    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
  });

  it("показывает перечитанное серверное состояние, а не ответ команды", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": (input) => {
        const values = inputOf(input);
        const task = getTask(board, "a") as Task;
        const updated: Task = {
          ...task,
          priority: values.priority as Task["priority"],
          title: "Серверное состояние",
          version: task.version + 1,
        } as Task;

        board.tasks = board.tasks.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );

        return ok({
          task: { ...updated, title: "Ответ команды" },
          resource: {},
          eventId: "event",
        });
      },
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Серверное состояние");
    });
    expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    expect(screen.queryByText("Ответ команды")).toBeNull();
  });

  it("сохраняет dirty due/tags при внешнем изменении тех же полей и даёт взять серверные", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-05-05" },
    });
    fireEvent.change(screen.getByTestId("kanban-modal-tags"), {
      target: { value: "Alpha, beta" },
    });

    // Другая вкладка изменила те же поля, а карточка пока об этом не знает.
    board.tasks = board.tasks.map((task) =>
      task.id === "a" ? { ...task, dueAt: "2031-01-01T00:00:00.000Z", tags: ["server-tag"] } : task,
    );

    // Безопасная команда по другому полю перечитывает задачу.
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });

    const conflictBanner = await screen.findByTestId("kanban-quick-conflict");

    expect(conflictBanner).toHaveTextContent("срок");
    expect(conflictBanner).toHaveTextContent("теги");
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");
    expect(screen.getByTestId("kanban-modal-tags")).toHaveValue("Alpha, beta");

    fireEvent.click(screen.getByTestId("kanban-quick-conflict-rebase"));

    expect(screen.queryByTestId("kanban-quick-conflict")).toBeNull();
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2031-01-01");
    expect(screen.getByTestId("kanban-modal-tags")).toHaveValue("server-tag");

    // После явного rebase черновик чистый: закрытие без подтверждения.
    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
  });

  it("при конфликте quick draft позволяет оставить локальные значения", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-05-05" },
    });

    board.tasks = board.tasks.map((task) =>
      task.id === "a" ? { ...task, dueAt: "2031-01-01T00:00:00.000Z" } : task,
    );

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });
    expect(await screen.findByTestId("kanban-quick-conflict")).toHaveTextContent("срок");

    fireEvent.click(screen.getByTestId("kanban-quick-conflict-keep"));

    expect(screen.queryByTestId("kanban-quick-conflict")).toBeNull();
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");

    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });

    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("kanban-draft-discard"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
  });

  it("при rebase применяет серверные значения только к конфликтным полям", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-05-05" },
    });
    fireEvent.change(screen.getByTestId("kanban-modal-tags"), {
      target: { value: "Alpha, beta" },
    });
    fireEvent.change(screen.getByTestId("kanban-modal-move-field"), {
      target: { value: "column-project-1-legacy-in_progress" },
    });

    // Внешне изменился только срок; статус и теги на сервере не менялись.
    board.tasks = board.tasks.map((task) =>
      task.id === "a" ? { ...task, dueAt: "2031-01-01T00:00:00.000Z" } : task,
    );

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });

    const conflictBanner = await screen.findByTestId("kanban-quick-conflict");

    expect(conflictBanner).toHaveTextContent("срок");
    expect(conflictBanner).not.toHaveTextContent("теги");
    expect(conflictBanner).not.toHaveTextContent("статус");

    fireEvent.click(screen.getByTestId("kanban-quick-conflict-rebase"));

    expect(screen.queryByTestId("kanban-quick-conflict")).toBeNull();
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2031-01-01");
    expect(screen.getByTestId("kanban-modal-tags")).toHaveValue("Alpha, beta");
    expect(screen.getByTestId("kanban-modal-move-field")).toHaveValue(
      "column-project-1-legacy-in_progress",
    );

    // Неконфликтные dirty-поля остались, поэтому закрытие требует confirm.
    fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });

    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-modal-tags")).toHaveValue("Alpha, beta");
    expect(screen.getByTestId("kanban-modal-move-field")).toHaveValue(
      "column-project-1-legacy-in_progress",
    );

    fireEvent.click(screen.getByTestId("kanban-draft-discard"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
  });

  it("валидирует пустое название и закрывает unchanged без команды", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);
    const updateCount = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update").length;

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "   " } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    expect(screen.getByTestId("kanban-inline-error")).toHaveTextContent("Укажите название задачи");
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("   ");
    expect(updateCount()).toBe(0);
    expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "1");

    // trim делает значение неизменённым: команда не отправляется.
    fireEvent.change(titleInput, { target: { value: "  Задача A  " } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    expect(screen.queryByTestId("kanban-title-input")).toBeNull();
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    expect(updateCount()).toBe(0);
    expect(board.tasks.find((task) => task.id === "a")?.version).toBe(1);
  });

  it("при обычной ошибке сохранения сохраняет ввод и не теряет редактор", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () => fail("INTERNAL", "Сервер недоступен"),
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Несохранённый заголовок" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("task-details-error")).toHaveTextContent("Сервер недоступен");
    });
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Несохранённый заголовок");
    expect(screen.getByTestId("kanban-details")).toBeInTheDocument();
    expect(board.tasks.find((task) => task.id === "a")?.version).toBe(1);

    // Dirty draft по-прежнему участвует в close guard.
    fireEvent.click(screen.getByTestId("kanban-details-close"));
    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("kanban-draft-keep"));
    fireEvent.keyDown(screen.getByTestId("kanban-title-input"), { key: "Escape" });
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
  });

  it("не даёт второму редактору молча выбросить dirty draft", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик заголовка" } });
    fireEvent.click(screen.getByTestId("kanban-modal-description"));

    expect(screen.queryByTestId("kanban-description-input")).toBeNull();
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик заголовка");
    expect(screen.getByTestId("kanban-inline-error")).toHaveTextContent(
      "Сначала сохраните или отмените изменение",
    );

    fireEvent.keyDown(screen.getByTestId("kanban-title-input"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("kanban-modal-description"));

    expect(await screen.findByTestId("kanban-description-input")).toBeInTheDocument();
  });

  it("открывает оба редактора touch-тапом и клавишей F2", async () => {
    setDesktopViewport(false);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    touchTap(screen.getByTestId("kanban-modal-title"));
    expect(await screen.findByTestId("kanban-title-input")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("kanban-title-input"), { key: "Escape" });

    touchTap(screen.getByTestId("kanban-modal-description"));
    expect(await screen.findByTestId("kanban-description-input")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("kanban-description-input"), { key: "Escape" });

    const description = screen.getByTestId("kanban-modal-description");

    description.focus();
    fireEvent.keyDown(description, { key: "F2" });
    expect(await screen.findByTestId("kanban-description-input")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("kanban-description-input"), { key: "Escape" });

    const title = screen.getByTestId("kanban-modal-title");

    title.focus();
    fireEvent.keyDown(title, { key: "F2" });
    expect(await screen.findByTestId("kanban-title-input")).toBeInTheDocument();
  });

  it("не открывает редактор после touch drag, второго пальца и pointercancel", async () => {
    setDesktopViewport(false);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    const title = screen.getByTestId("kanban-modal-title");

    // Сдвиг больше порога — это drag, а не tap.
    fireEvent.pointerDown(title, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(title, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 40,
      clientY: 40,
    });
    fireEvent.pointerUp(title, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 40,
      clientY: 40,
    });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();

    // Второй палец отменяет tap.
    fireEvent.pointerDown(title, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerDown(title, {
      pointerType: "touch",
      pointerId: 2,
      isPrimary: false,
      clientX: 30,
      clientY: 30,
    });
    fireEvent.pointerUp(title, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();

    // pointercancel (например, native scroll) сбрасывает tap.
    fireEvent.pointerDown(title, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerCancel(title, { pointerType: "touch", pointerId: 1, isPrimary: true });
    fireEvent.pointerUp(title, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();

    // Долгое удержание (выделение) тоже не считается tap.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      fireEvent.pointerDown(title, {
        pointerType: "touch",
        pointerId: 1,
        isPrimary: true,
        clientX: 10,
        clientY: 10,
      });
      now.mockReturnValue(1_600);
      fireEvent.pointerUp(title, {
        pointerType: "touch",
        pointerId: 1,
        isPrimary: true,
        clientX: 10,
        clientY: 10,
      });
    } finally {
      now.mockRestore();
    }

    expect(screen.queryByTestId("kanban-title-input")).toBeNull();

    // После неудачных жестов обычный tap снова работает.
    touchTap(title);
    expect(await screen.findByTestId("kanban-title-input")).toBeInTheDocument();
  });

  it("Escape завершает только активный редактор, не закрывая dialog", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик" } });
    titleInput.focus();
    fireEvent.keyDown(titleInput, { key: "Escape" });

    expect(screen.queryByTestId("kanban-title-editor")).toBeNull();
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    expect(screen.getByTestId("kanban-details")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const description = screen.getByTestId("kanban-modal-description");

    fireEvent.click(description);

    const descriptionInput = await screen.findByTestId("kanban-description-input");

    fireEvent.change(descriptionInput, { target: { value: "Черновик описания" } });
    descriptionInput.focus();
    fireEvent.keyDown(descriptionInput, { key: "Escape" });

    expect(screen.queryByTestId("kanban-description-editor")).toBeNull();
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    expect(screen.getByTestId("kanban-details")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-modal-description")).toHaveTextContent("Добавить описание…");
  });

  it("конфликт quick priority не удаляет независимый inline draft", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": (input) => {
        const values = inputOf(input);

        if (values.priority !== undefined) {
          board.tasks = board.tasks.map((task) =>
            task.id === "a"
              ? { ...task, title: "Серверная версия", priority: "high", version: 2 }
              : task,
          );

          return fail("VERSION_CONFLICT");
        }

        return fail("UNEXPECTED");
      },
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Локальный черновик" } });
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });
    expect(screen.getByTestId("kanban-inline-stale")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Локальный черновик");
    expect(screen.getByTestId("task-details-error")).toHaveTextContent(
      "Задача уже изменена в другом месте",
    );

    fireEvent.keyDown(screen.getByTestId("kanban-title-input"), { key: "Escape" });
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Серверная версия");
  });

  it("поздняя ошибка A после A→B не показывается на B и не блокирует B", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let releaseA: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": (input) => {
        const values = inputOf(input);
        const id = String(values.id);

        if (id === "a") {
          return new Promise<UiOperationResult>((resolve) => {
            releaseA = () => {
              resolve(fail("INTERNAL", "Поздняя ошибка A"));
            };
          });
        }

        const task = getTask(board, id) as Task;
        const updated: Task = {
          ...task,
          priority: values.priority as Task["priority"],
          version: task.version + 1,
        } as Task;

        board.tasks = board.tasks.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );

        return ok({ task: updated, resource: {}, eventId: "event" });
      },
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeEnabled();
    });

    // B не ждёт A: новая команда проходит, пока ответ A ещё не пришёл.
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "low" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toHaveValue("low");
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });

    await act(async () => {
      releaseA?.();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("task-details-error")).toBeNull();
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    expect(screen.getByTestId("kanban-modal-priority")).toHaveValue("low");
  });

  it("поздний VERSION_CONFLICT A не очищает inline draft и не показывает конфликт на B", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let releaseA: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": (input) => {
        if (String(inputOf(input).id) !== "a") {
          return fail("UNEXPECTED");
        }

        return new Promise<UiOperationResult>((resolve) => {
          releaseA = () => {
            resolve(fail("VERSION_CONFLICT"));
          };
        });
      },
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик B" } });

    await act(async () => {
      releaseA?.();
      await Promise.resolve();
    });

    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик B");
    expect(screen.queryByTestId("kanban-inline-stale")).toBeNull();
    expect(screen.queryByTestId("task-details-error")).toBeNull();
    expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "1");
    expect(screen.queryByTestId("kanban-modal-title")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("kanban-title-input"), { key: "Escape" });
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
  });

  it("поздний success A не очищает inline draft и состояние B", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let releaseA: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": (input) => {
        if (String(inputOf(input).id) !== "a") {
          return fail("UNEXPECTED");
        }

        return new Promise<UiOperationResult>((resolve) => {
          releaseA = () => {
            const task = getTask(board, "a") as Task;
            const updated: Task = { ...task, priority: "high", version: 2 } as Task;

            board.tasks = board.tasks.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            );
            resolve(ok({ task: updated, resource: {}, eventId: "event" }));
          };
        });
      },
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик B" } });

    await act(async () => {
      releaseA?.();
      await Promise.resolve();
    });

    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик B");
    expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "1");
    expect(screen.queryByTestId("task-details-error")).toBeNull();
  });

  it("поздняя ошибка A после A→B→A не применяется (без ABA)", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let releaseA: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () =>
        new Promise<UiOperationResult>((resolve) => {
          releaseA = () => {
            resolve(fail("INTERNAL", "Поздняя ошибка A"));
          };
        }),
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    act(() => {
      updateKanbanQuery({ taskId: "a" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    });

    await act(async () => {
      releaseA?.();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("task-details-error")).toBeNull();
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    expect(screen.getByTestId("kanban-modal-priority")).toHaveValue("medium");
  });

  it("поздний success priority после закрытия модала обновляет доску", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    let release: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () =>
        new Promise<UiOperationResult>((resolve) => {
          release = () => {
            const task = getTask(board, "a") as Task;
            const updated: Task = { ...task, priority: "high", version: 2 } as Task;

            board.tasks = board.tasks.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            );
            resolve(ok({ task: updated, resource: {}, eventId: "event" }));
          };
        }),
    });
    const listCalls = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.list").length;

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("kanban-details-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });

    const before = listCalls();

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(listCalls()).toBeGreaterThan(before);
    });
    expect(board.tasks.find((task) => task.id === "a")?.priority).toBe("high");
  });

  it("поздний delete после A→B обновляет доску и убирает карточку", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let release: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.delete": () =>
        new Promise<UiOperationResult>((resolve) => {
          release = () => {
            board.tasks = board.tasks.filter((task) => task.id !== "a");
            resolve(ok(null));
          };
        }),
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("task-delete"));
    fireEvent.click(screen.getByTestId("task-delete-confirm"));
    await waitFor(() => {
      expect(screen.getByTestId("task-delete-confirm")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-card-a")).toBeNull();
    });
    expect(board.tasks.some((task) => task.id === "a")).toBe(false);
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    expect(screen.queryByTestId("task-details-error")).toBeNull();
  });

  it("ABA late success обновляет текущую A и сохраняет новый draft со stale", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let release: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () =>
        new Promise<UiOperationResult>((resolve) => {
          release = () => {
            const task = getTask(board, "a") as Task;
            const updated: Task = { ...task, priority: "high", version: 2 } as Task;

            board.tasks = board.tasks.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            );
            resolve(ok({ task: updated, resource: {}, eventId: "event" }));
          };
        }),
    });

    renderOverlay(operations);
    await openTask("a");
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    act(() => {
      updateKanbanQuery({ taskId: "a" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Новый draft A" } });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });
    expect(screen.getByTestId("kanban-inline-stale")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Новый draft A");
    expect(screen.getByTestId("kanban-modal-priority")).toHaveValue("high");
  });

  it("ABA late conflict обновляет данные без старого сообщения и cleanup", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let release: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () =>
        new Promise<UiOperationResult>((resolve) => {
          release = () => {
            board.tasks = board.tasks.map((task) =>
              task.id === "a" ? { ...task, priority: "high", version: 2 } : task,
            );
            resolve(fail("VERSION_CONFLICT"));
          };
        }),
    });

    renderOverlay(operations);
    await openTask("a");
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    act(() => {
      updateKanbanQuery({ taskId: "a" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача A");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Новый draft A" } });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });
    expect(screen.getByTestId("kanban-inline-stale")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Новый draft A");
    expect(screen.queryByTestId("task-details-error")).toBeNull();
  });

  it("поздний subtask create обновляет данные и не чистит quick draft B", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "todo", position: 1 }),
      ],
    };
    let release: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.create": () =>
        new Promise<UiOperationResult>((resolve) => {
          release = () => {
            const created = makeTask("late-sub", {
              title: "Поздняя подзадача",
              status: "todo",
              parentTaskId: "a",
              position: 2,
            });

            board.tasks = [...board.tasks, created];
            resolve(ok({ task: created, resource: {}, eventId: "event" }));
          };
        }),
    });
    const listCalls = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.list").length;

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-subtask-create"));
    fireEvent.change(screen.getByTestId("kanban-subtask-input"), {
      target: { value: "Поздняя подзадача" },
    });
    fireEvent.click(screen.getByTestId("kanban-subtask-submit"));

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-05-05" },
    });

    const before = listCalls();

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(listCalls()).toBeGreaterThan(before);
    });
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");
    expect(board.tasks.some((task) => task.id === "late-sub")).toBe(true);
    expect(screen.queryByTestId("task-details-error")).toBeNull();
  });

  it("поздний success A не стирает INTERNAL ошибку B и сохраняет draft B", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let releaseA: (() => void) | null = null;
    let bUpdates = 0;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": (input) => {
        const values = inputOf(input);
        const id = String(values.id);

        if (id === "a") {
          return new Promise<UiOperationResult>((resolve) => {
            releaseA = () => {
              const task = getTask(board, "a") as Task;
              const updated: Task = { ...task, priority: "high", version: 2 } as Task;

              board.tasks = board.tasks.map((candidate) =>
                candidate.id === updated.id ? updated : candidate,
              );
              resolve(ok({ task: updated, resource: {}, eventId: "event" }));
            };
          });
        }

        bUpdates += 1;

        if (bUpdates === 1) {
          return fail("INTERNAL", "Ошибка B");
        }

        const task = getTask(board, id) as Task;
        const updated: Task = {
          ...task,
          priority: values.priority as Task["priority"],
          version: task.version + 1,
        } as Task;

        board.tasks = board.tasks.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );

        return ok({ task: updated, resource: {}, eventId: "event" });
      },
    });
    const listCalls = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.list").length;

    renderOverlay(operations);
    await openTask("a");
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик B" } });
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("task-details-error")).toHaveTextContent("Ошибка B");
    });
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик B");

    const before = listCalls();

    await act(async () => {
      releaseA?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(listCalls()).toBeGreaterThan(before);
    });
    expect(screen.getByTestId("task-details-error")).toHaveTextContent("Ошибка B");
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик B");
    expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "1");

    // Новая операция той же generation снимает прежнюю командную ошибку.
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "low" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toHaveValue("low");
    });
    expect(screen.queryByTestId("task-details-error")).toBeNull();
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик B");
  });

  it("поздний VERSION_CONFLICT A не стирает INTERNAL ошибку B и draft B", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    let releaseA: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": (input) => {
        const values = inputOf(input);
        const id = String(values.id);

        if (id === "a") {
          return new Promise<UiOperationResult>((resolve) => {
            releaseA = () => {
              board.tasks = board.tasks.map((task) =>
                task.id === "a" ? { ...task, priority: "high", version: 2 } : task,
              );
              resolve(fail("VERSION_CONFLICT"));
            };
          });
        }

        return fail("INTERNAL", "Ошибка B");
      },
    });
    const listCalls = () =>
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.list").length;

    renderOverlay(operations);
    await openTask("a");
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-priority")).toBeDisabled();
    });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик B" } });
    fireEvent.change(screen.getByTestId("kanban-modal-priority"), {
      target: { value: "high" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("task-details-error")).toHaveTextContent("Ошибка B");
    });

    const before = listCalls();

    await act(async () => {
      releaseA?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(listCalls()).toBeGreaterThan(before);
    });
    expect(screen.getByTestId("task-details-error")).toHaveTextContent("Ошибка B");
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик B");
    expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "1");
    expect(screen.queryByTestId("kanban-inline-stale")).toBeNull();
  });

  it("сохраняет быстрые черновики при inline save и refresh", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-move-field"), {
      target: { value: "column-project-1-legacy-in_progress" },
    });
    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-05-05" },
    });
    fireEvent.change(screen.getByTestId("kanban-modal-tags"), {
      target: { value: "alpha, beta" },
    });
    fireEvent.click(screen.getByTestId("kanban-subtask-create"));
    fireEvent.change(screen.getByTestId("kanban-subtask-input"), {
      target: { value: "Черновик подзадачи" },
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Заголовок с inline" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
    });
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Заголовок с inline");
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");
    expect(screen.getByTestId("kanban-modal-tags")).toHaveValue("alpha, beta");
    expect(screen.getByTestId("kanban-modal-move-field")).toHaveValue(
      "column-project-1-legacy-in_progress",
    );
    expect(screen.getByTestId("kanban-subtask-input")).toHaveValue("Черновик подзадачи");
    expect(screen.queryByTestId("kanban-quick-conflict")).toBeNull();
  });

  it("блокирует double-submit inline-сохранения", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    let release: (() => void) | null = null;
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () =>
        new Promise<UiOperationResult>((resolve) => {
          release = () => {
            const task = getTask(board, "a") as Task;
            const updated: Task = { ...task, title: "Один раз", version: 2 } as Task;

            board.tasks = board.tasks.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            );
            resolve(ok({ task: updated, resource: {}, eventId: "event" }));
          };
        }),
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Один раз" } });

    fireEvent.keyDown(titleInput, { key: "Enter" });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    expect(
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update"),
    ).toHaveLength(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Один раз");
    });
    expect(
      operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update"),
    ).toHaveLength(1);
  });

  it("при переходе A→B сбрасывает inline-сессию и поздний ответ", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [
        makeTask("a", { title: "Задача A", status: "todo" }),
        makeTask("b", { title: "Задача B", status: "in_progress", position: 0 }),
      ],
    };
    const operations = createOperations(board);

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик A" } });

    act(() => {
      updateKanbanQuery({ taskId: "b" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Задача B");
    });
    expect(screen.queryByTestId("kanban-title-input")).toBeNull();
    expect(screen.queryByTestId("kanban-inline-stale")).toBeNull();
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();

    fireEvent.click(screen.getByTestId("kanban-modal-title"));

    expect(await screen.findByTestId("kanban-title-input")).toHaveValue("Задача B");
  });

  it.each(["Release", " release ", "release, release"])(
    "канонизирует теги %j после сохранения и не считает их dirty",
    async (input) => {
      setDesktopViewport(true);
      const board: FakeBoard = {
        projects: [project],
        tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
      };
      const operations = createOperations(board);

      renderOverlay(operations);
      await openTask("a");

      const tags = screen.getByTestId("kanban-modal-tags");
      const saveTags = screen.getByTestId("kanban-modal-tags-save");

      fireEvent.change(tags, { target: { value: input } });
      fireEvent.click(saveTags);

      await waitFor(() => {
        expect(board.tasks.find((task) => task.id === "a")?.tags).toEqual(["release"]);
      });
      await waitFor(() => {
        expect(tags).toHaveValue("release");
      });
      await waitFor(() => {
        expect(screen.getByTestId("kanban-modal")).toHaveAttribute("data-task-version", "2");
      });

      // Сохранение обновляет версию задачи через async reload. Пустой act
      // детерминированно докатывает passive effects, чтобы ModalDialog
      // опубликовал актуальный onClose без stale draftDirty.
      await act(async () => {});

      expect(screen.queryByTestId("kanban-quick-conflict")).toBeNull();
      expect(saveTags).toBeDisabled();

      const version = board.tasks.find((task) => task.id === "a")?.version;
      const updateCount = operations.calls.filter(
        (call) => call.operationId === "kanbaner.tasks.task.update",
      ).length;

      fireEvent.click(saveTags);

      expect(
        operations.calls.filter((call) => call.operationId === "kanbaner.tasks.task.update"),
      ).toHaveLength(updateCount);
      expect(board.tasks.find((task) => task.id === "a")?.version).toBe(version);

      // quickDirty=false: закрытие не требует подтверждения.
      fireEvent.keyDown(screen.getByTestId("kanban-details"), { key: "Escape" });

      // Закрытие проходит через async re-render после bumpKanbanRevision:
      // под параллельной нагрузкой полного прогона состояние может прийти
      // позже default 1s. Детерминированно ждём отсутствие dialog, сохраняя
      // штатный запас 5s только для этого async close.
      await waitFor(
        () => {
          expect(screen.queryByTestId("kanban-details")).toBeNull();
        },
        { timeout: 5000 },
      );
      expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
    },
  );

  it("закрывает карточку во время pending quick-команды без dirty-confirm", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    let resolveUpdate: ((value: UiOperationResult) => void) | null = null;
    const pendingUpdate = new Promise<UiOperationResult>((resolve) => {
      resolveUpdate = resolve;
    });
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () => pendingUpdate,
    });

    renderOverlay(operations);
    await openTask("a");

    const due = screen.getByTestId("kanban-modal-due");

    fireEvent.change(due, { target: { value: "2030-05-05" } });
    fireEvent.click(screen.getByTestId("kanban-modal-due-save"));

    // busyRef уже установлен: закрытие не показывает dirty-confirm, а поздний
    // success обновляет доску после закрытия.
    fireEvent.click(screen.getByTestId("kanban-details-close"));

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-details")).toBeNull();
    });
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();

    const updated = {
      ...board.tasks[0],
      dueAt: "2030-05-05T00:00:00.000Z",
      version: 2,
    } as Task;

    board.tasks = [updated];

    await act(async () => {
      resolveUpdate?.(ok({ task: updated, resource: {}, eventId: "event" }));
      await pendingUpdate;
    });

    expect(board.tasks.find((task) => task.id === "a")?.dueAt).toBe("2030-05-05T00:00:00.000Z");
    expect(screen.queryByTestId("kanban-details")).toBeNull();
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
  });

  it("сохраняет независимые quick/inline черновики при pending close", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    let resolveUpdate: ((value: UiOperationResult) => void) | null = null;
    const pendingUpdate = new Promise<UiOperationResult>((resolve) => {
      resolveUpdate = resolve;
    });
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () => pendingUpdate,
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-05-05" },
    });

    fireEvent.click(screen.getByTestId("kanban-modal-title"));
    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Новый заголовок" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    fireEvent.click(screen.getByTestId("kanban-details-close"));

    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Новый заголовок");

    const updated = {
      ...board.tasks[0],
      title: "Новый заголовок",
      version: 2,
    } as Task;

    board.tasks = [updated];

    await act(async () => {
      resolveUpdate?.(ok({ task: updated, resource: {}, eventId: "event" }));
      await pendingUpdate;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-draft-keep")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("kanban-draft-keep"));

    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-05-05");
    expect(screen.getByTestId("kanban-modal-title")).toHaveTextContent("Новый заголовок");
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
  });

  it("требует confirm при dirty inline и pending quick save", async () => {
    setDesktopViewport(true);
    const board: FakeBoard = {
      projects: [project],
      tasks: [makeTask("a", { title: "Задача A", status: "todo" })],
    };
    let resolveUpdate: ((value: UiOperationResult) => void) | null = null;
    const pendingUpdate = new Promise<UiOperationResult>((resolve) => {
      resolveUpdate = resolve;
    });
    const operations = createOperations(board, {
      "kanbaner.tasks.task.update": () => pendingUpdate,
    });

    renderOverlay(operations);
    await openTask("a");

    fireEvent.click(screen.getByTestId("kanban-modal-title"));
    const titleInput = await screen.findByTestId("kanban-title-input");

    fireEvent.change(titleInput, { target: { value: "Черновик заголовка" } });
    fireEvent.change(screen.getByTestId("kanban-modal-due"), {
      target: { value: "2030-06-06" },
    });
    fireEvent.click(screen.getByTestId("kanban-modal-due-save"));
    fireEvent.click(screen.getByTestId("kanban-details-close"));

    expect(await screen.findByTestId("kanban-draft-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик заголовка");

    const updated = {
      ...board.tasks[0],
      dueAt: "2030-06-06T00:00:00.000Z",
      version: 2,
    } as Task;

    board.tasks = [updated];

    await act(async () => {
      resolveUpdate?.(ok({ task: updated, resource: {}, eventId: "event" }));
      await pendingUpdate;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-draft-keep")).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId("kanban-draft-keep"));

    expect(screen.getByTestId("kanban-title-input")).toHaveValue("Черновик заголовка");
    expect(screen.getByTestId("kanban-modal-due")).toHaveValue("2030-06-06");
    expect(screen.queryByTestId("kanban-draft-confirm")).toBeNull();
  });
});
