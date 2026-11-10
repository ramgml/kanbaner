import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type {
  Project,
  ProjectMutationOutput,
  ProjectSummaryOutput,
  TaskColumn,
  TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KANBAN_ROUTE, PROJECTS_OVERVIEW_ROUTE } from "./metadata.ts";
import { KanbanView } from "./ui/kanban-view.tsx";
import { ProjectHeader } from "./ui/project-header.tsx";
import { ProjectSettingsButton } from "./ui/project-settings.tsx";
import { resetKanbanQueryForTests } from "./ui/query-state.ts";

const TIMESTAMP = "2026-02-01T00:00:00.000Z";
const EMPTY_COUNTS: Record<TaskStatus, number> = {
  backlog: 0,
  todo: 0,
  in_progress: 0,
  done: 0,
};

function makeProject(id: string, title: string, version = 1): Project {
  return {
    id,
    title,
    descriptionMarkdown: "",
    version,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function makeColumn(id: string, title: string, options: Partial<TaskColumn> = {}): TaskColumn {
  return {
    id,
    projectId: "project-1",
    title,
    status: "todo",
    position: 0,
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...options,
  };
}

function ok(data: JsonValue | null): UiOperationResult {
  return { ok: true, data };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function projectIdOf(input: JsonValue): string {
  const values = inputOf(input);

  return typeof values.id === "string" ? values.id : "";
}

function projectMutation(project: Project): ProjectMutationOutput {
  return {
    project,
    resource: { type: "kanbaner.tasks.project", id: project.id },
    eventId: "event-project",
  } as unknown as ProjectMutationOutput;
}

function columnMutation(column: TaskColumn): JsonValue {
  return {
    column,
    resource: { type: "kanbaner.tasks.column", id: column.id },
    eventId: "event-column",
  } as unknown as JsonValue;
}

function columnList(columns: readonly TaskColumn[]): JsonValue {
  return { items: columns, total: columns.length, nextOffset: null } as unknown as JsonValue;
}

function projectList(project: Project): JsonValue {
  return { items: [project], total: 1, nextOffset: null };
}

function summaryOf(project: Project): ProjectSummaryOutput {
  return {
    items: [
      {
        project,
        total: 0,
        counts: { ...EMPTY_COUNTS },
        overdueCount: 0,
      },
    ],
    total: 1,
    nextOffset: null,
    totals: { total: 0, counts: { ...EMPTY_COUNTS }, overdueCount: 0 },
  };
}

function renderHeader(
  project: Project | null,
  invoke: UiOperationInvoker,
  variant: "kanban" | "list" | "overview" = "kanban",
) {
  return render(
    <ProjectHeader
      variant={variant}
      route={variant === "overview" ? PROJECTS_OVERVIEW_ROUTE : KANBAN_ROUTE}
      project={project}
      summary={null}
      search=""
      fallbackTitle="Проекты"
      invoke={invoke}
    />,
  );
}

function simpleInvoke(project: Project, columns: readonly TaskColumn[]): UiOperationInvoker {
  return async (operationId) => {
    if (operationId === "kanbaner.tasks.project.list") {
      return ok(projectList(project));
    }

    if (operationId === "kanbaner.tasks.column.list") {
      return ok(columnList(columns));
    }

    return ok(null);
  };
}

async function openSettings(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("project-settings-button"));

  return screen.findByTestId("project-settings-title-input");
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/view/projects");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
});

describe("Настройки доски", () => {
  it("не показывает кнопку в обзоре без активного проекта", () => {
    renderHeader(null, async () => ok(null), "overview");

    expect(screen.queryByTestId("project-settings-button")).toBeNull();
  });

  it("открывает настройки, фокусирует название и закрывает Escape с возвратом фокуса", async () => {
    const project = makeProject("project-1", "Релиз");
    const invoke = vi.fn<UiOperationInvoker>(
      simpleInvoke(project, [makeColumn("column-1", "ToDo")]),
    );

    renderHeader(project, invoke);

    const opener = screen.getByTestId("project-settings-button");

    opener.focus();
    fireEvent.click(opener);

    const input = (await screen.findByTestId("project-settings-title-input")) as HTMLInputElement;
    const dialog = screen.getByTestId("project-settings-dialog");

    expect(dialog).toBeInTheDocument();
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    expect(input.value).toBe("Релиз");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Релиз".length);
    expect(screen.getByTestId("project-settings-column-input-column-1")).toHaveValue("ToDo");

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByTestId("project-settings-dialog")).toBeNull();
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it("требует непустое название проекта и не теряет ввод", async () => {
    const project = makeProject("project-1", "Релиз");
    const invoke = vi.fn<UiOperationInvoker>(simpleInvoke(project, []));

    renderHeader(project, invoke);
    await openSettings();

    const input = screen.getByTestId("project-settings-title-input");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(screen.getByTestId("project-settings-title-form"));

    expect(screen.getByTestId("project-settings-title-validation")).toHaveTextContent(
      "Укажите название проекта",
    );
    expect(input).toHaveValue("   ");
    expect(invoke).not.toHaveBeenCalledWith("kanbaner.tasks.project.update", expect.anything());
  });

  it("сохраняет проект отдельно, обновляет заголовок и не меняет query", async () => {
    let project = makeProject("project-1", "Релиз");
    const column = makeColumn("column-project-1-todo", "ToDo");
    const updateInputs: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.project.summary") {
        return ok(summaryOf(project) as unknown as JsonValue);
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList([column]));
      }

      if (operationId === "kanbaner.tasks.project.update") {
        const values = inputOf(input);

        updateInputs.push(values);
        project = {
          ...project,
          title: String(values.title),
          version: project.version + 1,
        };

        return ok(projectMutation(project) as unknown as JsonValue);
      }

      return ok({ items: [], total: 0, nextOffset: null });
    };

    window.history.replaceState(null, "", "/view/kanban?project=project-1&tag=release");
    resetKanbanQueryForTests("?project=project-1&tag=release");

    render(
      <KanbanView
        invoke={invoke}
        pathname={KANBAN_ROUTE}
        search="?project=project-1&tag=release"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Релиз");
    });

    await openSettings();
    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "  Релиз 2  " },
    });
    fireEvent.click(screen.getByTestId("project-settings-title-save"));

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-notice")).toHaveTextContent(
        "Название проекта сохранено",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Релиз 2");
    });

    expect(updateInputs).toEqual([{ id: "project-1", expectedVersion: 1, title: "Релиз 2" }]);
    expect(window.location.search).toContain("?project=project-1");
    expect(window.location.search).toContain("tag=release");
    expect(screen.getByTestId("project-settings-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("project-settings-done"));
    expect(screen.queryByTestId("project-settings-dialog")).toBeNull();
  });

  it("после VERSION_CONFLICT перечитывает проект и повторяет с новой версией", async () => {
    let conflict = true;
    const project = makeProject("project-1", "Релиз");
    const expectedVersions: number[] = [];
    let listCalls = 0;
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        listCalls += 1;

        return ok(
          projectList(
            listCalls === 1 ? project : { ...project, title: "Чужое название", version: 2 },
          ),
        );
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList([]));
      }

      if (operationId !== "kanbaner.tasks.project.update") {
        return ok(null);
      }

      const values = inputOf(input);

      expectedVersions.push(Number(values.expectedVersion));

      if (conflict) {
        conflict = false;

        return {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message: "Версия проекта устарела",
            retryable: false,
          },
        };
      }

      return ok(
        projectMutation({
          ...project,
          title: String(values.title),
          version: 3,
        }) as unknown as JsonValue,
      );
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "Новое название" },
    });
    fireEvent.click(screen.getByTestId("project-settings-title-save"));

    await screen.findByTestId("project-settings-title-error");

    expect(listCalls).toBe(2);
    expect(screen.getByTestId("project-settings-title-error")).toHaveTextContent(
      "Проект уже изменён в другом месте",
    );
    expect(screen.getByTestId("project-settings-title-input")).toHaveValue("Новое название");

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-input")).toHaveFocus();
    });

    fireEvent.click(screen.getByTestId("project-settings-title-save"));

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-notice")).toHaveTextContent(
        "Название проекта сохранено",
      );
    });
    expect(expectedVersions).toEqual([1, 2]);
  });

  it("не отправляет проект до завершения refresh и сохраняет фокус", async () => {
    const project = makeProject("project-1", "Релиз");
    const expectedVersions: number[] = [];
    let listCalls = 0;
    let updateCalls = 0;
    let resolveList!: (value: UiOperationResult) => void;
    const listResult = new Promise<UiOperationResult>((resolve) => {
      resolveList = resolve;
    });
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        listCalls += 1;

        if (listCalls === 1) {
          return ok(projectList(project));
        }

        return listResult;
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList([]));
      }

      if (operationId !== "kanbaner.tasks.project.update") {
        return ok(null);
      }

      const values = inputOf(input);

      updateCalls += 1;
      expectedVersions.push(Number(values.expectedVersion));

      if (updateCalls === 1) {
        return {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message: "Версия проекта устарела",
            retryable: false,
          },
        };
      }

      return ok(
        projectMutation({
          ...project,
          title: String(values.title),
          version: 3,
        }) as unknown as JsonValue,
      );
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);

    const input = await openSettings();

    fireEvent.change(input, { target: { value: "Новое название" } });
    fireEvent.click(screen.getByTestId("project-settings-title-save"));

    await waitFor(() => {
      expect(listCalls).toBe(2);
    });

    expect(updateCalls).toBe(1);
    expect(screen.queryByTestId("project-settings-title-error")).toBeNull();
    expect(screen.getByTestId("project-settings-title-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("project-settings-title-save"));
    expect(updateCalls).toBe(1);

    await act(async () => {
      resolveList(ok(projectList({ ...project, title: "Чужое название", version: 2 })));
      await listResult;
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-error")).toHaveTextContent(
        "Проект уже изменён в другом месте",
      );
    });
    expect(input).toHaveValue("Новое название");
    expect(screen.getByTestId("project-settings-title-save")).toBeEnabled();
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    fireEvent.click(screen.getByTestId("project-settings-title-save"));

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-notice")).toBeVisible();
    });
    expect(expectedVersions).toEqual([1, 2]);
  });

  it("защищает сохранение проекта от двойной отправки", async () => {
    const project = makeProject("project-1", "Релиз");
    let updateCalls = 0;
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList([]));
      }

      if (operationId !== "kanbaner.tasks.project.update") {
        return ok(null);
      }

      updateCalls += 1;
      const values = inputOf(input);

      return ok(
        projectMutation({
          ...project,
          title: String(values.title),
          version: 2,
        }) as unknown as JsonValue,
      );
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    const form = screen.getByTestId("project-settings-title-form");

    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "Новое" },
    });

    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-notice")).toBeVisible();
    });
    expect(updateCalls).toBe(1);
  });

  it("сохраняет название колонки отдельно, обновляет список и уведомляет доску", async () => {
    const project = makeProject("project-1", "Релиз");
    let columns = [makeColumn("column-1", "ToDo")];
    const updateInputs: Array<Record<string, unknown>> = [];
    let projectUpdates = 0;
    const onColumnsChanged = vi.fn();
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList(columns));
      }

      if (operationId === "kanbaner.tasks.project.update") {
        projectUpdates += 1;

        return ok(null);
      }

      if (operationId === "kanbaner.tasks.column.update") {
        const values = inputOf(input);

        updateInputs.push(values);
        columns = columns.map((column) =>
          column.id === values.id
            ? { ...column, title: String(values.title), version: column.version + 1 }
            : column,
        );

        return ok(columnMutation(columns[0] as TaskColumn));
      }

      return ok(null);
    };

    render(
      <ProjectSettingsButton
        invoke={invoke}
        project={project}
        onColumnsChanged={onColumnsChanged}
      />,
    );
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-1"), {
      target: { value: "  Новая колонка  " },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-save-column-1"));

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-column-notice-column-1")).toHaveTextContent(
        "Название колонки сохранено",
      );
    });

    expect(updateInputs).toEqual([{ id: "column-1", expectedVersion: 1, title: "Новая колонка" }]);
    expect(screen.getByTestId("project-settings-column-input-column-1")).toHaveValue(
      "Новая колонка",
    );
    expect(onColumnsChanged).toHaveBeenCalledTimes(1);
    expect(projectUpdates).toBe(0);
  });

  it("после конфликта колонки сохраняет ввод и повторяет с новой версией", async () => {
    const project = makeProject("project-1", "Релиз");
    const expectedVersions: number[] = [];
    let conflict = true;
    let listCalls = 0;
    let column = makeColumn("column-1", "ToDo");
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        listCalls += 1;

        return ok(
          columnList([
            listCalls === 1 ? column : { ...column, title: "Чужое название", version: 2 },
          ]),
        );
      }

      if (operationId !== "kanbaner.tasks.column.update") {
        return ok(null);
      }

      const values = inputOf(input);

      expectedVersions.push(Number(values.expectedVersion));

      if (conflict) {
        conflict = false;

        return {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message: "Версия колонки устарела",
            retryable: false,
          },
        };
      }

      column = { ...column, title: String(values.title), version: 3 };

      return ok(columnMutation(column));
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-1"), {
      target: { value: "Новое" },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-save-column-1"));

    await screen.findByTestId("project-settings-column-error-column-1");

    expect(listCalls).toBe(2);
    expect(screen.getByTestId("project-settings-column-error-column-1")).toHaveTextContent(
      "Колонка уже изменена в другом месте",
    );
    expect(screen.getByTestId("project-settings-column-input-column-1")).toHaveValue("Новое");

    fireEvent.click(screen.getByTestId("project-settings-column-save-column-1"));

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-column-notice-column-1")).toHaveTextContent(
        "Название колонки сохранено",
      );
    });
    expect(expectedVersions).toEqual([1, 2]);
  });

  it("сериализует column.move и не запускает второй reorder до завершения первого", async () => {
    const project = makeProject("project-1", "Релиз");
    let columns = [
      makeColumn("column-a", "A", { position: 0 }),
      makeColumn("column-b", "B", { position: 1 }),
      makeColumn("column-c", "C", { position: 2 }),
    ];
    let moveCalls = 0;
    let resolveFirst!: (value: UiOperationResult) => void;
    const firstMove = new Promise<UiOperationResult>((resolve) => {
      resolveFirst = resolve;
    });
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList(columns));
      }

      if (operationId !== "kanbaner.tasks.column.move") {
        return ok(null);
      }

      const values = inputOf(input);
      const id = String(values.id);
      const position = Number(values.position);
      const moved = columns.find((column) => column.id === id) as TaskColumn;
      const rest = columns.filter((column) => column.id !== id);

      rest.splice(position, 0, { ...moved, version: moved.version + 1 });
      columns = rest.map((column, index) => ({ ...column, position: index }));
      moveCalls += 1;

      if (moveCalls === 1) {
        return firstMove;
      }

      return ok(columnMutation(columns[position] as TaskColumn));
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    fireEvent.click(screen.getByTestId("project-settings-column-down-column-a"));
    await waitFor(() => {
      expect(moveCalls).toBe(1);
    });

    // Второй reorder (другая колонка) заблокирован на время move.
    fireEvent.click(screen.getByTestId("project-settings-column-down-column-b"));
    fireEvent.click(screen.getByTestId("project-settings-column-up-column-c"));
    expect(moveCalls).toBe(1);
    expect(screen.getByTestId("project-settings-column-down-column-b")).toBeDisabled();

    await act(async () => {
      resolveFirst(ok(columnMutation(columns[1] as TaskColumn)));
      await firstMove;
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-column-down-column-b")).toBeEnabled();
    });

    fireEvent.click(screen.getByTestId("project-settings-column-down-column-b"));
    await waitFor(() => {
      expect(moveCalls).toBe(2);
    });
  });

  it("игнорирует устаревший refresh, пришедший после более свежего", async () => {
    const project = makeProject("project-1", "Релиз");
    const renamed = "A переименована";
    let columns = [
      makeColumn("column-a", "A", { position: 0 }),
      makeColumn("column-b", "B", { position: 1 }),
      makeColumn("column-c", "C", { position: 2 }),
    ];
    let listCalls = 0;
    let resolveRenameRefresh!: (value: UiOperationResult) => void;
    let resolveMoveRefresh!: (value: UiOperationResult) => void;
    const renameRefresh = new Promise<UiOperationResult>((resolve) => {
      resolveRenameRefresh = resolve;
    });
    const moveRefresh = new Promise<UiOperationResult>((resolve) => {
      resolveMoveRefresh = resolve;
    });
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        listCalls += 1;

        if (listCalls === 1) {
          return ok(columnList(columns));
        }

        return listCalls === 2 ? renameRefresh : moveRefresh;
      }

      if (operationId === "kanbaner.tasks.column.update") {
        const values = inputOf(input);
        const id = String(values.id);

        columns = columns.map((column) =>
          column.id === id
            ? { ...column, title: String(values.title), version: column.version + 1 }
            : column,
        );

        return ok(columnMutation(columns[0] as TaskColumn));
      }

      if (operationId === "kanbaner.tasks.column.move") {
        const id = String(inputOf(input).id);

        columns = [
          columns[0] as TaskColumn,
          columns[2] as TaskColumn,
          columns[1] as TaskColumn,
        ].map((column, index) => ({ ...column, position: index }));
        columns = columns.map((column) =>
          column.id === id ? { ...column, version: column.version + 1 } : column,
        );

        return ok(columnMutation(columns[0] as TaskColumn));
      }

      return ok(null);
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-a"), {
      target: { value: renamed },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-save-column-a"));

    await waitFor(() => {
      expect(listCalls).toBe(2);
    });

    // Move другой колонки разрешён параллельно с rename и создаёт более
    // свежий refresh.
    fireEvent.click(screen.getByTestId("project-settings-column-up-column-c"));
    await waitFor(() => {
      expect(listCalls).toBe(3);
    });

    const freshColumns = columns.map((column) => ({ ...column }));

    await act(async () => {
      resolveMoveRefresh(ok(columnList(freshColumns)));
      await moveRefresh;
    });

    await act(async () => {
      resolveRenameRefresh(
        ok(
          columnList([
            makeColumn("column-a", "A", { position: 0, version: 1 }),
            makeColumn("column-b", "B", { position: 1 }),
            makeColumn("column-c", "C", { position: 2 }),
          ]),
        ),
      );
      await renameRefresh;
    });

    const list = screen.getByTestId("project-settings-columns");

    expect(
      within(list)
        .getAllByRole("textbox")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual([renamed, "C", "B"]);
  });

  it("не снимает pending нового сохранения после close → reopen", async () => {
    const firstProject = makeProject("project-1", "Первый");
    const secondProject = makeProject("project-2", "Второй");
    let resolveOld!: (value: UiOperationResult) => void;
    let resolveNew!: (value: UiOperationResult) => void;
    const oldSave = new Promise<UiOperationResult>((resolve) => {
      resolveOld = resolve;
    });
    const newSave = new Promise<UiOperationResult>((resolve) => {
      resolveNew = resolve;
    });
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok({
          items: [firstProject, secondProject],
          total: 2,
          nextOffset: null,
        } as unknown as JsonValue);
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList([]));
      }

      if (operationId === "kanbaner.tasks.project.update") {
        return projectIdOf(input) === firstProject.id ? oldSave : newSave;
      }

      return ok(null);
    };

    const view = render(<ProjectSettingsButton invoke={invoke} project={firstProject} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "Старое сохранение" },
    });
    fireEvent.click(screen.getByTestId("project-settings-title-save"));
    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-save")).toBeDisabled();
    });

    view.rerender(<ProjectSettingsButton invoke={invoke} project={secondProject} />);

    await openSettings();
    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "Новое сохранение" },
    });
    fireEvent.click(screen.getByTestId("project-settings-title-save"));
    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-save")).toHaveTextContent("Сохранение…");
    });

    await act(async () => {
      resolveOld(
        ok(
          projectMutation({
            ...firstProject,
            title: "Старое сохранение",
            version: 2,
          }) as unknown as JsonValue,
        ),
      );
      await oldSave;
    });

    expect(screen.getByTestId("project-settings-title-save")).toBeDisabled();
    expect(screen.getByTestId("project-settings-title-save")).toHaveTextContent("Сохранение…");

    await act(async () => {
      resolveNew(
        ok(
          projectMutation({
            ...secondProject,
            title: "Новое сохранение",
            version: 2,
          }) as unknown as JsonValue,
        ),
      );
      await newSave;
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-title-notice")).toHaveTextContent(
        "Название проекта сохранено",
      );
    });
  });

  it("не теряет pending нового column.update после A → B → A с той же колонкой", async () => {
    const firstProject = makeProject("project-1", "Первый");
    const secondProject = makeProject("project-2", "Второй");
    const firstColumn = makeColumn("column-shared", "A");
    const secondColumn = makeColumn("column-b", "B");
    let updateCalls = 0;
    let resolveOld!: (value: UiOperationResult) => void;
    let resolveNew!: (value: UiOperationResult) => void;
    const oldSave = new Promise<UiOperationResult>((resolve) => {
      resolveOld = resolve;
    });
    const newSave = new Promise<UiOperationResult>((resolve) => {
      resolveNew = resolve;
    });
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok({
          items: [firstProject, secondProject],
          total: 2,
          nextOffset: null,
        } as unknown as JsonValue);
      }

      if (operationId === "kanbaner.tasks.column.list") {
        const values = inputOf(input);

        return ok(
          columnList(values.projectId === secondProject.id ? [secondColumn] : [firstColumn]),
        );
      }

      if (operationId !== "kanbaner.tasks.column.update") {
        return ok(null);
      }

      updateCalls += 1;

      return updateCalls === 1 ? oldSave : newSave;
    };

    const view = render(<ProjectSettingsButton invoke={invoke} project={firstProject} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-shared"), {
      target: { value: "Старое" },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-save-column-shared"));
    await waitFor(() => {
      expect(screen.getByTestId("project-settings-column-save-column-shared")).toBeDisabled();
    });

    // A → B: project switch принудительно закрывает настройки, не дожидаясь
    // старой операции. Затем B → A и новое сохранение той же колонки.
    view.rerender(<ProjectSettingsButton invoke={invoke} project={secondProject} />);
    await waitFor(() => {
      expect(screen.queryByTestId("project-settings-dialog")).toBeNull();
    });

    view.rerender(<ProjectSettingsButton invoke={invoke} project={firstProject} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-shared"), {
      target: { value: "Новое" },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-save-column-shared"));
    await waitFor(() => {
      expect(screen.getByTestId("project-settings-column-save-column-shared")).toHaveTextContent(
        "…",
      );
    });

    await act(async () => {
      resolveOld(
        ok(
          columnMutation({
            ...firstColumn,
            title: "Старое",
            version: 2,
          }),
        ),
      );
      await oldSave;
    });

    // Старый finally не снимает pending новой операции.
    expect(screen.getByTestId("project-settings-column-save-column-shared")).toBeDisabled();
    expect(screen.getByTestId("project-settings-column-save-column-shared")).toHaveTextContent("…");

    await act(async () => {
      resolveNew(
        ok(
          columnMutation({
            ...firstColumn,
            title: "Новое",
            version: 3,
          }),
        ),
      );
      await newSave;
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-settings-column-notice-column-shared")).toHaveTextContent(
        "Название колонки сохранено",
      );
    });
    expect(screen.getByTestId("project-settings-column-input-column-shared")).toHaveValue("Новое");
  });

  it("показывает обычную ошибку project.update и сохраняет ввод", async () => {
    const project = makeProject("project-1", "Релиз");
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList([]));
      }

      if (operationId === "kanbaner.tasks.project.update") {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Сервер недоступен", retryable: true },
        };
      }

      return ok(null);
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "Новое название" },
    });
    fireEvent.click(screen.getByTestId("project-settings-title-save"));

    await screen.findByTestId("project-settings-title-error");

    expect(screen.getByTestId("project-settings-title-error")).toHaveTextContent(
      "Сервер недоступен",
    );
    expect(screen.getByTestId("project-settings-title-input")).toHaveValue("Новое название");
    expect(screen.getByTestId("project-settings-title-save")).toBeEnabled();
  });

  it("после конфликта показывает отдельную ошибку refresh и сохраняет ввод", async () => {
    const project = makeProject("project-1", "Релиз");
    let listCalls = 0;
    let updateCalls = 0;
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === "kanbaner.tasks.project.list") {
        listCalls += 1;

        if (listCalls === 1) {
          return ok(projectList(project));
        }

        return {
          ok: false,
          error: { code: "INTERNAL", message: "Список недоступен", retryable: true },
        };
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList([]));
      }

      if (operationId === "kanbaner.tasks.project.update") {
        updateCalls += 1;

        return {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message: "Версия проекта устарела",
            retryable: false,
          },
        };
      }

      return ok(null);
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "Новое название" },
    });
    fireEvent.click(screen.getByTestId("project-settings-title-save"));

    await screen.findByTestId("project-settings-title-error");

    expect(screen.getByTestId("project-settings-title-error")).toHaveTextContent(
      "Не удалось обновить версию проекта",
    );
    expect(screen.getByTestId("project-settings-title-error")).not.toHaveTextContent(
      "Проект уже изменён",
    );
    expect(screen.getByTestId("project-settings-title-input")).toHaveValue("Новое название");
    expect(screen.getByTestId("project-settings-title-save")).toBeEnabled();
    expect(updateCalls).toBe(1);
  });

  it("показывает ошибку refresh колонки и не теряет новую версию", async () => {
    const project = makeProject("project-1", "Релиз");
    let columns = [makeColumn("column-1", "ToDo")];
    let listCalls = 0;
    const expectedVersions: number[] = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        listCalls += 1;

        if (listCalls === 1) {
          return ok(columnList(columns));
        }

        return {
          ok: false,
          error: { code: "INTERNAL", message: "Список колонок недоступен", retryable: true },
        };
      }

      if (operationId !== "kanbaner.tasks.column.update") {
        return ok(null);
      }

      const values = inputOf(input);

      expectedVersions.push(Number(values.expectedVersion));
      columns = columns.map((column) => ({
        ...column,
        title: String(values.title),
        version: column.version + 1,
      }));

      return ok(columnMutation(columns[0] as TaskColumn));
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-1"), {
      target: { value: "Новая" },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-save-column-1"));

    await screen.findByTestId("project-settings-column-error-column-1");

    expect(screen.getByTestId("project-settings-column-error-column-1")).toHaveTextContent(
      "список колонок не обновлён",
    );
    expect(screen.getByTestId("project-settings-column-input-column-1")).toHaveValue("Новая");

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-1"), {
      target: { value: "Ещё новее" },
    });
    fireEvent.click(screen.getByTestId("project-settings-column-save-column-1"));

    await waitFor(() => {
      expect(expectedVersions).toEqual([1, 2]);
    });
  });

  it("меняет порядок кнопками вверх/вниз через column.move и перечитывает список", async () => {
    const project = makeProject("project-1", "Релиз");
    let columns = [
      makeColumn("column-a", "A", { position: 0 }),
      makeColumn("column-b", "B", { position: 1 }),
      makeColumn("column-c", "C", { position: 2 }),
    ];
    const moveInputs: Array<Record<string, unknown>> = [];
    const onColumnsChanged = vi.fn();
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList(columns));
      }

      if (operationId !== "kanbaner.tasks.column.move") {
        return ok(null);
      }

      const values = inputOf(input);
      const id = String(values.id);
      const position = Number(values.position);

      moveInputs.push(values);

      const moved = columns.find((column) => column.id === id) as TaskColumn;
      const rest = columns.filter((column) => column.id !== id);

      rest.splice(position, 0, { ...moved, version: moved.version + 1 });
      columns = rest.map((column, index) => ({ ...column, position: index }));

      return ok(columnMutation(columns[position] as TaskColumn));
    };

    render(
      <ProjectSettingsButton
        invoke={invoke}
        project={project}
        onColumnsChanged={onColumnsChanged}
      />,
    );
    await openSettings();

    const list = screen.getByTestId("project-settings-columns");

    expect(
      within(list)
        .getAllByRole("textbox")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["A", "B", "C"]);

    fireEvent.click(screen.getByTestId("project-settings-column-down-column-a"));

    await waitFor(() => {
      expect(
        within(list)
          .getAllByRole("textbox")
          .map((input) => (input as HTMLInputElement).value),
      ).toEqual(["B", "A", "C"]);
    });

    expect(moveInputs).toEqual([{ id: "column-a", expectedVersion: 1, position: 1 }]);
    expect(onColumnsChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("project-settings-column-up-column-c"));

    await waitFor(() => {
      expect(
        within(list)
          .getAllByRole("textbox")
          .map((input) => (input as HTMLInputElement).value),
      ).toEqual(["B", "C", "A"]);
    });
    expect(moveInputs[1]).toEqual({ id: "column-c", expectedVersion: 1, position: 1 });
  });

  it("переставляет колонку pointer drag за ручку и откатывает порядок при конфликте", async () => {
    const project = makeProject("project-1", "Релиз");
    const columns = [
      makeColumn("column-a", "A", { position: 0 }),
      makeColumn("column-b", "B", { position: 1 }),
    ];
    let conflict = true;
    const moveInputs: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok(projectList(project));
      }

      if (operationId === "kanbaner.tasks.column.list") {
        return ok(columnList(columns));
      }

      if (operationId !== "kanbaner.tasks.column.move") {
        return ok(null);
      }

      const values = inputOf(input);

      moveInputs.push(values);

      if (conflict) {
        conflict = false;

        return {
          ok: false,
          error: {
            code: "VERSION_CONFLICT",
            message: "Версия колонки устарела",
            retryable: false,
          },
        };
      }

      return ok(columnMutation(columns[0] as TaskColumn));
    };

    render(<ProjectSettingsButton invoke={invoke} project={project} />);
    await openSettings();

    const rowB = screen.getByTestId("project-settings-column-column-b");

    const originalElementFromPoint = document.elementFromPoint;

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => rowB,
    });

    try {
      const handle = screen.getByTestId("project-settings-column-drag-column-a");

      fireEvent.pointerDown(handle, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 10,
        clientY: 10,
        isPrimary: true,
      });
      fireEvent.pointerMove(window, { clientX: 30, clientY: 30 });
      fireEvent.pointerUp(window, { clientX: 30, clientY: 30 });
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
    }

    await waitFor(() => {
      expect(moveInputs.length).toBe(1);
    });
    expect(moveInputs[0]).toEqual({ id: "column-a", expectedVersion: 1, position: 1 });

    await screen.findByTestId("project-settings-column-error-column-a");
    expect(screen.getByTestId("project-settings-column-error-column-a")).toHaveTextContent(
      "Колонка уже изменена в другом месте",
    );

    const list = screen.getByTestId("project-settings-columns");

    expect(
      within(list)
        .getAllByRole("textbox")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["A", "B"]);
  });

  it("подтверждает закрытие с несохранёнными изменениями и не теряет ввод", async () => {
    const project = makeProject("project-1", "Релиз");
    const invoke = vi.fn<UiOperationInvoker>(
      simpleInvoke(project, [makeColumn("column-1", "ToDo")]),
    );

    renderHeader(project, invoke);

    const opener = screen.getByTestId("project-settings-button");

    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-title-input"), {
      target: { value: "Черновик" },
    });
    fireEvent.click(screen.getByTestId("project-settings-done"));

    expect(screen.getByTestId("project-settings-dirty-confirm")).toBeVisible();
    expect(screen.getByTestId("project-settings-title-input")).toHaveValue("Черновик");

    fireEvent.click(screen.getByTestId("project-settings-dirty-keep"));

    expect(screen.queryByTestId("project-settings-dirty-confirm")).toBeNull();
    expect(screen.getByTestId("project-settings-dialog")).toBeInTheDocument();

    // Escape при видимом подтверждении остаётся в настройках.
    fireEvent.keyDown(screen.getByTestId("project-settings-dialog"), { key: "Escape" });
    expect(screen.getByTestId("project-settings-dirty-confirm")).toBeVisible();
    fireEvent.keyDown(screen.getByTestId("project-settings-dialog"), { key: "Escape" });
    expect(screen.queryByTestId("project-settings-dirty-confirm")).toBeNull();
    expect(screen.getByTestId("project-settings-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("project-settings-done"));
    fireEvent.click(screen.getByTestId("project-settings-dirty-discard"));

    expect(screen.queryByTestId("project-settings-dialog")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("kanbaner.tasks.project.update", expect.anything());
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it("считает несохранённым и черновик названия колонки", async () => {
    const project = makeProject("project-1", "Релиз");
    const invoke = vi.fn<UiOperationInvoker>(
      simpleInvoke(project, [makeColumn("column-1", "ToDo")]),
    );

    renderHeader(project, invoke);
    await openSettings();

    fireEvent.change(screen.getByTestId("project-settings-column-input-column-1"), {
      target: { value: "Черновик колонки" },
    });

    fireEvent.keyDown(screen.getByTestId("project-settings-dialog"), { key: "Escape" });

    expect(screen.getByTestId("project-settings-dirty-confirm")).toBeVisible();
    expect(screen.getByTestId("project-settings-column-input-column-1")).toHaveValue(
      "Черновик колонки",
    );

    fireEvent.click(screen.getByTestId("project-settings-dirty-discard"));
    expect(screen.queryByTestId("project-settings-dialog")).toBeNull();
  });

  it("не дублирует создание, удаление и тип колонок", async () => {
    const project = makeProject("project-1", "Релиз");
    const invoke = vi.fn<UiOperationInvoker>(
      simpleInvoke(project, [makeColumn("column-1", "ToDo")]),
    );

    renderHeader(project, invoke);
    await openSettings();

    expect(screen.queryByTestId("kanban-column-form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить колонку" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить колонку" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("project-settings-columns")).toBeInTheDocument();
  });
});
