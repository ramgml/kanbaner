import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

import { NoteLinkPicker } from "./note-link-picker.tsx";
import type { UiOperationInvoker, UiOperationResult } from "./runtime.ts";

function success(data: unknown): UiOperationResult {
  return { ok: true, data: data as JsonValue };
}

function failure(message: string): UiOperationResult {
  return {
    ok: false,
    error: { code: "test.error", message, retryable: true },
  };
}

const PROJECTS = {
  items: [
    { id: "project-1", title: "Оформление заказа" },
    { id: "project-2", title: "Личный кабинет" },
  ],
  total: 2,
  nextOffset: null,
};

const TASKS = {
  items: [
    { id: "task-1", title: "Починить корзину" },
    { id: "task-2", title: "Обновить вход" },
  ],
  total: 2,
  nextOffset: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NoteLinkPicker", () => {
  it("показывает загрузку, пока проекты и задачи не загружены", async () => {
    const invoke: UiOperationInvoker = () => new Promise<UiOperationResult>(() => {});
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={vi.fn()} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));

    expect(await screen.findByTestId("note-link-picker-loading")).toHaveTextContent(
      "Загрузка проектов и задач",
    );
  });

  it("показывает empty state, когда проектов и задач нет", async () => {
    const invoke: UiOperationInvoker = async () => success({ items: [], nextOffset: null });
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={vi.fn()} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));

    expect(await screen.findByTestId("note-link-picker-empty")).toHaveTextContent(
      "Нет доступных проектов и задач",
    );
  });

  it("показывает названия и типы, фильтрует по названию и сообщает об отсутствии совпадений", async () => {
    const invoke: UiOperationInvoker = async (operationId) =>
      operationId === "kanbaner.tasks.project.list" ? success(PROJECTS) : success(TASKS);
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={vi.fn()} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));

    const project = await screen.findByRole("option", { name: /Оформление заказа/ });
    expect(project).toHaveTextContent("Проект");
    const task = screen.getByRole("option", { name: /Починить корзину/ });
    expect(task).toHaveTextContent("Задача");

    const search = screen.getByRole("combobox", { name: "Поиск проекта или задачи" });
    fireEvent.change(search, { target: { value: "корзин" } });
    expect(screen.queryByRole("option", { name: /Оформление заказа/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Починить корзину/ })).toBeVisible();
    expect(screen.getByRole("option")).toHaveTextContent("Задача");

    fireEvent.change(search, { target: { value: "ничего такого" } });
    expect(await screen.findByTestId("note-link-picker-no-results")).toHaveTextContent(
      "Ничего не найдено",
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("выбирает ресурс с клавиатуры и закрывает picker по Escape", async () => {
    const onLink = vi.fn(async () => true);
    const invoke: UiOperationInvoker = async (operationId) =>
      operationId === "kanbaner.tasks.project.list" ? success(PROJECTS) : success(TASKS);
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={onLink} />);

    const trigger = screen.getByTestId("note-link-picker-trigger");
    fireEvent.click(trigger);
    const search = await screen.findByRole("combobox", { name: "Поиск проекта или задачи" });
    await screen.findByRole("option", { name: /Оформление заказа/ });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() =>
      expect(onLink).toHaveBeenCalledWith("kanbaner.tasks:task:task-1" as ResourceRef),
    );
    await waitFor(() => expect(screen.queryByTestId("note-link-picker")).not.toBeInTheDocument());

    fireEvent.click(trigger);
    await screen.findByTestId("note-link-picker");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Поиск проекта или задачи" }), {
      key: "Escape",
    });
    expect(screen.queryByTestId("note-link-picker")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("показывает ошибку загрузки и повторяет запрос", async () => {
    let failing = true;
    const invoke: UiOperationInvoker = async (operationId) => {
      if (failing) return failure("Сеть недоступна");
      return operationId === "kanbaner.tasks.project.list" ? success(PROJECTS) : success(TASKS);
    };
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={vi.fn()} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));

    const alert = await screen.findByTestId("note-link-picker-error");
    expect(alert).toHaveTextContent("Проекты: Сеть недоступна");
    expect(alert).toHaveTextContent("Задачи: Сеть недоступна");

    failing = false;
    fireEvent.click(screen.getByTestId("note-link-picker-retry"));

    expect(await screen.findByRole("option", { name: /Оформление заказа/ })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByTestId("note-link-picker-error")).not.toBeInTheDocument(),
    );
  });

  it("сохраняет ошибку незапрошенного источника после «Показать ещё»", async () => {
    const taskCalls: number[] = [];
    const projectCalls: number[] = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        const offset = (input as { readonly offset: number }).offset;
        projectCalls.push(offset);
        return offset === 0
          ? success({
              items: [{ id: "project-1", title: "Оформление заказа" }],
              total: 2,
              nextOffset: 100,
            })
          : success({
              items: [{ id: "project-2", title: "Личный кабинет" }],
              total: 2,
              nextOffset: null,
            });
      }
      if (operationId === "kanbaner.tasks.task.list") {
        taskCalls.push(0);
        return failure("Сеть недоступна");
      }
      return success({ items: [] });
    };
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={vi.fn()} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));
    await screen.findByRole("option", { name: /Оформление заказа/ });
    expect(screen.getByTestId("note-link-picker-error")).toHaveTextContent(
      "Задачи: Сеть недоступна",
    );

    fireEvent.click(screen.getByTestId("note-link-picker-more"));
    expect(await screen.findByRole("option", { name: /Личный кабинет/ })).toBeVisible();

    expect(projectCalls).toEqual([0, 100]);
    expect(taskCalls).toHaveLength(1);
    const alert = await screen.findByTestId("note-link-picker-error");
    expect(alert).toHaveTextContent("Задачи: Сеть недоступна");
    expect(screen.getByTestId("note-link-picker-retry")).toBeVisible();
  });

  it("догружает вторую страницу для поиска и не показывает ложное «Ничего не найдено»", async () => {
    const projectOffsets: number[] = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === "kanbaner.tasks.project.list") {
        const offset = (input as { readonly offset: number }).offset;
        projectOffsets.push(offset);
        return offset === 0
          ? success({
              items: [{ id: "project-1", title: "Оформление заказа" }],
              total: 2,
              nextOffset: 100,
            })
          : success({
              items: [{ id: "project-2", title: "Личный кабинет" }],
              total: 2,
              nextOffset: null,
            });
      }
      return success({ items: [], nextOffset: null });
    };
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={vi.fn()} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));
    await screen.findByRole("option", { name: /Оформление заказа/ });

    fireEvent.change(screen.getByRole("combobox", { name: "Поиск проекта или задачи" }), {
      target: { value: "Личный кабинет" },
    });

    expect(screen.queryByTestId("note-link-picker-no-results")).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /Личный кабинет/ })).toBeVisible();
    expect(projectOffsets).toEqual([0, 100]);
    expect(screen.queryByTestId("note-link-picker-no-results")).not.toBeInTheDocument();
  });

  it("останавливает автодогрузку после ошибки второй страницы", async () => {
    let invocations = 0;
    let failedPageCalls = 0;
    const invoke: UiOperationInvoker = async (operationId, input) => {
      invocations += 1;
      if (operationId === "kanbaner.tasks.project.list") {
        const offset = (input as { readonly offset: number }).offset;
        if (offset === 0) {
          return success({
            items: [{ id: "project-1", title: "Оформление заказа" }],
            total: 2,
            nextOffset: 100,
          });
        }
        failedPageCalls += 1;
        return failure("Сеть недоступна");
      }
      return success({ items: [], nextOffset: null });
    };
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={vi.fn()} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));
    await screen.findByRole("option", { name: /Оформление заказа/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Поиск проекта или задачи" }), {
      target: { value: "Нет такого названия" },
    });

    const alert = await screen.findByTestId("note-link-picker-error");
    expect(alert).toHaveTextContent("Проекты: Сеть недоступна");
    expect(screen.getByTestId("note-link-picker-retry")).toBeVisible();
    expect(failedPageCalls).toBe(1);

    const stableCount = invocations;
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    });

    expect(failedPageCalls).toBe(1);
    expect(invocations).toBe(stableCount);
    expect(screen.getByTestId("note-link-picker-error")).toHaveTextContent(
      "Проекты: Сеть недоступна",
    );
  });

  it("не уводит Tab в options и сохраняет фокус combobox при неуспешном выборе", async () => {
    const onLink = vi.fn(async () => false);
    const invoke: UiOperationInvoker = async (operationId) =>
      operationId === "kanbaner.tasks.project.list" ? success(PROJECTS) : success(TASKS);
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={onLink} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));
    const search = await screen.findByRole("combobox", { name: "Поиск проекта или задачи" });
    const option = await screen.findByRole("option", { name: /Оформление заказа/ });
    expect(option).toHaveAttribute("tabindex", "-1");

    option.focus();
    expect(option).toHaveFocus();
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    await waitFor(() => expect(onLink).toHaveBeenCalledTimes(1));
    expect(search).toHaveFocus();
    expect(screen.getByTestId("note-link-picker")).toBeVisible();
  });

  it("поддерживает Home и End в списке вариантов", async () => {
    const onLink = vi.fn(async () => true);
    const invoke: UiOperationInvoker = async (operationId) =>
      operationId === "kanbaner.tasks.project.list" ? success(PROJECTS) : success(TASKS);
    render(<NoteLinkPicker noteId="note-1" invoke={invoke} busy={false} onLink={onLink} />);

    const trigger = screen.getByTestId("note-link-picker-trigger");
    fireEvent.click(trigger);
    let search = await screen.findByRole("combobox", { name: "Поиск проекта или задачи" });
    await screen.findByRole("option", { name: /Оформление заказа/ });

    fireEvent.keyDown(search, { key: "End" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(onLink).toHaveBeenLastCalledWith("kanbaner.tasks:task:task-2" as ResourceRef),
    );

    fireEvent.click(trigger);
    search = await screen.findByRole("combobox", { name: "Поиск проекта или задачи" });
    await screen.findByRole("option", { name: /Оформление заказа/ });
    fireEvent.keyDown(search, { key: "Home" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(onLink).toHaveBeenLastCalledWith("kanbaner.tasks:project:project-1" as ResourceRef),
    );
  });
});
