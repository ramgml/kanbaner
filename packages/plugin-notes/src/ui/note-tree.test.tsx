import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Note, NoteView } from "../model.ts";
import { NoteTree } from "./note-tree.tsx";

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
});
