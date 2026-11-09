import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskStatus } from "@kanbaner/plugin-tasks/contract";
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

function statusOf(input: JsonValue): string | null {
  const value = inputOf(input).status;

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
    "kanbaner.tasks.task.delete": (input) => {
      const id = String(inputOf(input).id);

      board.tasks = board.tasks.filter((task) => task.id !== id);

      return ok(null);
    },
    "kanbaner.tasks.task.complete": (input) => {
      const task = getTask(board, String(inputOf(input).id));

      return task === undefined ? fail("NOT_FOUND") : ok({ task });
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
    await waitFor(() => {
      expect(screen.getByTestId("kanban-subtasks-child")).toHaveTextContent("Подзадачи: 0");
    });
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
    fireEvent.click(
      within(screen.getByTestId("kanban-card-visible-a")).getByRole("button", {
        name: "В конец",
      }),
    );

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

      fireEvent.click(
        within(screen.getByTestId(`kanban-card-${taskId}`)).getByRole("button", {
          name: action,
        }),
      );

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
      fireEvent.click(
        within(screen.getByTestId("kanban-card-mover")).getByRole("button", {
          name: "Переместить в Готово",
        }),
      );

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
            statusOf(call.input) === "done" &&
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
        if (statusOf(input) === "done" && deferDoneReload && limit !== 200) {
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

    fireEvent.click(
      within(screen.getByTestId("kanban-card-mover-a")).getByRole("button", {
        name: "Переместить в Готово",
      }),
    );

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

    fireEvent.click(
      within(screen.getByTestId("kanban-card-mover-b")).getByRole("button", {
        name: "Переместить в Готово",
      }),
    );

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

    fireEvent.click(
      within(screen.getByTestId("kanban-card-p00")).getByRole("button", { name: "В конец" }),
    );

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
          statusOf(input) === "backlog" &&
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

    fireEvent.click(
      within(screen.getByTestId("kanban-card-visible-a")).getByRole("button", {
        name: "Переместить в Готово",
      }),
    );

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
          statusOf(input) === "backlog" &&
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

    fireEvent.click(
      within(screen.getByTestId("kanban-card-m00")).getByRole("button", {
        name: "Переместить в Готово",
      }),
    );

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
        if (statusOf(input) === "backlog" && offsetOf(input) === 10 && serveDuplicate) {
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
        if (statusOf(input) === "backlog" && offsetOf(input) === 10 && serveDuplicate) {
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
        statusOf(call.input) === "backlog" &&
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
        statusOf(call.input) === "backlog" &&
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
        if (statusOf(input) === "backlog" && offsetOf(input) === 10) {
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
        if (statusOf(input) === "backlog" && offsetOf(input) === 10) {
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
