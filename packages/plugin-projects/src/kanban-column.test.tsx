import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskColumn, TaskStatus } from "@kanbaner/plugin-tasks/contract";

import { KanbanColumn, type KanbanColumnProps } from "./ui/kanban-column.tsx";

afterEach(() => {
  cleanup();
});

const noop = vi.fn();
const TIMESTAMP = "2026-02-01T00:00:00.000Z";

function column(status: TaskStatus, id = `column-project-1-legacy-${status}`): TaskColumn {
  return {
    id,
    projectId: "project-1",
    title: status === "in_progress" ? "In progress" : status,
    status,
    position: 0,
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function renderColumn(
  overrides: Partial<KanbanColumnProps> & Pick<KanbanColumnProps, "column" | "slug">,
  children: KanbanColumnProps["children"],
) {
  return render(
    <KanbanColumn
      total={0}
      loading={false}
      error={null}
      hasMore={false}
      dragOver={false}
      dropActive={false}
      pending={false}
      conflict={false}
      canMoveLeft={false}
      canMoveRight={false}
      canDelete
      deleteDisabledReason={null}
      rename={{ open: false, value: "", error: null, submitting: false }}
      onRenameOpen={noop}
      onRenameValueChange={noop}
      onRenameSubmit={noop}
      onRenameCancel={noop}
      onMoveLeft={noop}
      onMoveRight={noop}
      onDelete={noop}
      onDragStart={noop}
      onLoadMore={noop}
      onRetry={noop}
      quickComposer={<div data-testid="composer-trigger" />}
      {...overrides}
    >
      {children}
    </KanbanColumn>,
  );
}

describe("KanbanColumn composer", () => {
  it("ставит composer сразу после header, до ошибки и прокручиваемого списка", () => {
    renderColumn(
      {
        column: column("todo"),
        slug: "todo",
        total: 3,
        error: "Не удалось загрузить",
        hasMore: true,
        quickComposer: <button data-testid="composer-trigger">+ Добавить карточку</button>,
      },
      [
        <li key="1" data-testid="card-1">
          Карточка 1
        </li>,
        <li key="2" data-testid="card-2">
          Карточка 2
        </li>,
      ],
    );

    const boardColumn = screen.getByTestId("kanban-column-todo");
    const header = boardColumn.querySelector("header");
    const composer = screen.getByTestId("kanban-quick-composer-todo");
    const error = screen.getByTestId("kanban-column-error-todo");
    const scroll = screen.getByTestId("kanban-column-scroll-todo");

    expect(boardColumn.firstElementChild).toBe(header);
    expect(header?.nextElementSibling).toBe(composer);
    expect(composer).toContainElement(screen.getByTestId("composer-trigger"));
    expect(composer).toHaveClass("shrink-0");
    expect(scroll).not.toContainElement(composer);
    expect(composer.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      composer.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByTestId("composer-trigger")).toHaveLength(1);
  });

  it("оставляет composer выше loading и длинного списка карточек", () => {
    renderColumn(
      {
        column: column("backlog"),
        slug: "backlog",
        total: 0,
        loading: true,
      },
      Array.from({ length: 40 }, (_, index) => (
        <li key={index} data-testid={`card-${String(index)}`}>
          Карточка {String(index)}
        </li>
      )),
    );

    const boardColumn = screen.getByTestId("kanban-column-backlog");
    const header = boardColumn.querySelector("header");
    const composer = screen.getByTestId("kanban-quick-composer-backlog");
    const loading = screen.getByTestId("task-ui-loading");
    const scroll = screen.getByTestId("kanban-column-scroll-backlog");

    expect(header?.nextElementSibling).toBe(composer);
    expect(screen.getAllByTestId("composer-trigger")).toHaveLength(1);
    expect(
      composer.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(scroll).toContainElement(screen.getByTestId("card-39"));
    expect(scroll).not.toContainElement(composer);
  });

  it("показывает действия колонки, rename-форму и причину запрета удаления", () => {
    const onRenameOpen = vi.fn();
    const { rerender } = renderColumn({ column: column("todo"), slug: "todo", onRenameOpen }, []);

    expect(screen.getByRole("button", { name: "Перетащить колонку «todo»" })).toBeVisible();
    expect(screen.getByLabelText("Действия колонки «todo»")).toBeVisible();
    expect(screen.getByRole("button", { name: "Переименовать" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Удалить колонку" })).toBeEnabled();

    rerender(
      <KanbanColumn
        column={column("todo")}
        slug="todo"
        total={1}
        loading={false}
        error={null}
        hasMore={false}
        dragOver={false}
        dropActive={false}
        pending={false}
        conflict
        canMoveLeft={false}
        canMoveRight={false}
        canDelete={false}
        deleteDisabledReason="Последняя открытая колонка проекта — удаление недоступно."
        rename={{ open: true, value: "Новое", error: "Ошибка", submitting: false }}
        onRenameOpen={noop}
        onRenameValueChange={noop}
        onRenameSubmit={noop}
        onRenameCancel={noop}
        onMoveLeft={noop}
        onMoveRight={noop}
        onDelete={noop}
        onDragStart={noop}
        onLoadMore={noop}
        onRetry={noop}
        quickComposer={null}
      >
        <li data-testid="card-1">Карточка</li>
      </KanbanColumn>,
    );

    expect(screen.getByTestId("kanban-column-rename-form-todo")).toBeVisible();
    expect(screen.getByLabelText("Новое название колонки")).toHaveValue("Новое");
    expect(screen.getByTestId("kanban-column-rename-error-todo")).toHaveTextContent("Ошибка");
    expect(screen.getByTestId("kanban-column-conflict-todo")).toHaveTextContent("Конфликт версий");

    rerender(
      <KanbanColumn
        column={column("todo")}
        slug="todo"
        total={1}
        loading={false}
        error={null}
        hasMore={false}
        dragOver={false}
        dropActive={false}
        pending={false}
        conflict={false}
        canMoveLeft={false}
        canMoveRight={false}
        canDelete={false}
        deleteDisabledReason="Последняя открытая колонка проекта — удаление недоступно."
        rename={{ open: false, value: "", error: null, submitting: false }}
        onRenameOpen={noop}
        onRenameValueChange={noop}
        onRenameSubmit={noop}
        onRenameCancel={noop}
        onMoveLeft={noop}
        onMoveRight={noop}
        onDelete={noop}
        onDragStart={noop}
        onLoadMore={noop}
        onRetry={noop}
        quickComposer={null}
      >
        <li data-testid="card-1">Карточка</li>
      </KanbanColumn>,
    );

    expect(screen.getByRole("button", { name: "Удалить колонку" })).toBeDisabled();
    expect(
      screen.getByText("Последняя открытая колонка проекта — удаление недоступно."),
    ).toBeInTheDocument();
  });
});
