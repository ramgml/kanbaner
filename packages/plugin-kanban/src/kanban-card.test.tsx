import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@kanbaner/plugin-tasks/contract";

import { KanbanCard } from "./ui/kanban-card.tsx";

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    parentTaskId: null,
    title: "Компактная карточка",
    descriptionMarkdown: "",
    priority: "high",
    dueAt: null,
    position: 0,
    tags: [],
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    status: "todo",
    completedAt: null,
    ...overrides,
  } as Task;
}

function renderCard(task: Task, overrides: Partial<Parameters<typeof KanbanCard>[0]> = {}) {
  return render(
    <KanbanCard
      task={task}
      index={0}
      columnSize={1}
      subtaskCount={1}
      selected={false}
      pending={false}
      conflict={false}
      dragging={false}
      onOpen={vi.fn()}
      onMoveTo={vi.fn()}
      onReorder={vi.fn()}
      onDragStart={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("KanbanCard", () => {
  it("показывает максимум два тега и счётчик остальных", () => {
    renderCard(makeTask({ tags: ["release", "backend", "ui", "docs"] }));

    const card = screen.getByTestId("kanban-card-task-1");

    expect(card).toHaveTextContent("release");
    expect(card).toHaveTextContent("backend");
    expect(card).not.toHaveTextContent("ui");
    expect(card).not.toHaveTextContent("docs");
    expect(within(card).getByLabelText("Ещё тегов: 2")).toHaveTextContent("+2");
  });

  it("показывает компактный срок с доступным текстом и датой", () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { rerender } = renderCard(makeTask({ dueAt: "2020-01-01T00:00:00.000Z" }));

    expect(screen.getByTestId("kanban-due-task-1")).toHaveTextContent("Просрочено");

    rerender(
      <KanbanCard
        task={makeTask({ dueAt: `${today}T00:00:00.000Z` })}
        index={0}
        columnSize={1}
        subtaskCount={1}
        selected={false}
        pending={false}
        conflict={false}
        dragging={false}
        onOpen={vi.fn()}
        onMoveTo={vi.fn()}
        onReorder={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId("kanban-due-task-1")).toHaveTextContent("Сегодня");

    rerender(
      <KanbanCard
        task={makeTask({ dueAt: `${tomorrow}T00:00:00.000Z` })}
        index={0}
        columnSize={1}
        subtaskCount={1}
        selected={false}
        pending={false}
        conflict={false}
        dragging={false}
        onOpen={vi.fn()}
        onMoveTo={vi.fn()}
        onReorder={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId("kanban-due-task-1")).toHaveTextContent("Завтра");

    rerender(
      <KanbanCard
        task={makeTask({ dueAt: "2030-01-10T00:00:00.000Z" })}
        index={0}
        columnSize={1}
        subtaskCount={1}
        selected={false}
        pending={false}
        conflict={false}
        dragging={false}
        onOpen={vi.fn()}
        onMoveTo={vi.fn()}
        onReorder={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId("kanban-due-task-1")).toHaveTextContent("10.01.2030");
    expect(screen.getByTestId("kanban-due-task-1")).toHaveAttribute(
      "aria-label",
      "Срок 10.01.2030",
    );
  });

  it("показывает бейдж проекта только в режиме «Все проекты»", () => {
    const { rerender } = renderCard(makeTask(), { projectTitle: "Проект один" });

    expect(screen.getByTestId("kanban-project-badge-task-1")).toHaveTextContent("Проект один");

    rerender(
      <KanbanCard
        task={makeTask()}
        index={0}
        columnSize={1}
        subtaskCount={1}
        selected={false}
        pending={false}
        conflict={false}
        dragging={false}
        projectTitle={null}
        onOpen={vi.fn()}
        onMoveTo={vi.fn()}
        onReorder={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("kanban-project-badge-task-1")).toBeNull();
  });

  it("показывает pending и conflict без постоянной лишней строки", () => {
    const { rerender } = renderCard(makeTask());

    expect(screen.queryByTestId("kanban-pending-task-1")).toBeNull();
    expect(screen.queryByTestId("kanban-conflict-task-1")).toBeNull();

    rerender(
      <KanbanCard
        task={makeTask()}
        index={0}
        columnSize={1}
        subtaskCount={1}
        selected={false}
        pending
        conflict
        dragging={false}
        onOpen={vi.fn()}
        onMoveTo={vi.fn()}
        onReorder={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );

    expect(screen.getByTestId("kanban-pending-task-1")).toHaveTextContent("Сохранение…");
    expect(screen.getByTestId("kanban-conflict-task-1")).toHaveTextContent("Конфликт версий");
    expect(screen.getByTestId("kanban-card-task-1")).toHaveAttribute("aria-busy", "true");
  });

  it("сохраняет действия меню и drag handle доступными с клавиатуры", () => {
    renderCard(makeTask());

    expect(
      screen.getByRole("button", { name: "Открыть карточку задачи Компактная карточка" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Перетащить задачу Компактная карточка" }),
    ).toBeVisible();

    const summary = screen
      .getByTestId("kanban-menu-task-1")
      .querySelector("summary") as HTMLElement;

    expect(summary).toHaveAccessibleName("Действия карточки Компактная карточка");

    fireEvent.click(screen.getByRole("button", { name: "Выше" }));

    expect(screen.getByRole("button", { name: "Выше" })).toBeDisabled();
  });
});
