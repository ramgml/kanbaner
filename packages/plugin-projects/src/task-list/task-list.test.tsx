import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project, Task, TaskColumn } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { ProjectSidebar } from "../ui/project-sidebar.tsx";
import { TaskDetailsPanel } from "./task-details-panel.tsx";
import { TaskListView } from "./task-list-view.tsx";
import {
  getTaskListQuerySnapshot,
  resetTaskListQueryForTests,
  updateTaskListQuery,
} from "./query-state.ts";
import { getProjectCreateRequest } from "../ui/workspace.ts";

const project: Project = {
  id: "project-1",
  title: "Проект один",
  descriptionMarkdown: "",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  parentTaskId: null,
  title: "Подготовить релиз",
  descriptionMarkdown: "Описание",
  priority: "high",
  dueAt: "2026-02-03T00:00:00.000Z",
  position: 0,
  tags: ["release"],
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  status: "todo",
  completedAt: null,
};

type Handler = (input: JsonValue) => UiOperationResult | Promise<UiOperationResult>;

function ok(data: JsonValue): UiOperationResult {
  return { ok: true, data };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | null = null;
  let reject: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });

  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
    },
    reject: (reason?: unknown) => {
      reject?.(reason);
    },
  };
}

function fail(code: string, message = code): UiOperationResult {
  return { ok: false, error: { code, message, retryable: code === "VERSION_CONFLICT" } };
}

interface FakeOperations {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ readonly operationId: string; readonly input: JsonValue }>;
  readonly counts: ReadonlyMap<string, number>;
}

function createOperations(handlers: Record<string, Handler>): FakeOperations {
  const calls: Array<{ operationId: string; input: JsonValue }> = [];
  const counts = new Map<string, number>();

  const invoke: UiOperationInvoker = async (operationId, input) => {
    calls.push({ operationId, input });
    counts.set(operationId, (counts.get(operationId) ?? 0) + 1);
    const handler = handlers[operationId];

    if (handler === undefined) {
      return fail("NOT_FOUND", `Нет обработчика ${operationId}`);
    }

    return handler(input);
  };

  return { invoke, calls, counts };
}

function baseHandlers(): Record<string, Handler> {
  const columns: readonly TaskColumn[] = [
    {
      id: "column-project-1-legacy-todo",
      projectId: "project-1",
      title: "К выполнению",
      status: "todo",
      position: 0,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "column-project-1-legacy-done",
      projectId: "project-1",
      title: "Готово",
      status: "done",
      position: 1,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  return {
    "kanbaner.tasks.project.list": () => ok({ items: [project], total: 1, nextOffset: null }),
    "kanbaner.tasks.task.list": () => ok({ items: [task], total: 1, nextOffset: null }),
    "kanbaner.tasks.column.list": () =>
      ok({ items: [...columns], total: columns.length, nextOffset: null }),
    "kanbaner.tasks.project.get": () => ok({ project }),
    "kanbaner.tasks.task.get": () => ok({ task }),
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/view/tasks");
  resetTaskListQueryForTests("");
});

afterEach(() => {
  cleanup();
});

describe("TaskListView", () => {
  it("загружает проекты и задачи через публичные запросы и рисует адаптивный список", async () => {
    const operations = createOperations(baseHandlers());

    render(<TaskListView invoke={operations.invoke} />);

    expect(await screen.findByTestId("task-row-task-1")).toBeInTheDocument();
    expect(screen.getByTestId("task-table")).toBeInTheDocument();
    expect(screen.getByTestId("task-cards")).toBeInTheDocument();
    expect(screen.getByTestId("task-table")).toHaveTextContent("Проект один");
    expect(operations.counts.get("kanbaner.tasks.task.list")).toBe(1);
    expect(operations.counts.get("kanbaner.tasks.project.list")).toBe(1);

    const listCall = operations.calls.find(
      (call) => call.operationId === "kanbaner.tasks.task.list",
    );
    expect(listCall?.input).toMatchObject({
      limit: 25,
      offset: 0,
      sort: { field: "position", direction: "asc" },
    });
  });

  it("синхронизирует фильтр проекта и сортировку с query string и повторяет запрос", async () => {
    const operations = createOperations(baseHandlers());

    render(<TaskListView invoke={operations.invoke} />);

    await screen.findByTestId("task-row-task-1");

    fireEvent.change(screen.getByLabelText("Проект"), { target: { value: "project-1" } });

    await waitFor(() => {
      expect(window.location.search).toContain("project=project-1");
    });

    await waitFor(() => {
      const last = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.list")
        .at(-1);
      expect(last?.input).toMatchObject({ projectId: "project-1" });
    });

    fireEvent.change(screen.getByLabelText("Сортировка"), { target: { value: "title" } });

    await waitFor(() => {
      const last = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.list")
        .at(-1);
      expect(last?.input).toMatchObject({ sort: { field: "title", direction: "asc" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));

    // Сброс фильтров списка сохраняет выбранный проект: проект задаётся
    // рабочим пространством, а не фильтром.
    await waitFor(() => {
      expect(window.location.search).toContain("project=project-1");
    });
    expect(window.location.search).not.toContain("status=");
    expect(window.location.search).not.toContain("tag=");
  });

  it("делегирует создание проекта общему command и не держит форму в списке", async () => {
    const operations = createOperations(baseHandlers());

    render(<TaskListView invoke={operations.invoke} />);
    await screen.findByTestId("task-row-task-1");

    const before = getProjectCreateRequest();

    fireEvent.click(screen.getByTestId("create-project-button"));

    // Список не ищет скрытую desktop-кнопку в DOM: форму открывает тот
    // контейнер (sidebar или mobile sheet), который виден на breakpoint-е.
    expect(getProjectCreateRequest()).toBe(before + 1);
    expect(screen.queryByTestId("project-form")).toBeNull();
    expect(operations.counts.get("kanbaner.tasks.project.create") ?? 0).toBe(0);
  });

  it("создаёт задачу, открывает её детали и перечитывает список", async () => {
    const handlers = baseHandlers();
    handlers["kanbaner.tasks.task.create"] = () =>
      ok({
        task: { ...task, id: "task-new", title: "Новая задача" },
        resource: "kanbaner.tasks:task:task-new",
        eventId: "event-1",
      });
    const operations = createOperations(handlers);

    render(<TaskListView invoke={operations.invoke} />);
    await screen.findByTestId("task-row-task-1");

    act(() => {
      updateTaskListQuery({ projectId: "project-1" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("create-task-button")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("create-task-button"));
    fireEvent.change(screen.getByTestId("task-list-create-input"), {
      target: { value: "Новая задача" },
    });
    fireEvent.click(screen.getByTestId("task-list-create-submit"));

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.create")).toBe(1);
    });

    const createCall = operations.calls.find(
      (call) => call.operationId === "kanbaner.tasks.task.create",
    );
    expect(createCall?.input).toMatchObject({
      projectId: "project-1",
      columnId: "column-project-1-legacy-todo",
      title: "Новая задача",
      priority: "medium",
    });

    await waitFor(() => {
      expect(getTaskListQuerySnapshot().taskId).toBe("task-new");
      expect(window.location.search).toContain("task=task-new");
    });

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.list")).toBeGreaterThanOrEqual(2);
    });
  });

  it("открывает задачу с клавиатуры через кнопку названия", async () => {
    const operations = createOperations(baseHandlers());

    render(<TaskListView invoke={operations.invoke} />);
    const button = await screen.findByRole("button", {
      name: "Открыть задачу Подготовить релиз",
    });

    button.focus();
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(getTaskListQuerySnapshot().taskId).toBe("task-1");
      expect(window.location.search).toContain("task=task-1");
    });
  });

  it("пишет query через router writer и переносит task/tag в переключатель", async () => {
    const secondProject: Project = {
      ...project,
      id: "project-2",
      title: "Проект два",
    };
    const handlers = baseHandlers();
    handlers["kanbaner.tasks.project.list"] = () =>
      ok({ items: [project, secondProject], total: 2, nextOffset: null });
    const operations = createOperations(handlers);
    const replaceSearch = vi.fn();

    render(
      <>
        <TaskListView
          invoke={operations.invoke}
          search="?project=project-1&task=task-1"
          replaceSearch={replaceSearch}
        />
        <ProjectSidebar invoke={operations.invoke} />
      </>,
    );

    await screen.findByTestId("task-row-task-1");

    // Выбранная задача входит в ссылку переключателя: уход на доску не
    // требует закрывать модал и не теряет контекст.
    await waitFor(() => {
      expect(screen.getByTestId("project-view-kanban")).toHaveAttribute(
        "href",
        "/view/kanban?project=project-1&task=task-1",
      );
    });

    fireEvent.change(screen.getByLabelText("Тег"), { target: { value: "release" } });

    await waitFor(() => {
      expect(replaceSearch).toHaveBeenLastCalledWith("?project=project-1&tag=release&task=task-1");
    });

    expect(screen.getByTestId("project-view-kanban")).toHaveAttribute(
      "href",
      "/view/kanban?project=project-1&tag=release&task=task-1",
    );

    // Смена проекта в sidebar идёт через тот же query state: тег сохраняется,
    // а task снимается осознанно — он принадлежит прежнему проекту.
    fireEvent.click(await screen.findByTestId("projects-sidebar-item-project-2"));

    await waitFor(() => {
      expect(replaceSearch).toHaveBeenLastCalledWith("?project=project-2&tag=release");
    });

    expect(screen.getByTestId("project-view-kanban")).toHaveAttribute(
      "href",
      "/view/kanban?project=project-2&tag=release",
    );
  });
});

describe("TaskDetailsPanel", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/view/tasks?task=task-1");
    resetTaskListQueryForTests("?task=task-1");
  });

  it("не рендерит детали без выбранной задачи", () => {
    updateTaskListQuery({ taskId: null });
    const operations = createOperations(baseHandlers());

    render(
      <TaskDetailsPanel invoke={operations.invoke} variant="desktop" pathname="/view/tasks" />,
    );

    expect(screen.queryByTestId("task-details-desktop")).not.toBeInTheDocument();
    expect(operations.counts.get("kanbaner.tasks.task.get")).toBeUndefined();
  });

  it("не загружает и не рендерит детали вне /view/tasks", () => {
    const operations = createOperations(baseHandlers());

    render(<TaskDetailsPanel invoke={operations.invoke} variant="desktop" pathname="/plugins" />);

    expect(screen.queryByTestId("task-details-desktop")).not.toBeInTheDocument();
    expect(operations.counts.get("kanbaner.tasks.task.get")).toBeUndefined();
  });

  it("загружает детали и после редактирования перечитывает задачу", async () => {
    const handlers = baseHandlers();
    handlers["kanbaner.tasks.task.update"] = (input) => {
      const updated = { ...task, title: String((input as { title: string }).title), version: 4 };

      return ok({ task: updated, resource: "kanbaner.tasks:task:task-1", eventId: "event-2" });
    };
    const operations = createOperations(handlers);

    render(
      <TaskDetailsPanel invoke={operations.invoke} variant="desktop" pathname="/view/tasks" />,
    );

    expect(await screen.findByTestId("task-details")).toHaveTextContent("Подготовить релиз");

    fireEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Обновлённая" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить задачу" }));

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.update")).toBe(1);
    });

    expect(
      operations.calls.find((call) => call.operationId === "kanbaner.tasks.task.update")?.input,
    ).toMatchObject({ id: "task-1", expectedVersion: 3, title: "Обновлённая" });

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.get")).toBeGreaterThanOrEqual(2);
    });
  });

  it("при VERSION_CONFLICT показывает сообщение, перечитывает задачу и не повторяет устаревшую команду", async () => {
    const handlers = baseHandlers();
    handlers["kanbaner.tasks.task.update"] = () => fail("VERSION_CONFLICT");
    const operations = createOperations(handlers);

    render(
      <TaskDetailsPanel invoke={operations.invoke} variant="desktop" pathname="/view/tasks" />,
    );
    await screen.findByTestId("task-details");

    fireEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Конфликт" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить задачу" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("уже изменена");
    });

    expect(operations.counts.get("kanbaner.tasks.task.update")).toBe(1);

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.get")).toBeGreaterThanOrEqual(2);
    });

    // Форма закрыта: повторная отправка устаревшей версии невозможна без
    // нового чтения и явного открытия редактора.
    expect(screen.queryByTestId("task-form-edit")).not.toBeInTheDocument();
  });

  it("удаляет задачу только после inline-подтверждения и закрывает детали", async () => {
    const handlers = baseHandlers();
    handlers["kanbaner.tasks.task.delete"] = () =>
      ok({
        deleted: true,
        resource: "kanbaner.tasks:task:task-1",
        version: 3,
        eventVersion: 4,
        deletedResourceRefs: [],
        deletedTasks: [],
        eventId: "event-3",
      });
    const operations = createOperations(handlers);

    render(
      <TaskDetailsPanel invoke={operations.invoke} variant="desktop" pathname="/view/tasks" />,
    );
    await screen.findByTestId("task-details");

    fireEvent.click(screen.getByTestId("task-delete"));
    expect(operations.counts.get("kanbaner.tasks.task.delete")).toBeUndefined();

    fireEvent.click(screen.getByTestId("task-delete-confirm"));

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.delete")).toBe(1);
    });

    await waitFor(() => {
      expect(getTaskListQuerySnapshot().taskId).toBeNull();
    });
  });

  it("завершает задачу публичной командой и обновляет детали", async () => {
    const handlers = baseHandlers();
    handlers["kanbaner.tasks.task.complete"] = () =>
      ok({
        task: {
          ...task,
          status: "done",
          completedAt: "2026-01-05T00:00:00.000Z",
          version: 4,
        },
        resource: "kanbaner.tasks:task:task-1",
        eventId: "event-4",
      });
    const operations = createOperations(handlers);

    render(
      <TaskDetailsPanel invoke={operations.invoke} variant="desktop" pathname="/view/tasks" />,
    );
    await screen.findByTestId("task-details");

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));

    await waitFor(() => {
      expect(operations.counts.get("kanbaner.tasks.task.complete")).toBe(1);
    });
  });

  it("legacy composer использует один destination и подпись Backlog", async () => {
    const handlers = baseHandlers();

    handlers["kanbaner.tasks.task.create"] = () =>
      ok({
        task: { ...task, id: "task-legacy", title: "Legacy" },
        resource: {},
        eventId: "event",
      });

    const operations = createOperations(handlers);

    window.history.replaceState(null, "", "/view/tasks?project=project-1&status=backlog");
    resetTaskListQueryForTests("?project=project-1&status=backlog");
    render(<TaskListView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("create-task-button")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("create-task-button"));

    const form = screen.getByTestId("task-list-create-form");

    expect(form.getAttribute("aria-label")).toContain("Backlog");
    fireEvent.change(screen.getByTestId("task-list-create-input"), {
      target: { value: "Legacy composer" },
    });
    fireEvent.click(screen.getByTestId("task-list-create-submit"));

    await waitFor(() => {
      const createCall = operations.calls.find(
        (call) => call.operationId === "kanbaner.tasks.task.create",
      );

      expect(createCall?.input).toMatchObject({
        projectId: "project-1",
        status: "backlog",
      });
      expect(createCall?.input).not.toHaveProperty("columnId");
    });
  });

  it("не сбрасывает ?column до успешной загрузки колонок текущего проекта", async () => {
    const handlers = baseHandlers();
    const columns = deferred<UiOperationResult>();

    handlers["kanbaner.tasks.column.list"] = () => columns.promise;

    const operations = createOperations(handlers);

    window.history.replaceState(
      null,
      "",
      "/view/tasks?project=project-1&column=column-project-1-legacy-todo",
    );
    resetTaskListQueryForTests("?project=project-1&column=column-project-1-legacy-todo");

    render(<TaskListView invoke={operations.invoke} />);

    await waitFor(() => {
      const listCall = operations.calls.find(
        (call) => call.operationId === "kanbaner.tasks.task.list",
      );

      expect(listCall?.input).toMatchObject({
        projectId: "project-1",
        columnId: "column-project-1-legacy-todo",
      });
    });
    expect(window.location.search).toContain("column=column-project-1-legacy-todo");
    expect(screen.getByTestId("create-task-button")).toBeDisabled();

    await act(async () => {
      columns.resolve(
        ok({
          items: [
            {
              id: "column-project-1-legacy-todo",
              projectId: "project-1",
              title: "К выполнению",
              status: "todo",
              position: 0,
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          total: 1,
          nextOffset: null,
        }),
      );
      await columns.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("create-task-button")).toBeEnabled();
    });
    expect(window.location.search).toContain("column=column-project-1-legacy-todo");
  });

  it("не сбрасывает ?column при ошибке или пустом ответе column.list", async () => {
    const handlers = baseHandlers();

    handlers["kanbaner.tasks.column.list"] = () => fail("INTERNAL_ERROR", "Колонки недоступны");

    const operations = createOperations(handlers);

    window.history.replaceState(
      null,
      "",
      "/view/tasks?project=project-1&column=column-project-1-legacy-todo",
    );
    resetTaskListQueryForTests("?project=project-1&column=column-project-1-legacy-todo");
    render(<TaskListView invoke={operations.invoke} />);

    await waitFor(() => {
      expect(screen.getByText(/Колонки: Колонки недоступны/u)).toBeInTheDocument();
    });
    expect(window.location.search).toContain("column=column-project-1-legacy-todo");

    cleanup();

    const emptyHandlers = baseHandlers();

    emptyHandlers["kanbaner.tasks.column.list"] = () =>
      ok({ items: [], total: 0, nextOffset: null });

    const emptyOperations = createOperations(emptyHandlers);

    render(<TaskListView invoke={emptyOperations.invoke} />);

    await waitFor(() => {
      expect(emptyOperations.counts.get("kanbaner.tasks.column.list")).toBe(1);
    });
    expect(window.location.search).toContain("column=column-project-1-legacy-todo");
  });

  it("включает legacy status в task.list, сбрасывает фильтр и понимает back/forward", async () => {
    const handlers = baseHandlers();
    const operations = createOperations(handlers);

    window.history.replaceState(null, "", "/view/tasks?project=project-1&status=backlog");
    resetTaskListQueryForTests("?project=project-1&status=backlog");
    render(<TaskListView invoke={operations.invoke} />);

    await waitFor(() => {
      const listCall = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.list")
        .at(-1);

      expect(listCall?.input).toMatchObject({
        projectId: "project-1",
        status: "backlog",
      });
    });
    expect(screen.getByTestId("task-list-legacy-status")).toBeVisible();

    fireEvent.click(screen.getByTestId("task-list-legacy-status-reset"));

    await waitFor(() => {
      expect(window.location.search).not.toContain("status=");
    });
    expect(screen.queryByTestId("task-list-legacy-status")).toBeNull();

    act(() => {
      window.history.pushState(null, "", "/view/tasks?project=project-1&status=backlog");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(window.location.search).toContain("status=backlog");
    });
    await waitFor(() => {
      const listCall = operations.calls
        .filter((call) => call.operationId === "kanbaner.tasks.task.list")
        .at(-1);

      expect(listCall?.input).toMatchObject({ status: "backlog" });
    });
  });
});
