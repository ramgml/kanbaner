import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type { ResolvedNoteLink } from "../model.ts";
import { NoteLinks } from "./note-links.tsx";
import type { UiOperationInvoker, UiOperationResult } from "./runtime.ts";

function success(data: unknown): UiOperationResult {
  return { ok: true, data: data as JsonValue };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NoteLinks", () => {
  it("удаляет фактическую связь с её sourceRef/targetRef без разворота", async () => {
    const noteRef = "kanbaner.notes:note:note-1" as ResourceRef;
    const taskRef = "kanbaner.tasks:task:task-1" as ResourceRef;
    const otherNoteRef = "kanbaner.notes:note:note-2" as ResourceRef;
    const links: ResolvedNoteLink[] = [
      {
        link: { sourceRef: noteRef, targetRef: taskRef, relation: "kanbaner.notes.references" },
        source: null,
        target: null,
      },
      {
        link: {
          sourceRef: otherNoteRef,
          targetRef: noteRef,
          relation: "kanbaner.notes.references",
        },
        source: null,
        target: null,
      },
    ];
    const unlinks: unknown[] = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: links });
      if (operationId === NOTES_COMMAND_IDS.unlink) {
        unlinks.push(input);
        return success({ unlinked: true });
      }
      return success({ items: [] });
    };

    render(<NoteLinks noteId="note-1" invoke={invoke} />);

    const buttons = await screen.findAllByRole("button", { name: /Удалить связь/ });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(unlinks).toHaveLength(1));
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(unlinks).toHaveLength(2));

    expect(unlinks[0]).toMatchObject({
      noteId: "note-1",
      sourceRef: noteRef,
      targetRef: taskRef,
    });
    // Вторая связь ведёт в заметку: направление не меняется.
    expect(unlinks[1]).toMatchObject({
      noteId: "note-1",
      sourceRef: otherNoteRef,
      targetRef: noteRef,
    });
  });
});
