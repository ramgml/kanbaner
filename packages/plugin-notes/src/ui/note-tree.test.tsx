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
