import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
