import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type { NoteDetails, NoteListPage, NoteView } from "../model.ts";
import { NotesView } from "./notes-view.tsx";
import type { UiOperationInvoker } from "./runtime.ts";

vi.mock("./editor/markdown-note-editor.tsx", () => ({
  MarkdownNoteEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Содержимое заметки"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

function success(data: unknown) {
  return { ok: true as const, data: data as JsonValue };
}

function makeDetails(id: string, title = "Без названия"): NoteDetails {
  const view: NoteView = {
    note: {
      id,
      title,
      contentMarkdown: "",
      parentId: null,
      position: 0,
      version: 1,
      createdAt: "2026-11-13T00:00:00.000Z",
      updatedAt: "2026-11-13T00:00:00.000Z",
    },
    favorite: false,
    lastOpenedAt: null,
    childCount: 0,
  };
  return { view, ancestors: [], attachments: [] };
}

function listOf(details: NoteDetails): NoteListPage {
  return { items: [details.view], total: 1, nextOffset: null };
}

describe("NotesView autosave", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("создаёт заметку и сохраняет title/content с expectedVersion", async () => {
    let details = makeDetails("note-1");
    let created = false;
    const updates: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(created ? listOf(details) : { items: [], total: 0, nextOffset: null });
      }
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.create) {
        created = true;
        return success(details);
      }
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        return success({ view: details.view });
      }
      if (operationId === NOTES_COMMAND_IDS.update) {
        const values = input as Record<string, unknown>;
        updates.push(values);
        details = {
          ...details,
          view: {
            ...details.view,
            note: {
              ...details.view.note,
              title: String(values.title),
              contentMarkdown: String(values.contentMarkdown),
              version: details.view.note.version + 1,
            },
          },
        };
        return success(details);
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="" />);
    fireEvent.click(await screen.findByTestId("note-create-empty"));
    const title = await screen.findByTestId("note-title");
    fireEvent.change(title, { target: { value: "Новая заметка" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Содержимое заметки" }), {
      target: { value: "Текст черновика" },
    });

    await waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(updates[0]).toMatchObject({
      id: "note-1",
      expectedVersion: 1,
      title: "Новая заметка",
      contentMarkdown: "Текст черновика",
    });
    await screen.findByText("Сохранено");
  });

  it("запускает сохранение при unmount до истечения debounce", async () => {
    const details = makeDetails("note-1", "Исходная");
    const updates: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.update) {
        updates.push({});
        return success(details);
      }
      return success({ items: [] });
    };

    const view = render(<NotesView invoke={invoke} search="?note=note-1" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Исходная"));
    fireEvent.change(title, { target: { value: "Уход со страницы" } });
    view.unmount();

    await waitFor(() => expect(updates).toHaveLength(1));
  });

  it("при VERSION_CONFLICT сохраняет локальный черновик", async () => {
    const details = makeDetails("note-1", "Серверная");
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        return success({ view: details.view });
      }
      if (operationId === NOTES_COMMAND_IDS.update) {
        return {
          ok: false,
          error: { code: "VERSION_CONFLICT", message: "Конфликт версий", retryable: false },
        };
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Серверная"));
    fireEvent.change(title, { target: { value: "Локальный черновик" } });

    await screen.findByText("Конфликт версий", { exact: false });
    expect(title).toHaveValue("Локальный черновик");
    expect(await screen.findByTestId("note-conflict-reload")).toBeVisible();
  });
});
