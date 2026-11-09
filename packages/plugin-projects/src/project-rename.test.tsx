import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@kanbaner/plugin-sdk";
import type {
  Project,
  ProjectMutationOutput,
  ProjectSummaryOutput,
  TaskStatus,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker, UiOperationResult } from "@kanbaner/task-ui";

import { KANBAN_ROUTE, PROJECTS_OVERVIEW_ROUTE } from "./metadata.ts";
import { KanbanView } from "./ui/kanban-view.tsx";
import { ProjectHeader } from "./ui/project-header.tsx";
import { ProjectRenameButton } from "./ui/project-rename.tsx";
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

function ok(data: JsonValue | null): UiOperationResult {
  return { ok: true, data };
}

function inputOf(input: JsonValue): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function mutation(project: Project): ProjectMutationOutput {
  return {
    project,
    resource: { type: "kanbaner.tasks.project", id: project.id },
    eventId: "event-rename",
  } as unknown as ProjectMutationOutput;
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

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/view/projects");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
});

describe("Переименование проекта", () => {
  it("не показывает кнопку в обзоре без активного проекта", () => {
    renderHeader(null, async () => ok(null), "overview");

    expect(screen.queryByTestId("project-rename-button")).toBeNull();
  });

  it("открывает диалог с текущим названием, выделяет его и возвращает фокус по Escape", async () => {
    const invoke = vi.fn<UiOperationInvoker>(async () => ok(null));

    renderHeader(makeProject("project-1", "Релиз"), invoke);

    const opener = screen.getByTestId("project-rename-button");

    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByTestId("project-rename-dialog");
    const input = screen.getByTestId("project-rename-input") as HTMLInputElement;

    expect(dialog).toBeInTheDocument();
    expect(input).toHaveValue("Релиз");
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Релиз".length);
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByTestId("project-rename-dialog")).toBeNull();
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("требует непустое название и сохраняет ввод при ошибке валидации", () => {
    const invoke = vi.fn<UiOperationInvoker>(async () => ok(null));

    renderHeader(makeProject("project-1", "Релиз"), invoke);

    fireEvent.click(screen.getByTestId("project-rename-button"));

    const input = screen.getByTestId("project-rename-input");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(screen.getByTestId("project-rename-form"));

    expect(screen.getByTestId("project-rename-error")).toHaveTextContent(
      "Укажите название проекта",
    );
    expect(screen.getByTestId("project-rename-dialog")).toBeInTheDocument();
    expect(input).toHaveValue("   ");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("отменяет без команды и не теряет ввод при ошибке сохранения", async () => {
    const invoke = vi.fn<UiOperationInvoker>(async () => ({
      ok: false,
      error: { code: "INTERNAL", message: "Сервер недоступен", retryable: true },
    }));

    renderHeader(makeProject("project-1", "Релиз"), invoke);

    fireEvent.click(screen.getByTestId("project-rename-button"));
    fireEvent.change(screen.getByTestId("project-rename-input"), {
      target: { value: "Новое название" },
    });
    fireEvent.submit(screen.getByTestId("project-rename-form"));

    await screen.findByTestId("project-rename-error");

    expect(screen.getByTestId("project-rename-error")).toHaveTextContent("Сервер недоступен");
    expect(screen.getByTestId("project-rename-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("project-rename-input")).toHaveValue("Новое название");

    fireEvent.click(screen.getByTestId("project-rename-cancel"));

    expect(screen.queryByTestId("project-rename-dialog")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("отправляет update с актуальной версией, обновляет заголовок и не меняет query", async () => {
    let project = makeProject("project-1", "Релиз");
    const updateInputs: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return ok({ items: [project], total: 1, nextOffset: null });
      }

      if (operationId === "kanbaner.tasks.project.summary") {
        return ok(summaryOf(project) as unknown as JsonValue);
      }

      if (operationId === "kanbaner.tasks.project.update") {
        const values = inputOf(input);

        updateInputs.push(values);
        project = {
          ...project,
          title: String(values.title),
          version: project.version + 1,
        };

        return ok(mutation(project) as unknown as JsonValue);
      }

      return ok({ items: [], total: 0, nextOffset: null });
    };

    window.history.replaceState(null, "", `/view/kanban?project=project-1`);
    resetKanbanQueryForTests("?project=project-1");

    render(<KanbanView invoke={invoke} pathname={KANBAN_ROUTE} search="?project=project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Релиз");
    });

    fireEvent.click(screen.getByTestId("project-rename-button"));
    fireEvent.change(screen.getByTestId("project-rename-input"), {
      target: { value: "  Релиз 2  " },
    });
    fireEvent.submit(screen.getByTestId("project-rename-form"));

    await waitFor(() => {
      expect(screen.queryByTestId("project-rename-dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("kanban-board-title")).toHaveTextContent("Релиз 2");
    });

    expect(updateInputs).toEqual([{ id: "project-1", expectedVersion: 1, title: "Релиз 2" }]);
    expect(window.location.search).toBe("?project=project-1");
  });

  it("показывает конфликт версии, читает снапшот и повторяет с новой версией", async () => {
    let conflict = true;
    const project = makeProject("project-1", "Релиз");
    const expectedVersions: number[] = [];
    let listCalls = 0;
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        listCalls += 1;

        return ok({
          items: [{ ...project, title: "Чужое название", version: 2 }],
          total: 1,
          nextOffset: null,
        } as unknown as JsonValue);
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
        mutation({ ...project, title: String(values.title), version: 3 }) as unknown as JsonValue,
      );
    };

    render(<ProjectRenameButton invoke={invoke} project={project} />);

    fireEvent.click(screen.getByTestId("project-rename-button"));
    fireEvent.change(screen.getByTestId("project-rename-input"), {
      target: { value: "Новое название" },
    });
    fireEvent.submit(screen.getByTestId("project-rename-form"));

    await screen.findByTestId("project-rename-error");

    expect(listCalls).toBe(1);
    expect(screen.getByTestId("project-rename-error")).toHaveTextContent(
      "Проект уже изменён в другом месте",
    );
    expect(screen.getByTestId("project-rename-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("project-rename-input")).toHaveValue("Новое название");

    // Повторная попытка использует версию из project.list, а не старый prop.
    fireEvent.submit(screen.getByTestId("project-rename-form"));

    await waitFor(() => {
      expect(screen.queryByTestId("project-rename-dialog")).toBeNull();
    });
    expect(expectedVersions).toEqual([1, 2]);
  });

  it("не отправляет команду до завершения refresh project.list и сохраняет фокус", async () => {
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

        return listResult;
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
        mutation({ ...project, title: String(values.title), version: 3 }) as unknown as JsonValue,
      );
    };

    render(<ProjectRenameButton invoke={invoke} project={project} />);

    fireEvent.click(screen.getByTestId("project-rename-button"));

    const input = screen.getByTestId("project-rename-input");

    fireEvent.change(input, { target: { value: "Новое название" } });
    fireEvent.submit(screen.getByTestId("project-rename-form"));

    await waitFor(() => {
      expect(listCalls).toBe(1);
    });

    // Refresh ещё идёт: нет преждевременного сообщения, команда не уходит.
    expect(updateCalls).toBe(1);
    expect(screen.queryByTestId("project-rename-error")).toBeNull();
    expect(screen.getByTestId("project-rename-submit")).toBeDisabled();

    fireEvent.submit(screen.getByTestId("project-rename-form"));
    expect(updateCalls).toBe(1);

    await act(async () => {
      resolveList(
        ok({
          items: [{ ...project, title: "Чужое название", version: 2 }],
          total: 1,
          nextOffset: null,
        } as unknown as JsonValue),
      );
      await listResult;
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-rename-error")).toHaveTextContent(
        "Проект уже изменён в другом месте",
      );
    });
    expect(input).toHaveValue("Новое название");
    expect(screen.getByTestId("project-rename-submit")).toBeEnabled();
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    fireEvent.submit(screen.getByTestId("project-rename-form"));

    await waitFor(() => {
      expect(screen.queryByTestId("project-rename-dialog")).toBeNull();
    });
    expect(expectedVersions).toEqual([1, 2]);
  });

  it("отдельно сообщает об ошибке refresh и не выдаёт её за успешное чтение", async () => {
    let updateCalls = 0;
    const project = makeProject("project-1", "Релиз");
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === "kanbaner.tasks.project.list") {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Список недоступен", retryable: true },
        };
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

    render(<ProjectRenameButton invoke={invoke} project={project} />);

    fireEvent.click(screen.getByTestId("project-rename-button"));
    fireEvent.change(screen.getByTestId("project-rename-input"), {
      target: { value: "Новое название" },
    });
    fireEvent.submit(screen.getByTestId("project-rename-form"));

    await waitFor(() => {
      expect(screen.getByTestId("project-rename-error")).toHaveTextContent(
        "Не удалось обновить версию проекта",
      );
    });
    expect(screen.getByTestId("project-rename-error")).not.toHaveTextContent("Проект уже изменён");
    expect(screen.getByTestId("project-rename-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("project-rename-input")).toHaveValue("Новое название");
    expect(screen.getByTestId("project-rename-submit")).toBeEnabled();
    expect(updateCalls).toBe(1);
  });

  it("защищает от двойной отправки одним запросом", async () => {
    const invoke = vi.fn<UiOperationInvoker>(async () =>
      ok(mutation(makeProject("project-1", "Новое", 2)) as unknown as JsonValue),
    );

    render(<ProjectRenameButton invoke={invoke} project={makeProject("project-1", "Релиз")} />);

    fireEvent.click(screen.getByTestId("project-rename-button"));
    fireEvent.change(screen.getByTestId("project-rename-input"), {
      target: { value: "Новое" },
    });

    const form = screen.getByTestId("project-rename-form");

    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("project-rename-dialog")).toBeNull();
    });
  });
});
