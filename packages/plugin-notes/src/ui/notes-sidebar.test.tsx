import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@kanbaner/plugin-sdk";

import { NOTES_QUERY_IDS } from "../constants.ts";
import type { NoteDetails, NoteListPage, NoteView } from "../model.ts";
import { NotesSidebar } from "./notes-sidebar.tsx";
import { NotesView } from "./notes-view.tsx";
import type { UiOperationInvoker } from "./runtime.ts";

vi.mock("./editor/markdown-note-editor.tsx", () => ({
  MarkdownNoteEditor: () => <div data-testid="editor-stub" />,
}));

const timestamp = "2026-11-18T00:00:00.000Z";

function view(id: string, title: string, position: number): NoteView {
  return {
    note: {
      id,
      title,
      contentMarkdown: "",
      parentId: null,
      position,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    favorite: false,
    lastOpenedAt: null,
    childCount: 0,
  };
}

function details(item: NoteView): NoteDetails {
  return { view: item, ancestors: [], attachments: [] };
}

function success(data: unknown) {
  return { ok: true as const, data: data as JsonValue };
}

function mediaMatch(matches: boolean) {
  return vi.fn(() => ({
    matches,
    media: "",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", mediaMatch(false));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotesSidebar", () => {
  it("показывает общее дерево в app.sidebar, выбирает страницу и очищается с NotesView", async () => {
    const items = [view("note-a", "Первая", 0), view("note-b", "Вторая", 1)];
    const page: NoteListPage = { items, total: items.length, nextOffset: null };
    const invoke = vi.fn<UiOperationInvoker>(async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(page);
      if (operationId === NOTES_QUERY_IDS.get) {
        const id = (input as { readonly id: string }).id;
        const item = items.find((candidate) => candidate.note.id === id);
        if (item === undefined) throw new Error(`Unknown note ${id}`);
        return success(details(item));
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      return success({});
    });
    const replaceSearch = vi.fn();

    const { rerender } = render(
      <>
        <NotesSidebar />
        <NotesView invoke={invoke} search="" replaceSearch={replaceSearch} />
      </>,
    );

    const sidebar = await screen.findByTestId("notes-global-sidebar");
    await waitFor(() => {
      expect(sidebar.querySelector("[data-note-tree-item='note-a']")).not.toBeNull();
      expect(sidebar.querySelector("[data-note-tree-item='note-b']")).not.toBeNull();
    });
    expect(screen.queryByRole("complementary", { name: "Навигация по заметкам" })).toBeNull();

    await screen.findByTestId("editor-stub");
    replaceSearch.mockClear();
    const second = sidebar.querySelector<HTMLElement>("[data-note-select='note-b']");
    expect(second).not.toBeNull();
    if (second === null) throw new Error("Вторая заметка не найдена в sidebar");
    fireEvent.click(second);

    await waitFor(() => expect(replaceSearch).toHaveBeenCalledWith("?note=note-b"));
    expect(invoke).toHaveBeenCalledWith(NOTES_QUERY_IDS.get, { id: "note-b" }, undefined);

    rerender(<NotesSidebar />);
    await waitFor(() => expect(screen.queryByTestId("notes-global-sidebar")).toBeNull());
  });
});
