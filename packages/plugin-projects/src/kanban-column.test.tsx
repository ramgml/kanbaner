import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
      onColorSelect={noop}
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
  it("имеет фиксированную desktop-ширину 288 px и мобильную 85vw", () => {
    renderColumn({ column: column("todo"), slug: "todo" }, []);

    const boardColumn = screen.getByTestId("kanban-column-todo");

    expect(boardColumn).toHaveClass("w-[85vw]");
    expect(boardColumn).toHaveClass("md:flex-[0_0_288px]");
    expect(boardColumn).toHaveClass("md:w-[288px]");
    expect(boardColumn).toHaveClass("md:min-w-[288px]");
    expect(boardColumn).toHaveClass("md:max-w-[288px]");
    expect(boardColumn).not.toHaveClass("md:flex-1");
  });

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
        onColorSelect={noop}
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
        onColorSelect={noop}
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

describe("KanbanColumn palette", () => {
  it("даёт восемь доступных кнопок цвета и отмечает выбранный цвет", () => {
    renderColumn({ column: { ...column("todo"), color: "blue" }, slug: "todo" }, []);

    const group = screen.getByRole("group", { name: "Цвет колонки «todo»" });
    const buttons = within(group).getAllByRole("button");

    expect(buttons).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Цвет колонки: Синий" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Цвет колонки: По умолчанию" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(buttons.every((button) => button.tagName === "BUTTON")).toBe(true);
    expect(screen.getByTestId("kanban-column-todo")).toHaveClass("bg-[#d7e5f6]");
    expect(screen.getByTestId("kanban-column-todo")).toHaveClass("dark:bg-[#20344c]");
  });

  it("выбирает цвет, закрывает меню и возвращает фокус на summary", () => {
    const onColorSelect = vi.fn();

    renderColumn({ column: column("todo"), slug: "todo", onColorSelect }, []);

    const menu = screen.getByTestId("kanban-column-menu-todo") as HTMLDetailsElement;

    menu.open = true;
    fireEvent.click(screen.getByTestId("kanban-column-color-todo-green"));

    expect(onColorSelect).toHaveBeenCalledWith("green");
    expect(menu.open).toBe(false);
    expect(screen.getByLabelText("Действия колонки «todo»")).toHaveFocus();
  });

  it("блокирует палитру во время сохранения и показывает ошибку цвета", () => {
    renderColumn(
      {
        column: { ...column("todo"), color: "red" },
        slug: "todo",
        pending: true,
        colorError: "Колонка изменена в другом месте",
      },
      [],
    );

    const group = screen.getByRole("group", { name: "Цвет колонки «todo»" });

    for (const button of within(group).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    expect(screen.getByTestId("kanban-column-color-error-todo")).toHaveTextContent(
      "Колонка изменена в другом месте",
    );
    expect(screen.getByTestId("kanban-column-todo")).toHaveAttribute("aria-busy", "true");
  });
});
