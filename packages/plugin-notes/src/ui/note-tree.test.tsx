import "@testing-library/jest-dom/vitest";

import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Note, NoteView } from "../model.ts";
import { NoteTree, noteDropZone, noteMoveRequest } from "./note-tree.tsx";

const DRAG_TYPE = "application/x-kanbaner-note";

function dragData() {
  const store = new Map<string, string>();
  return {
    types: [DRAG_TYPE],
    effectAllowed: "none",
    dropEffect: "none",
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  };
}

/**
 * jsdom не передаёт clientY через init drag-события, поэтому координата
 * задаётся на уже созданном событии: так проверяется реальная зона строки.
 */
function fireDragOver(
  element: Element,
  dataTransfer: ReturnType<typeof dragData>,
  clientY: number,
) {
  const event = createEvent.dragOver(element, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}

function fireDrop(element: Element, dataTransfer: ReturnType<typeof dragData>, clientY: number) {
  const event = createEvent.drop(element, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}

/** jsdom не считает layout, поэтому высота строки задаётся явно. */
function stubRowRect(height = 40): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 200,
    bottom: height,
    width: 200,
    height,
    toJSON: () => ({}),
  });
}

function note(id: string, title: string, parentId: string | null, position: number): NoteView {
  const value: Note = {
    id,
    title,
    parentId,
    position,
    contentMarkdown: "",
    version: 1,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
  };
  return { note: value, favorite: false, lastOpenedAt: null, childCount: 0 };
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Не найден элемент ${selector}`);
  return element;
}

describe("NoteTree", () => {
  afterEach(cleanup);

  it("создаёт дочернюю страницу и перемещает кнопками без DnD", () => {
    const onCreate = vi.fn();
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const items = [note("a", "Первая", null, 0), note("b", "Вторая", null, 1)];

    render(
      <NoteTree
        items={items}
        selectedId="a"
        onSelect={onSelect}
        onCreate={onCreate}
        onMove={onMove}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Создать вложенную страницу в Первая" }));
    expect(onCreate).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Переместить Первая ниже" }));
    expect(onMove).toHaveBeenCalledWith("a", null, 1);
    fireEvent.click(screen.getByRole("button", { name: "Вторая" }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("в flat-режиме сохраняет переданный порядок без иерархии и reorder", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <NoteTree
        items={[note("b", "Вторая", null, 7), note("a", "Первая", null, 1)]}
        flat
        selectedId={null}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(
      [...container.querySelectorAll("[data-note-tree-item]")].map((item) =>
        item.getAttribute("data-note-tree-item"),
      ),
    ).toEqual(["b", "a"]);
    expect(screen.queryByRole("button", { name: /Переместить/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Развернуть|Свернуть/ })).toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    expect(container.querySelector("[data-note-expand-spacer]")).toBeNull();
    expect(container.querySelector("[data-note-root-drop]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Вторая" }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("выносит действия в overlay и не отдаёт им ширину названия", () => {
    const onDelete = vi.fn();
    const items = [note("a", "Без названия", null, 0), note("b", "Вторая", null, 1)];
    const { container } = render(
      <NoteTree
        items={items}
        selectedId="a"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const row = required<HTMLElement>(container, "[data-note-tree-item='a']");
    const select = required<HTMLElement>(container, "[data-note-select='a']");
    const label = required<HTMLElement>(container, "[data-note-title='a']");
    const actions = required<HTMLElement>(container, "[data-note-actions='a']");

    // Строка — точка отсчёта для absolute overlay.
    expect(row).toHaveClass("relative");
    expect(select).toHaveClass("flex-1", "min-w-0");
    expect(label).toHaveClass("truncate");
    // Действия лежат поверх строки и не участвуют в расчёте её ширины.
    expect(actions).toHaveClass("absolute", "inset-y-0", "right-0", "z-10");
    expect(actions).not.toHaveClass("shrink-0", "pointer-events-auto");
    // Панель не перехватывает клики по названию: интерактивны только кнопки.
    expect(actions).toHaveClass("pointer-events-none");
    // Непрозрачная часть overlay закрывает кнопки, слева остаётся мягкий fade.
    expect(actions).toHaveClass("bg-gradient-to-l", "from-70%", "to-transparent");
    // На touch действия видны всегда, на desktop — только по hover и focus.
    expect(actions).toHaveClass("opacity-100", "lg:opacity-0", "lg:group-hover:opacity-100");
    expect(actions).toHaveClass("lg:focus-within:opacity-100");
    const addChild = screen.getByRole("button", {
      name: "Создать вложенную страницу в Без названия",
    });
    expect(addChild).toHaveClass(
      "pointer-events-auto",
      "lg:size-6",
      "lg:pointer-events-none",
      "lg:group-hover:pointer-events-auto",
      "lg:focus-within:pointer-events-auto",
    );
    // Фон overlay семантический: accent для выбранной строки, background для обычной.
    expect(actions).toHaveClass("from-accent");
    expect(actions).not.toHaveClass("from-background");
    const otherActions = required<HTMLElement>(container, "[data-note-actions='b']");
    expect(otherActions).toHaveClass("from-background");

    fireEvent.click(screen.getByRole("button", { name: "Удалить Без названия" }));
    expect(onDelete).toHaveBeenCalledWith(items[0]);
  });

  it("показывает вложенность после раскрытия", () => {
    render(
      <NoteTree
        items={[note("a", "Родитель", null, 0), note("b", "Ребёнок", "a", 0)]}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Ребёнок" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Развернуть Родитель" }));
    expect(screen.getByRole("button", { name: "Ребёнок" })).toBeInTheDocument();
  });

  it("держит корневые строки компактными, не ломая выравнивание и DnD", () => {
    const { container } = render(
      <NoteTree
        items={[
          note("p", "Родитель", null, 0),
          note("c", "Ребёнок", "p", 0),
          note("l", "Лист", null, 1),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const parent = required<HTMLElement>(container, "[data-note-tree-item='p']");
    const leaf = required<HTMLElement>(container, "[data-note-tree-item='l']");

    // Слева от названия больше нет grip: строка начинается почти от края.
    expect(parent.style.paddingLeft).toBe("2px");
    expect(leaf.style.paddingLeft).toBe("2px");
    expect(parent.querySelector(".lucide-grip-vertical")).toBeNull();
    expect(leaf.querySelector(".lucide-grip-vertical")).toBeNull();

    // Перетаскивание осталось на всей строке и подсказано курсором.
    expect(parent).toHaveAttribute("draggable", "true");
    expect(parent).toHaveClass("cursor-grab", "active:cursor-grabbing");

    // У ветки — компактная кнопка раскрытия, у листа — только выравнивающий резерв.
    const toggle = screen.getByRole("button", { name: "Развернуть Родитель" });
    expect(toggle).toHaveClass("size-5", "before:w-6");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    expect(toggle).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Развернуть Лист" })).toBeNull();
    const spacer = required<HTMLElement>(container, "[data-note-expand-spacer='l']");
    expect(spacer).toHaveClass("size-5");
    expect(spacer).toHaveAttribute("aria-hidden", "true");

    // Вложенный уровень по-прежнему сдвинут вправо.
    fireEvent.click(toggle);
    const child = required<HTMLElement>(container, "[data-note-tree-item='c']");
    expect(child.style.paddingLeft).toBe("14px");
  });

  it("вычисляет зону drop и аргументы note.move", () => {
    expect(noteDropZone(0, 0, 40)).toBe("before");
    expect(noteDropZone(9, 0, 40)).toBe("before");
    expect(noteDropZone(10, 0, 40)).toBe("inside");
    expect(noteDropZone(30, 0, 40)).toBe("inside");
    expect(noteDropZone(31, 0, 40)).toBe("after");
    // Без layout высота нулевая: безопасная зона — внутрь.
    expect(noteDropZone(0, 0, 0)).toBe("inside");

    const items = [
      note("a", "Корень A", null, 0),
      note("b", "Ребёнок", "a", 0),
      note("c", "Корень C", null, 1),
      note("d", "Корень D", null, 2),
    ];
    // На узел — child с добавлением в конец ветки.
    expect(noteMoveRequest(items, "c", "a", "inside")).toEqual({ parentId: "a" });
    // Вокруг ребёнка — sibling внутри его родителя.
    expect(noteMoveRequest(items, "c", "b", "before")).toEqual({
      parentId: "a",
      position: 0,
    });
    expect(noteMoveRequest(items, "c", "b", "after")).toEqual({
      parentId: "a",
      position: 1,
    });
    // Вокруг корня — sibling на корневом уровне.
    expect(noteMoveRequest(items, "c", "d", "before")).toEqual({
      parentId: null,
      position: 1,
    });
    expect(noteMoveRequest(items, "c", "d", "after")).toEqual({
      parentId: null,
      position: 2,
    });
    // Позиция считается без самой перемещаемой страницы.
    expect(noteMoveRequest(items, "a", "d", "after")).toEqual({
      parentId: null,
      position: 2,
    });
    expect(noteMoveRequest(items, "c", "c", "inside")).toBeNull();
    expect(noteMoveRequest(items, "missing", "a", "inside")).toBeNull();
  });

  it("маршрутизирует drop внутрь, перед/после и в корень с текстовым индикатором", () => {
    stubRowRect(40);
    const onMove = vi.fn();
    const items = [
      note("a", "Родитель", null, 0),
      note("b", "Ребёнок", "a", 0),
      note("c", "Корень", null, 1),
    ];
    const { container } = render(
      <NoteTree
        items={items}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onMove={onMove}
        onDelete={vi.fn()}
      />,
    );
    const row = (id: string): HTMLElement =>
      required<HTMLElement>(container, `[data-note-tree-item='${id}']`);
    const dataTransfer = dragData();

    // Drop на узел делает страницу ребёнком и раскрывает цель.
    expect(screen.queryByRole("button", { name: "Ребёнок" })).toBeNull();
    fireEvent.dragStart(row("c"), { dataTransfer });
    fireDragOver(row("a"), dataTransfer, 20);
    expect(
      required<HTMLElement>(container, "[data-note-drop-indicator='inside']"),
    ).toHaveTextContent("Внутрь");
    expect(container.querySelector("[data-note-drop-status]")).toHaveTextContent(
      "Перемещение внутрь",
    );
    fireDrop(row("a"), dataTransfer, 20);
    expect(onMove).toHaveBeenLastCalledWith("c", "a");
    expect(screen.getByRole("button", { name: "Ребёнок" })).toBeInTheDocument();
    expect(row("c")).not.toHaveAttribute("data-note-dragging");

    // Верхняя четверть строки — sibling перед целью.
    fireEvent.dragStart(row("c"), { dataTransfer });
    fireDragOver(row("b"), dataTransfer, 2);
    expect(
      required<HTMLElement>(container, "[data-note-drop-indicator='before']"),
    ).toHaveTextContent("Перед");
    fireDrop(row("b"), dataTransfer, 2);
    expect(onMove).toHaveBeenLastCalledWith("c", "a", 0);

    // Нижняя четверть — sibling после цели.
    fireEvent.dragStart(row("c"), { dataTransfer });
    fireDragOver(row("b"), dataTransfer, 38);
    expect(
      required<HTMLElement>(container, "[data-note-drop-indicator='after']"),
    ).toHaveTextContent("После");
    fireDrop(row("b"), dataTransfer, 38);
    expect(onMove).toHaveBeenLastCalledWith("c", "a", 1);

    // Отдельная корневая зона убирает parentId.
    fireEvent.dragStart(row("b"), { dataTransfer });
    const rootZone = required<HTMLElement>(container, "[data-note-root-drop]");
    fireDragOver(rootZone, dataTransfer, 20);
    expect(rootZone).toHaveAttribute("data-note-drop-indicator", "root");
    expect(rootZone).toHaveTextContent("Отпустите, чтобы сделать корневой");
    fireDrop(rootZone, dataTransfer, 20);
    expect(onMove).toHaveBeenLastCalledWith("b", null);

    fireEvent.dragEnd(row("b"), { dataTransfer });
    expect(row("b")).not.toHaveAttribute("data-note-dragging");
  });

  it("не показывает drop-подсказку при наведении на себя и сбрасывает её по dragend", () => {
    stubRowRect(40);
    const items = [note("a", "Первая", null, 0), note("b", "Вторая", null, 1)];
    const { container } = render(
      <NoteTree
        items={items}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const dataTransfer = dragData();
    const first = required<HTMLElement>(container, "[data-note-tree-item='a']");
    const second = required<HTMLElement>(container, "[data-note-tree-item='b']");

    fireEvent.dragStart(first, { dataTransfer });
    expect(first).toHaveAttribute("data-note-dragging", "true");
    fireDragOver(first, dataTransfer, 20);
    expect(container.querySelector("[data-note-drop-indicator]")).toBeNull();

    fireDragOver(second, dataTransfer, 20);
    expect(container.querySelector("[data-note-drop-indicator='inside']")).not.toBeNull();
    fireEvent.dragEnd(first, { dataTransfer });
    expect(first).not.toHaveAttribute("data-note-dragging");
    // Корневая зона остаётся видимой, но её индикатор сброшен.
    expect(required<HTMLElement>(container, "[data-note-root-drop]")).not.toHaveAttribute(
      "data-note-drop-indicator",
    );
  });
});
