import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskColumn } from "@kanbaner/plugin-tasks/contract";

import { KanbanCard } from "./ui/kanban-card.tsx";

const TIMESTAMP = "2026-02-01T00:00:00.000Z";

const COLUMNS: readonly TaskColumn[] = [
  {
    id: "column-project-1-legacy-todo",
    projectId: "project-1",
    title: "К выполнению",
    status: "todo",
    position: 0,
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  {
    id: "column-project-1-legacy-done",
    projectId: "project-1",
    title: "Готово",
    status: "done",
    position: 1,
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
];

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
      columns={COLUMNS}
      currentColumnId="column-project-1-legacy-todo"
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

  it("показывает меню над заголовком во всю ширину без отдельной drag-ручки", () => {
    renderCard(makeTask());

    const menu = screen.getByTestId("kanban-menu-task-1");
    const title = screen.getByTestId("kanban-open-task-1");
    const checkbox = screen.getByRole("checkbox", { name: "Выбрать задачу Компактная карточка" });

    expect(screen.queryByTestId("kanban-drag-task-1")).toBeNull();
    expect(menu.parentElement?.nextElementSibling).toBe(title);
    expect(menu.parentElement?.firstElementChild).toContainElement(checkbox);
    expect(menu.parentElement?.lastElementChild).toBe(menu);
    expect(title).toHaveClass("w-full");
    expect(title).toHaveAttribute("data-card-drag-allow", "true");
  });

  it("даёт доступный чекбокс выбора, который не открывает карточку и не начинает drag", () => {
    const onOpen = vi.fn();
    const onDragStart = vi.fn();
    const onBulkToggle = vi.fn();

    renderCard(makeTask(), {
      bulkSelected: true,
      onOpen,
      onDragStart,
      onBulkToggle,
    });

    const checkbox = screen.getByRole("checkbox", {
      name: "Выбрать задачу Компактная карточка",
    });
    const hitTarget = screen.getByTestId("kanban-bulk-check-target-task-1");

    expect(checkbox).toBeChecked();
    expect(hitTarget).toHaveClass("min-h-10", "min-w-10");

    fireEvent.pointerDown(checkbox, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 80 });

    expect(onDragStart).not.toHaveBeenCalled();

    fireEvent.click(checkbox);

    expect(onBulkToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }), false);
    expect(onOpen).not.toHaveBeenCalled();
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
        columns={COLUMNS}
        currentColumnId="column-project-1-legacy-todo"
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
        columns={COLUMNS}
        currentColumnId="column-project-1-legacy-todo"
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
        columns={COLUMNS}
        currentColumnId="column-project-1-legacy-todo"
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

  it("не показывает бейдж проекта на карточке доски", () => {
    renderCard(makeTask());

    expect(screen.queryByTestId("kanban-project-badge-task-1")).toBeNull();
    expect(screen.getByTestId("kanban-card-task-1")).not.toHaveTextContent("Проект один");
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
        columns={COLUMNS}
        currentColumnId="column-project-1-legacy-todo"
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

  it("сохраняет открытие и действия меню доступными с клавиатуры", () => {
    renderCard(makeTask());

    expect(
      screen.getByRole("button", { name: "Открыть карточку задачи Компактная карточка" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Перетащить задачу Компактная карточка" }),
    ).toBeNull();

    const trigger = screen.getByTestId("kanban-menu-task-1");

    expect(trigger).toHaveAccessibleName("Действия карточки Компактная карточка");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    const menu = screen.getByTestId("kanban-card-menu-task-1");
    const up = within(menu).getByRole("menuitem", { name: "Выше" });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(up).toBeDisabled();
  });

  it("рендерит меню порталом, не меняя состав карточки", () => {
    renderCard(makeTask());

    const card = screen.getByTestId("kanban-card-task-1");
    const childrenBefore = card.childElementCount;

    fireEvent.click(screen.getByTestId("kanban-menu-task-1"));

    const menu = screen.getByTestId("kanban-card-menu-task-1");

    expect(menu.parentElement).toBe(document.body);
    expect(card).not.toContainElement(menu);
    expect(card.childElementCount).toBe(childrenBefore);
    expect(menu).toHaveStyle({ position: "fixed" });
  });

  it("фокусирует первое действие и поддерживает стрелки/Home/End и Tab", async () => {
    renderCard(makeTask(), { index: 1, columnSize: 3 });

    const trigger = screen.getByTestId("kanban-menu-task-1");

    trigger.focus();
    fireEvent.click(trigger);

    const menu = screen.getByTestId("kanban-card-menu-task-1");

    expect(menu).toHaveAttribute("role", "menu");
    await waitFor(() => {
      expect(within(menu).getByRole("menuitem", { name: "Переместить в Готово" })).toHaveFocus();
    });

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Выше" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "End" });
    expect(within(menu).getByRole("menuitem", { name: "В конец" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(within(menu).getByRole("menuitem", { name: "Переместить в Готово" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.queryByTestId("kanban-card-menu-task-1")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("закрывает меню по Escape с возвратом фокуса и по клику снаружи", () => {
    renderCard(makeTask());

    const trigger = screen.getByTestId("kanban-menu-task-1");

    fireEvent.click(trigger);
    expect(screen.getByTestId("kanban-card-menu-task-1")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("kanban-card-menu-task-1")).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(screen.getByTestId("kanban-card-menu-task-1")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId("kanban-card-menu-task-1")).toBeNull();
  });

  it("держит открытым только одно меню на доске", () => {
    const first = makeTask();
    const second = makeTask({ id: "task-2", title: "Вторая карточка" });

    render(
      <>
        <KanbanCard
          task={first}
          index={0}
          columnSize={2}
          columns={COLUMNS}
          currentColumnId="column-project-1-legacy-todo"
          subtaskCount={0}
          selected={false}
          pending={false}
          conflict={false}
          dragging={false}
          onOpen={vi.fn()}
          onMoveTo={vi.fn()}
          onReorder={vi.fn()}
          onDragStart={vi.fn()}
        />
        <KanbanCard
          task={second}
          index={1}
          columnSize={2}
          columns={COLUMNS}
          currentColumnId="column-project-1-legacy-todo"
          subtaskCount={0}
          selected={false}
          pending={false}
          conflict={false}
          dragging={false}
          onOpen={vi.fn()}
          onMoveTo={vi.fn()}
          onReorder={vi.fn()}
          onDragStart={vi.fn()}
        />
      </>,
    );

    fireEvent.click(screen.getByTestId("kanban-menu-task-1"));
    expect(screen.getByTestId("kanban-card-menu-task-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("kanban-menu-task-2"));

    expect(screen.queryByTestId("kanban-card-menu-task-1")).toBeNull();
    expect(screen.getByTestId("kanban-card-menu-task-2")).toBeInTheDocument();
  });

  it("не начинает drag при pointer down на меню", () => {
    const onDragStart = vi.fn();

    renderCard(makeTask(), { onDragStart });

    fireEvent.pointerDown(screen.getByTestId("kanban-menu-task-1"), {
      clientX: 10,
      clientY: 10,
    });

    expect(onDragStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("kanban-menu-task-1"));

    fireEvent.pointerDown(
      within(screen.getByTestId("kanban-card-menu-task-1")).getByRole("menuitem", {
        name: "Переместить в Готово",
      }),
      { clientX: 10, clientY: 10 },
    );

    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("начинает drag из заголовка, тегов и отступов карточки", () => {
    const onDragStart = vi.fn();

    renderCard(makeTask({ tags: ["release"] }), { onDragStart });

    fireEvent.pointerDown(screen.getByTestId("kanban-open-task-1"), {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    expect(onDragStart).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByText("release"), {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    expect(onDragStart).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(screen.getByTestId("kanban-card-task-1"), {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 4,
      clientY: 4,
    });
    expect(onDragStart).toHaveBeenCalledTimes(3);
  });

  it("игнорирует drag только при выделении внутри карточки и вторичной кнопке", () => {
    const onDragStart = vi.fn();

    renderCard(makeTask(), { onDragStart });

    const openButton = screen.getByTestId("kanban-open-task-1");
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      anchorNode: openButton,
      focusNode: openButton,
    } as unknown as Selection);

    fireEvent.pointerDown(screen.getByTestId("kanban-card-task-1"), {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 4,
      clientY: 4,
    });

    expect(onDragStart).not.toHaveBeenCalled();

    // Выделение вне карточки не блокирует её drag.
    const outside = document.createElement("p");

    document.body.append(outside);
    selection.mockReturnValue({
      isCollapsed: false,
      anchorNode: outside,
      focusNode: outside,
    } as unknown as Selection);

    fireEvent.pointerDown(screen.getByTestId("kanban-card-task-1"), {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 4,
      clientY: 4,
    });

    expect(onDragStart).toHaveBeenCalledTimes(1);
    outside.remove();
    selection.mockReturnValue(null);

    fireEvent.pointerDown(screen.getByTestId("kanban-card-task-1"), {
      pointerType: "mouse",
      button: 2,
      isPrimary: true,
      clientX: 4,
      clientY: 4,
    });

    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it("подавляет click после drag и не мешает обычному открытию", () => {
    const onOpen = vi.fn();
    let suppress = true;

    const { rerender } = renderCard(makeTask(), {
      onOpen,
      shouldSuppressClick: () => suppress,
    });

    fireEvent.click(screen.getByTestId("kanban-open-task-1"));
    expect(onOpen).not.toHaveBeenCalled();

    suppress = false;

    rerender(
      <KanbanCard
        task={makeTask()}
        index={0}
        columnSize={1}
        columns={COLUMNS}
        currentColumnId="column-project-1-legacy-todo"
        subtaskCount={1}
        selected={false}
        pending={false}
        conflict={false}
        dragging={false}
        onOpen={onOpen}
        onMoveTo={vi.fn()}
        onReorder={vi.fn()}
        onDragStart={vi.fn()}
        shouldSuppressClick={() => suppress}
      />,
    );

    fireEvent.click(screen.getByTestId("kanban-open-task-1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
