import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@kanbaner/plugin-tasks/contract";

import { KanbanQuickComposer, type QuickCreateResult } from "./ui/kanban-quick-composer.tsx";

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

afterEach(() => {
  cleanup();
});

describe("KanbanQuickComposer", () => {
  it("открывает textarea с autofocus и создаёт задачу по Enter", async () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));
    const onOpenDetails = vi.fn();

    render(
      <KanbanQuickComposer
        status="todo"
        projects={[makeProject("project-1")]}
        activeProjectId="project-1"
        disabled={false}
        onCreate={onCreate}
        onOpenDetails={onOpenDetails}
      />,
    );

    const opener = screen.getByTestId("kanban-quick-add-todo");

    expect(opener).toHaveAccessibleName("Добавить карточку в колонку «К выполнению»");
    fireEvent.click(opener);

    const input = screen.getByTestId("kanban-quick-add-input-todo");

    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    fireEvent.change(input, { target: { value: "Первая быстрая" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({ title: "Первая быстрая", projectId: "project-1" });
    });
    await waitFor(() => {
      expect(input).toHaveValue("");
      expect(input).toHaveFocus();
    });
    expect(screen.getByTestId("kanban-quick-add-form-todo")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Вторая быстрая" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(2);
    });
  });

  it("Shift+Enter добавляет строку, Escape закрывает composer", async () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));

    render(
      <KanbanQuickComposer
        status="todo"
        projects={[makeProject("project-1")]}
        activeProjectId="project-1"
        disabled={false}
        onCreate={onCreate}
        onOpenDetails={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    const input = screen.getByTestId("kanban-quick-add-input-todo");

    fireEvent.change(input, { target: { value: "Первая строка" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onCreate).not.toHaveBeenCalled();
    expect(input).toHaveValue("Первая строка");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("kanban-quick-add-form-todo")).toBeNull();
    const opener = screen.getByTestId("kanban-quick-add-todo");

    expect(opener).toBeInTheDocument();
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it("возвращает фокус в textarea после submit мышью только при submitting=false", async () => {
    const pending = deferred<QuickCreateResult>();
    const onCreate = vi.fn(() => pending.promise);

    render(
      <KanbanQuickComposer
        status="todo"
        projects={[makeProject("project-1")]}
        activeProjectId="project-1"
        disabled={false}
        onCreate={onCreate}
        onOpenDetails={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    const input = screen.getByTestId("kanban-quick-add-input-todo");

    fireEvent.change(input, { target: { value: "Фокус после мыши" } });

    const submit = screen.getByTestId("kanban-quick-add-submit-todo");

    input.blur();
    expect(input).not.toHaveFocus();

    fireEvent.click(submit);

    // Пока команда не завершилась, textarea disabled и фокус не ставится.
    expect(input).toBeDisabled();
    expect(input).not.toHaveFocus();

    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });

    await waitFor(() => {
      expect(input).toBeEnabled();
      expect(input).toHaveValue("");
      expect(input).toHaveFocus();
    });
  });

  it("очищает originating draft по resetToken, оставаясь открытым", async () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));

    const { rerender } = render(
      <KanbanQuickComposer
        status="todo"
        projects={[makeProject("project-1")]}
        activeProjectId="project-1"
        disabled={false}
        resetToken={0}
        onCreate={onCreate}
        onOpenDetails={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    const input = screen.getByTestId("kanban-quick-add-input-todo");

    fireEvent.change(input, { target: { value: "Черновик из формы" } });
    expect(input).toHaveValue("Черновик из формы");

    rerender(
      <KanbanQuickComposer
        status="todo"
        projects={[makeProject("project-1")]}
        activeProjectId="project-1"
        disabled={false}
        resetToken={1}
        onCreate={onCreate}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByTestId("kanban-quick-add-form-todo")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("в режиме «Все проекты» просит проект, не теряя заголовок", async () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));

    render(
      <KanbanQuickComposer
        status="backlog"
        projects={[makeProject("project-1", "Первый"), makeProject("project-2", "Второй")]}
        activeProjectId=""
        disabled={false}
        onCreate={onCreate}
        onOpenDetails={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-backlog"));

    const input = screen.getByTestId("kanban-quick-add-input-backlog");

    fireEvent.change(input, { target: { value: "Заголовок не теряется" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId("kanban-quick-add-error-backlog")).toHaveTextContent(
      "Выберите проект",
    );
    expect(input).toHaveValue("Заголовок не теряется");

    const projectSelect = screen.getByRole("combobox", { name: "Проект" });

    fireEvent.change(projectSelect, { target: { value: "project-2" } });

    expect(input).toHaveValue("Заголовок не теряется");

    fireEvent.click(screen.getByTestId("kanban-quick-add-submit-backlog"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "Заголовок не теряется",
        projectId: "project-2",
      });
    });
  });

  it("сохраняет текст при ошибке и не отправляет дважды", async () => {
    const pending = deferred<QuickCreateResult>();
    const onCreate = vi.fn(() => pending.promise);

    render(
      <KanbanQuickComposer
        status="done"
        projects={[makeProject("project-1")]}
        activeProjectId="project-1"
        disabled={false}
        onCreate={onCreate}
        onOpenDetails={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-done"));

    const input = screen.getByTestId("kanban-quick-add-input-done");

    fireEvent.change(input, { target: { value: "Черновик при ошибке" } });

    const submit = screen.getByTestId("kanban-quick-add-submit-done");

    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(screen.getByTestId("kanban-quick-add-form-done"));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: false, message: "Сервер недоступен" });
      await pending.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-quick-add-error-done")).toHaveTextContent(
        "Сервер недоступен",
      );
    });
    expect(input).toHaveValue("Черновик при ошибке");
    expect(screen.getByTestId("kanban-quick-add-form-done")).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it("передаёт черновик в полную форму и блокируется без проектов", () => {
    const onOpenDetails = vi.fn();

    const { rerender } = render(
      <KanbanQuickComposer
        status="todo"
        projects={[makeProject("project-1")]}
        activeProjectId="project-1"
        disabled={false}
        onCreate={vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }))}
        onOpenDetails={onOpenDetails}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));
    fireEvent.change(screen.getByTestId("kanban-quick-add-input-todo"), {
      target: { value: "Заголовок для деталей" },
    });
    fireEvent.click(screen.getByTestId("kanban-quick-details-todo"));

    expect(onOpenDetails).toHaveBeenCalledWith({
      title: "Заголовок для деталей",
      projectId: "project-1",
    });

    fireEvent.keyDown(screen.getByTestId("kanban-quick-add-input-todo"), { key: "Escape" });

    rerender(
      <KanbanQuickComposer
        status="todo"
        projects={[]}
        activeProjectId=""
        disabled
        onCreate={vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }))}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByTestId("kanban-quick-add-todo")).toBeDisabled();
  });
});
