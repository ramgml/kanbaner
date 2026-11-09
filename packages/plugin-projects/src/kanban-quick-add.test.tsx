import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanQuickComposer, type QuickCreateResult } from "./ui/kanban-quick-composer.tsx";

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
  it("открывает поле названия с autofocus и создаёт задачу", async () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));

    render(
      <KanbanQuickComposer
        status="todo"
        projectId="project-1"
        disabled={false}
        onCreate={onCreate}
      />,
    );

    const opener = screen.getByTestId("kanban-quick-add-todo");

    expect(opener).toHaveAccessibleName("Добавить карточку в колонку «К выполнению»");
    fireEvent.click(opener);

    const input = screen.getByTestId("kanban-quick-add-todo-input");

    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("type", "text");
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    fireEvent.change(input, { target: { value: "Первая быстрая" } });
    fireEvent.click(screen.getByTestId("kanban-quick-add-todo-submit"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Первая быстрая");
    });
    await waitFor(() => {
      expect(input).toHaveValue("");
      expect(input).toHaveFocus();
    });
    expect(screen.getByTestId("kanban-quick-add-todo-form")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Вторая быстрая" } });
    fireEvent.click(screen.getByTestId("kanban-quick-add-todo-submit"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(2);
    });
  });

  it("не добавляет строку и закрывается по Escape", async () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));

    render(
      <KanbanQuickComposer
        status="todo"
        projectId="project-1"
        disabled={false}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    const input = screen.getByTestId("kanban-quick-add-todo-input");

    fireEvent.change(input, { target: { value: "Первая строка" } });
    expect(input).toHaveValue("Первая строка");
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("kanban-quick-add-todo-form")).toBeNull();
    const opener = screen.getByTestId("kanban-quick-add-todo");

    expect(opener).toBeInTheDocument();
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it("возвращает фокус в поле после submit мышью только при submitting=false", async () => {
    const pending = deferred<QuickCreateResult>();
    const onCreate = vi.fn(() => pending.promise);

    render(
      <KanbanQuickComposer
        status="todo"
        projectId="project-1"
        disabled={false}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    const input = screen.getByTestId("kanban-quick-add-todo-input");

    fireEvent.change(input, { target: { value: "Фокус после мыши" } });

    const submit = screen.getByTestId("kanban-quick-add-todo-submit");

    input.blur();
    expect(input).not.toHaveFocus();

    fireEvent.click(submit);

    // Пока команда не завершилась, поле disabled и фокус не ставится.
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
        projectId="project-1"
        disabled={false}
        resetToken={0}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    const input = screen.getByTestId("kanban-quick-add-todo-input");

    fireEvent.change(input, { target: { value: "Черновик из формы" } });
    expect(input).toHaveValue("Черновик из формы");

    rerender(
      <KanbanQuickComposer
        status="todo"
        projectId="project-1"
        disabled={false}
        resetToken={1}
        onCreate={onCreate}
      />,
    );

    expect(screen.getByTestId("kanban-quick-add-todo-form")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("без проекта блокирует отправку и не теряет заголовок", async () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));

    render(
      <KanbanQuickComposer status="backlog" projectId="" disabled={false} onCreate={onCreate} />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-backlog"));

    const input = screen.getByTestId("kanban-quick-add-backlog-input");

    fireEvent.change(input, { target: { value: "Заголовок не теряется" } });
    fireEvent.submit(screen.getByTestId("kanban-quick-add-backlog-form"));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId("kanban-quick-add-backlog-error")).toHaveTextContent(
      "Выберите проект",
    );
    expect(input).toHaveValue("Заголовок не теряется");
    expect(screen.getByTestId("kanban-quick-add-backlog-submit")).toBeDisabled();
    // Проект определяется доской: внутреннего выбора проекта больше нет.
    expect(screen.queryByRole("combobox", { name: "Проект" })).toBeNull();
  });

  it("сохраняет текст при ошибке и не отправляет дважды", async () => {
    const pending = deferred<QuickCreateResult>();
    const onCreate = vi.fn(() => pending.promise);

    render(
      <KanbanQuickComposer
        status="done"
        projectId="project-1"
        disabled={false}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-done"));

    const input = screen.getByTestId("kanban-quick-add-done-input");

    fireEvent.change(input, { target: { value: "Черновик при ошибке" } });

    const submit = screen.getByTestId("kanban-quick-add-done-submit");

    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(screen.getByTestId("kanban-quick-add-done-form"));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: false, message: "Сервер недоступен" });
      await pending.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("kanban-quick-add-done-error")).toHaveTextContent(
        "Сервер недоступен",
      );
    });
    expect(input).toHaveValue("Черновик при ошибке");
    expect(screen.getByTestId("kanban-quick-add-done-form")).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it("не предлагает полную форму и блокируется без проекта", () => {
    const onCreate = vi.fn(async (): Promise<QuickCreateResult> => ({ ok: true }));

    const { rerender } = render(
      <KanbanQuickComposer
        status="todo"
        projectId="project-1"
        disabled={false}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-quick-add-todo"));

    expect(screen.queryByTestId("kanban-quick-details-todo")).toBeNull();
    expect(screen.queryByTestId("task-form-create")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("kanban-quick-add-todo-input"), { key: "Escape" });

    rerender(<KanbanQuickComposer status="todo" projectId="" disabled onCreate={onCreate} />);

    expect(screen.getByTestId("kanban-quick-add-todo")).toBeDisabled();
  });
});
