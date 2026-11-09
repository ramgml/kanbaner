import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KanbanView } from "./ui/kanban-view.tsx";
import { getKanbanQuerySnapshot, resetKanbanQueryForTests } from "./ui/query-state.ts";

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

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
  nextTask: number;
}

function ok(data: JsonValue): UiOperationResult {
  return { ok: true, data };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function compareTasks(left: Task, right: Task): number {
  return left.position === right.position
    ? left.id.localeCompare(right.id)
    : left.position - right.position;
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

function createOperations(board: Board): {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ operationId: string; input: JsonValue }>;
} {
  const calls: Array<{ operationId: string; input: JsonValue }> = [];

  const invoke: UiOperationInvoker = async (operationId, input) => {
    calls.push({ operationId, input });

    if (operationId === "kanbaner.tasks.project.list") {
      return ok({ items: board.projects, total: board.projects.length, nextOffset: null });
    }

    if (operationId === "kanbaner.tasks.project.summary") {
      const counts: Record<TaskStatus, number> = { backlog: 0, todo: 0, in_progress: 0, done: 0 };

      for (const task of board.tasks) {
        counts[task.status] += 1;
      }

      return ok({
        items: board.projects.map((project) => ({
          project,
          total: board.tasks.filter((task) => task.projectId === project.id).length,
          counts,
          overdueCount: 0,
        })),
        total: board.projects.length,
        nextOffset: null,
        totals: { total: board.tasks.length, counts, overdueCount: 0 },
      });
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
      const task = makeTask(`task-${String(board.nextTask)}`, {
        projectId,
        title: String(values.title),
        status,
        position,
      });

      board.nextTask += 1;
      board.tasks = [...board.tasks, task];

      return ok({ task });
    }

    if (operationId === "kanbaner.tasks.task.move") {
      const values = inputOf(input);
      const task = board.tasks.find((candidate) => candidate.id === values.id);

      if (task === undefined) {
        return { ok: false, error: { code: "NOT_FOUND", message: "Нет задачи", retryable: false } };
      }

      board.tasks = board.tasks.map((candidate) =>
        candidate.id === task.id
          ? ({ ...candidate, status: values.status as TaskStatus } as Task)
          : candidate,
      );

      return ok({ task });
    }

    return { ok: false, error: { code: "NOT_FOUND", message: operationId, retryable: false } };
  };

  return { invoke, calls };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/view/kanban?project=project-1");
  resetKanbanQueryForTests("?project=project-1");
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("Trello-доска", () => {
  it("показывает проект, описание и не выводит технический подзаголовок", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Релиз 1.0", "Описание релиза **важно**")],
      tasks: [makeTask("a")],
      nextTask: 1,
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-1");
    resetKanbanQueryForTests("?project=project-1");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Релиз 1.0");
    });
    expect(screen.getByTestId("kanban-board-description")).toHaveTextContent(
      "Описание релиза **важно**",
    );
    expect(screen.queryByText(/Четыре фиксированные колонки/u)).toBeNull();
    expect(screen.queryByText(/данные задачи остаются в домене/u)).toBeNull();
  });

  it("без выбранного проекта показывает подсказку и не смешивает проекты", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Первый"), makeProject("project-2", "Второй")],
      tasks: [
        makeTask("a", { projectId: "project-1", title: "Из первого" }),
        makeTask("b", { projectId: "project-2", title: "Из второго" }),
      ],
      nextTask: 1,
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban");
    resetKanbanQueryForTests("");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    expect(await screen.findByTestId("kanban-project-picker")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-card-a")).toBeNull();
    expect(screen.queryByTestId("kanban-card-b")).toBeNull();
    expect(screen.queryByTestId("kanban-project-badge-a")).toBeNull();
    expect(screen.queryByTestId("kanban-projects-grid")).toBeNull();
  });

  it("показывает активный фильтр тега чипом и сбрасывает его", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Первый")],
      tasks: [
        makeTask("a", { tags: ["release"] }),
        makeTask("b", { tags: ["backend"], position: 1 }),
      ],
      nextTask: 1,
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-1&tag=release");
    resetKanbanQueryForTests("?project=project-1&tag=release");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-filter-chip-tag")).toHaveAccessibleName(
        "Сбросить фильтр тега «release»",
      );
    });
    expect(screen.queryByTestId("kanban-filter-chip-project")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("kanban-filter-chip-tag"));
    });

    expect(getKanbanQuerySnapshot().tag).toBe("");
    expect(getKanbanQuerySnapshot().projectId).toBe("project-1");
  });

  it("при пустом результате фильтра предлагает сбросить фильтры", async () => {
    const board: Board = {
      projects: [makeProject("project-1", "Первый")],
      tasks: [makeTask("a", { tags: ["release"] })],
      nextTask: 1,
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-1&tag=missing");
    resetKanbanQueryForTests("?project=project-1&tag=missing");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    const empty = await screen.findByTestId("kanban-empty-filter");

    expect(empty).toHaveTextContent("По фильтрам ничего не найдено");
    fireEvent.click(screen.getByTestId("kanban-empty-filter-reset"));

    expect(getKanbanQuerySnapshot().projectId).toBe("project-1");
    expect(getKanbanQuerySnapshot().tag).toBe("");
  });

  it("без проектов предлагает создать первый и не показывает composer", async () => {
    const board: Board = { projects: [], tasks: [], nextTask: 1 };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban");
    resetKanbanQueryForTests("");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-empty-projects")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("kanban-quick-add-todo")).toBeNull();
    expect(screen.getByTestId("kanban-create-task")).toBeDisabled();

    fireEvent.click(screen.getByTestId("kanban-create-first-project"));

    expect(screen.getByTestId("project-form")).toBeInTheDocument();
  });

  it("быстро создаёт задачу из composer с project/status и без position", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextTask: 1,
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-1");
    resetKanbanQueryForTests("?project=project-1");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    const opener = await screen.findByTestId("kanban-quick-add-todo");

    fireEvent.click(opener);

    const input = screen.getByTestId("kanban-quick-add-todo-input");

    fireEvent.change(input, { target: { value: "Быстрая задача" } });
    fireEvent.click(screen.getByTestId("kanban-quick-add-todo-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-task-1")).toHaveTextContent("Быстрая задача");
    });

    const create = operations.calls.find(
      (call) => call.operationId === "kanbaner.tasks.task.create",
    );
    const payload = inputOf(create?.input ?? {});

    expect(payload).toMatchObject({
      projectId: "project-1",
      title: "Быстрая задача",
      status: "todo",
    });
    expect(payload).not.toHaveProperty("position");
    await waitFor(() => {
      expect(input).toHaveValue("");
    });
    expect(screen.getByTestId("kanban-quick-add-todo-form")).toBeInTheDocument();
  });

  it("показывает пустую колонку с подсказкой перетащить или создать", async () => {
    const board: Board = { projects: [makeProject("project-1")], tasks: [], nextTask: 1 };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-empty-backlog")).toBeInTheDocument();
    });
    expect(screen.getByTestId("kanban-column-empty-backlog")).toHaveTextContent(
      "Перетащите задачу сюда или создайте новую",
    );
  });

  it("drop на composer в прокрученной колонке ставит задачу перед первой независимо от top", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [
        makeTask("a", { title: "A", status: "todo", position: 0 }),
        makeTask("b", { title: "B", status: "todo", position: 1 }),
        makeTask("mover", { title: "Mover", status: "backlog", position: 0 }),
      ],
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await screen.findByTestId("kanban-card-mover");

    const first = screen.getByTestId("kanban-card-a");

    // Колонка прокручена: первая карточка ушла выше viewport-а.
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue({
      top: -500,
      bottom: -400,
      left: 0,
      right: 200,
      width: 200,
      height: 100,
      x: 0,
      y: -500,
      toJSON: () => ({}),
    } as DOMRect);

    const composer = screen.getByTestId("kanban-quick-composer-todo");

    expect(composer).toHaveAttribute("data-kanban-drop-zone", "top");

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => composer,
    });

    const handle = screen.getByTestId("kanban-drag-mover");

    fireEvent.pointerDown(handle, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 50 });

    const placeholder = await screen.findByTestId("kanban-drop-placeholder");

    // Placeholder стоит перед первой карточкой, а не в конце списка.
    expect(screen.getByTestId("kanban-cards-todo").firstElementChild).toBe(placeholder);

    fireEvent.pointerUp(window);

    await waitFor(() => {
      const move = operations.calls.find((call) => call.operationId === "kanbaner.tasks.task.move");

      expect(inputOf(move?.input ?? {})).toMatchObject({
        id: "mover",
        status: "todo",
        position: 0,
      });
    });
  });

  it("drop первой карточки на composer остаётся no-op и не делает append", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [
        makeTask("a", { title: "A", status: "todo", position: 0 }),
        makeTask("b", { title: "B", status: "todo", position: 1 }),
      ],
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await screen.findByTestId("kanban-card-a");

    const composer = screen.getByTestId("kanban-quick-composer-todo");

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => composer,
    });

    const handle = screen.getByTestId("kanban-drag-a");

    fireEvent.pointerDown(handle, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 50 });

    // Верхняя зона указывает на первую карточку, но это она сама: drop
    // не должен превращаться в append.
    expect(screen.queryByTestId("kanban-drop-placeholder")).toBeNull();

    fireEvent.pointerUp(window);

    await act(async () => {
      await Promise.resolve();
    });

    expect(operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.move")).toBe(
      false,
    );
    expect(
      [...screen.getByTestId("kanban-cards-todo").querySelectorAll("[data-card-id]")].map(
        (element) => element.getAttribute("data-card-id"),
      ),
    ).toEqual(["a", "b"]);
  });

  it("показывает placeholder между карточками и подсвечивает целевую колонку", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [
        makeTask("a", { title: "A", status: "todo", position: 0 }),
        makeTask("b", { title: "B", status: "todo", position: 1 }),
      ],
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-a")).toBeInTheDocument();
    });

    const target = screen.getByTestId("kanban-card-b");

    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 100,
      left: 0,
      right: 200,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });

    const handle = screen.getByTestId("kanban-drag-a");

    fireEvent.pointerDown(handle, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 20 });

    const placeholder = await screen.findByTestId("kanban-drop-placeholder");

    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect((screen.getByTestId("kanban-column-todo") as HTMLElement).style.boxShadow).toContain(
      "var(--ring)",
    );

    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(operations.calls.some((call) => call.operationId === "kanbaner.tasks.task.move")).toBe(
        true,
      );
    });
    const move = operations.calls.find((call) => call.operationId === "kanbaner.tasks.task.move");

    expect(inputOf(move?.input ?? {})).toMatchObject({
      id: "a",
      status: "todo",
      position: 0,
    });
  });

  it("переключает мобильные вкладки статусов и прокручивает к колонке", async () => {
    const scrollTo = vi.fn();

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollTo,
    });

    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [makeTask("a")],
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-tab-backlog")).toHaveAttribute("aria-selected", "true");
    });

    fireEvent.click(screen.getByTestId("kanban-tab-in_progress"));

    expect(screen.getByTestId("kanban-tab-in_progress")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("kanban-tab-backlog")).toHaveAttribute("aria-selected", "false");
    expect(scrollTo).toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("kanban-tab-in_progress"), { key: "ArrowRight" });

    expect(screen.getByTestId("kanban-tab-done")).toHaveAttribute("aria-selected", "true");
  });

  it("не показывает доску и действия создания вне /view/kanban", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [makeTask("a")],
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/tasks" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-view")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("kanban-card-a")).toBeNull();
    expect(screen.queryByTestId("kanban-create-project")).toBeNull();
    expect(screen.queryByTestId("kanban-create-task")).toBeNull();
    expect(screen.queryByTestId("kanban-quick-add-todo")).toBeNull();
  });

  it("обновляет активную вкладку при ручной прокрутке", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [makeTask("a")],
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-tab-backlog")).toHaveAttribute("aria-selected", "true");
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-a")).toBeInTheDocument();
    });

    const container = screen.getByTestId("kanban-columns");

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 400,
      left: 0,
      right: 1200,
      width: 1200,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const offsets: Array<[TaskStatus, number]> = [
      ["backlog", -1200],
      ["todo", -800],
      ["in_progress", -400],
      ["done", 0],
    ];

    for (const [status, left] of offsets) {
      vi.spyOn(
        screen.getByTestId(`kanban-column-${status}`),
        "getBoundingClientRect",
      ).mockReturnValue({
        top: 0,
        bottom: 400,
        left,
        right: left + 272,
        width: 272,
        height: 400,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }

    act(() => {
      fireEvent.scroll(container);
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-tab-done")).toHaveAttribute("aria-selected", "true");
    });
  });

  it("показывает и скрывает scroll affordance по geometry и scroll/resize", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [makeTask("a")],
      nextTask: 1,
    };
    const operations = createOperations(board);

    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-card-a")).toBeInTheDocument();
    });

    const container = await screen.findByTestId("kanban-columns");

    const scrollWidth = 1200;
    let clientWidth = 800;
    let scrollLeft = 0;

    Object.defineProperty(container, "scrollWidth", {
      configurable: true,
      get: () => scrollWidth,
    });
    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      get: () => clientWidth,
    });
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });

    // Overflow есть: hint и fade видны.
    act(() => {
      fireEvent.scroll(container);
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-scroll-hint")).toBeInTheDocument();
    });
    expect(screen.getByTestId("kanban-scroll-fade")).toBeInTheDocument();

    // Правый край: подсказка и fade исчезают.
    scrollLeft = scrollWidth - clientWidth;

    act(() => {
      fireEvent.scroll(container);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-scroll-hint")).toBeNull();
    });
    expect(screen.queryByTestId("kanban-scroll-fade")).toBeNull();

    // Resize до отсутствия overflow: элементы остаются скрытыми.
    scrollLeft = 0;
    clientWidth = 1200;

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("kanban-scroll-hint")).toBeNull();
    });

    // Новый overflow после resize снова показывает affordance.
    clientWidth = 700;

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-scroll-hint")).toBeInTheDocument();
    });
    expect(screen.getByTestId("kanban-scroll-fade")).toBeInTheDocument();
    expect(scrollWidth).toBe(1200);
  });

  it("сбрасывает фильтр кнопкой в пустом результате", async () => {
    const board: Board = {
      projects: [makeProject("project-1")],
      tasks: [],
      nextTask: 1,
    };
    const operations = createOperations(board);

    window.history.replaceState(null, "", "/view/kanban?project=project-1&tag=missing");
    resetKanbanQueryForTests("?project=project-1&tag=missing");
    render(<KanbanView invoke={operations.invoke} pathname="/view/kanban" />);

    await screen.findByTestId("kanban-empty-filter");
    fireEvent.click(screen.getByTestId("kanban-empty-filter-reset"));

    expect(getKanbanQuerySnapshot().tag).toBe("");
    expect(getKanbanQuerySnapshot().projectId).toBe("project-1");
  });
});
