import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { Project } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { ProjectSidebar } from "./ui/project-sidebar.tsx";
import { registerWorkspaceView, type WorkspaceViewContext } from "./ui/workspace.ts";

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

function ok(data: JsonValue): UiOperationResult {
  return { ok: true, data };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

interface Harness {
  readonly invoke: UiOperationInvoker;
  readonly calls: Array<{ readonly operationId: string; readonly input: JsonValue }>;
  projects: Project[];
}

function createHarness(initial: Project[]): Harness {
  const calls: Array<{ operationId: string; input: JsonValue }> = [];
  const harness: Harness = {
    projects: initial,
    calls,
    invoke: async (operationId, input) => {
      calls.push({ operationId, input });

      if (operationId === "kanbaner.tasks.project.list") {
        const values = inputOf(input);
        const limit = typeof values.limit === "number" ? values.limit : 200;
        const offset = typeof values.offset === "number" ? values.offset : 0;
        const page = harness.projects.slice(offset, offset + limit);
        const nextOffset =
          offset + page.length < harness.projects.length ? offset + page.length : null;

        return ok({ items: page, total: harness.projects.length, nextOffset });
      }

      if (operationId === "kanbaner.tasks.project.create") {
        const values = inputOf(input);
        const project = makeProject(
          `project-${String(harness.projects.length + 1)}`,
          String(values.title),
        );

        harness.projects = [...harness.projects, project];

        return ok({ project });
      }

      return ok(null);
    },
  };

  return harness;
}

let cleanupView: (() => void) | null = null;

function registerView(
  route: WorkspaceViewContext["route"],
  projectId: string,
  search = "",
): {
  readonly view: WorkspaceViewContext;
  readonly navigations: string[];
} {
  const navigations: string[] = [];
  const view: WorkspaceViewContext = {
    route,
    projectId,
    search,
    navigate: (next) => {
      navigations.push(next);
    },
  };

  cleanupView = registerWorkspaceView(view);

  return { view, navigations };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanupView?.();
  cleanupView = null;
  cleanup();
});

describe("ProjectSidebar", () => {
  it("не рендерится вне представлений проектов", () => {
    const harness = createHarness([makeProject("project-1")]);

    render(<ProjectSidebar invoke={harness.invoke} />);

    expect(screen.queryByTestId("projects-sidebar")).toBeNull();
  });

  it("показывает проекты и выделяет активный через aria-current", async () => {
    const harness = createHarness([
      makeProject("project-1", "Первый"),
      makeProject("project-2", "Второй"),
    ]);

    registerView("/view/kanban", "project-2");
    render(<ProjectSidebar invoke={harness.invoke} />);

    const active = await screen.findByTestId("projects-sidebar-item-project-2");

    expect(screen.getByTestId("projects-sidebar").dataset.activeProject).toBe("project-2");
    expect(active).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("projects-sidebar-item-project-1")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("выбирает проект без промежуточного экрана и сохраняет остальные параметры", async () => {
    const harness = createHarness([makeProject("project-1"), makeProject("project-2")]);

    const { navigations } = registerView("/view/tasks", "project-1", "?tag=release&task=task-1");
    render(<ProjectSidebar invoke={harness.invoke} />);

    fireEvent.click(await screen.findByTestId("projects-sidebar-item-project-2"));

    expect(navigations).toEqual(["?tag=release&project=project-2"]);
    expect(window.localStorage.getItem("kanbaner.projects.lastProjectId")).toBe("project-2");
  });

  it("автоматически выбирает единственный проект при пустом контексте", async () => {
    const harness = createHarness([makeProject("project-7", "Единственный")]);

    const { navigations } = registerView("/view/kanban", "");
    render(<ProjectSidebar invoke={harness.invoke} />);

    await waitFor(() => {
      expect(navigations).toEqual(["?project=project-7"]);
    });
  });

  it("показывает поиск только при большом количестве проектов и фильтрует список", async () => {
    const projects = Array.from({ length: 7 }, (_, index) =>
      makeProject(
        `project-${String(index + 1)}`,
        index === 6 ? "Отдельный" : `Проект ${String(index + 1)}`,
      ),
    );
    const harness = createHarness(projects);

    registerView("/view/kanban", "project-1");
    render(<ProjectSidebar invoke={harness.invoke} />);

    const search = await screen.findByTestId("projects-sidebar-search");

    fireEvent.change(search, { target: { value: "отдель" } });

    expect(screen.getByTestId("projects-sidebar-item-project-7")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-sidebar-item-project-1")).toBeNull();

    fireEvent.change(search, { target: { value: "нет такого" } });

    expect(screen.getByTestId("projects-sidebar-no-results")).toBeInTheDocument();
  });

  it("создаёт проект, перечитывает список и открывает его", async () => {
    const harness = createHarness([makeProject("project-1")]);

    const { navigations } = registerView("/view/kanban", "project-1");
    render(<ProjectSidebar invoke={harness.invoke} />);

    await screen.findByTestId("projects-sidebar-item-project-1");
    fireEvent.click(screen.getByTestId("projects-create-button"));

    const form = screen.getByTestId("project-form");

    fireEvent.change(screen.getByLabelText("Название проекта"), { target: { value: "Новый" } });
    fireEvent.click(within(form).getByRole("button", { name: "Создать проект" }));

    await waitFor(() => {
      expect(navigations).toEqual(["?project=project-2"]);
    });
    expect(
      harness.calls.filter((call) => call.operationId === "kanbaner.tasks.project.list").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("projects-sidebar-item-project-2")).toHaveTextContent("Новый");
    expect(screen.queryByTestId("projects-create-panel")).toBeNull();
  });

  it("не отправляет project.create дважды и сохраняет ввод при ошибке", async () => {
    let calls = 0;
    const projects = [makeProject("project-1")];

    registerView("/view/kanban", "project-1");
    render(
      <ProjectSidebar
        invoke={async (operationId) => {
          if (operationId === "kanbaner.tasks.project.list") {
            return ok({ items: projects, total: 1, nextOffset: null });
          }

          if (operationId === "kanbaner.tasks.project.create") {
            calls += 1;

            // Отвечаем асинхронно, чтобы вторая отправка попала в guard.
            await Promise.resolve();

            return {
              ok: false,
              error: { code: "INTERNAL_ERROR", message: "Сервер недоступен", retryable: true },
            };
          }

          return ok(null);
        }}
      />,
    );

    await screen.findByTestId("projects-sidebar-item-project-1");
    fireEvent.click(screen.getByTestId("projects-create-button"));

    const form = screen.getByTestId("project-form");
    const submit = within(form).getByRole("button", { name: "Создать проект" });

    fireEvent.change(screen.getByLabelText("Название проекта"), { target: { value: "Один" } });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(calls).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Сервер недоступен");
    });
    expect(screen.getByLabelText("Название проекта")).toHaveValue("Один");
  });

  it("показывает пустое состояние и ошибку загрузки", async () => {
    const harness = createHarness([]);

    registerView("/view/kanban", "");
    render(<ProjectSidebar invoke={harness.invoke} />);

    expect(await screen.findByTestId("projects-sidebar-empty")).toBeInTheDocument();
  });

  it("показывает ошибку загрузки проектов", async () => {
    registerView("/view/kanban", "");
    render(
      <ProjectSidebar
        invoke={async () => ({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Сервер недоступен", retryable: true },
        })}
      />,
    );

    expect(await screen.findByTestId("projects-sidebar-error")).toHaveTextContent(
      "Сервер недоступен",
    );
  });

  it("сохраняет ввод при ошибке создания проекта", async () => {
    let failCreate = true;
    const projects = [makeProject("project-1")];

    registerView("/view/kanban", "project-1");
    render(
      <ProjectSidebar
        invoke={async (operationId) => {
          if (operationId === "kanbaner.tasks.project.list") {
            return ok({ items: projects, total: 1, nextOffset: null });
          }

          if (operationId === "kanbaner.tasks.project.create" && failCreate) {
            failCreate = false;

            return {
              ok: false,
              error: { code: "INTERNAL_ERROR", message: "Сервер недоступен", retryable: true },
            };
          }

          return ok(null);
        }}
      />,
    );

    await screen.findByTestId("projects-sidebar-item-project-1");
    fireEvent.click(screen.getByTestId("projects-create-button"));

    const draftForm = screen.getByTestId("project-form");

    fireEvent.change(screen.getByLabelText("Название проекта"), { target: { value: "Черновик" } });
    fireEvent.click(within(draftForm).getByRole("button", { name: "Создать проект" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Сервер недоступен");
    expect(screen.getByLabelText("Название проекта")).toHaveValue("Черновик");
  });

  it("сворачивает панель создания по повторному нажатию +", async () => {
    const harness = createHarness([makeProject("project-1")]);

    registerView("/view/kanban", "project-1");
    render(<ProjectSidebar invoke={harness.invoke} />);

    await screen.findByTestId("projects-sidebar-item-project-1");
    fireEvent.click(screen.getByTestId("projects-create-button"));
    expect(screen.getByTestId("projects-create-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("projects-create-button"));
    expect(screen.queryByTestId("projects-create-panel")).toBeNull();
  });

  it("не вызывает navigate после act для стабильных данных", async () => {
    const harness = createHarness([makeProject("project-1"), makeProject("project-2")]);

    const { navigations } = registerView("/view/kanban", "project-1");
    render(<ProjectSidebar invoke={harness.invoke} />);

    await screen.findByTestId("projects-sidebar-item-project-2");
    act(() => {
      fireEvent.click(screen.getByTestId("projects-sidebar-item-project-1"));
    });

    expect(navigations).toEqual(["?project=project-1"]);
  });

  it("догружает проекты по nextOffset и открывает созданный 201-й проект", async () => {
    const projects = Array.from({ length: 200 }, (_, index) =>
      makeProject(
        `project-${String(index + 1)}`,
        index === 199 ? "Двухсотый" : `Проект ${String(index + 1)}`,
      ),
    );
    const harness = createHarness(projects);

    const { navigations } = registerView("/view/kanban", "project-1");
    render(<ProjectSidebar invoke={harness.invoke} />);

    expect(await screen.findByTestId("projects-sidebar-item-project-200")).toBeInTheDocument();
    // Первая страница не смогла бы показать проект за limit=200, поэтому
    // список обязан догрузиться, а не считать его удалённым.
    expect(screen.getByTestId("projects-sidebar-item-project-200")).toHaveTextContent("Двухсотый");

    fireEvent.click(screen.getByTestId("projects-create-button"));

    const form = screen.getByTestId("project-form");

    fireEvent.change(screen.getByLabelText("Название проекта"), {
      target: { value: "Двести первый" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Создать проект" }));

    await waitFor(() => {
      expect(screen.getByTestId("projects-sidebar-item-project-201")).toHaveTextContent(
        "Двести первый",
      );
    });
    expect(navigations).toContain("?project=project-201");

    const listOffsets = harness.calls
      .filter((call) => call.operationId === "kanbaner.tasks.project.list")
      .map((call) => inputOf(call.input).offset)
      .filter((offset): offset is number => typeof offset === "number");

    expect(listOffsets).toContain(200);

    act(() => {
      fireEvent.click(screen.getByTestId("projects-sidebar-item-project-201"));
    });

    expect(navigations).toContain("?project=project-201");
  });
});
