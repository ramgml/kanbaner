import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type { ResolvedNoteLink } from "../model.ts";
import { NoteLinks } from "./note-links.tsx";
import type { UiOperationInvoker, UiOperationResult } from "./runtime.ts";

function success(data: unknown): UiOperationResult {
  return { ok: true, data: data as JsonValue };
}

function failure(message: string): UiOperationResult {
  return {
    ok: false,
    error: { code: "test.error", message, retryable: false },
  };
}

function resolvedLink(noteId: string, taskId: string, title: string): ResolvedNoteLink {
  return {
    link: {
      sourceRef: `kanbaner.notes:note:${noteId}`,
      targetRef: `kanbaner.tasks:task:${taskId}`,
      relation: "kanbaner.notes.references",
    },
    source: null,
    target: {
      ref: `kanbaner.tasks:task:${taskId}`,
      resourceType: "task",
      title,
    },
  };
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

  it("добавляет связь с проектом по видимому названию", async () => {
    const links: ResolvedNoteLink[] = [];
    const linkInputs: unknown[] = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: links });
      if (operationId === NOTES_COMMAND_IDS.link) {
        linkInputs.push(input);
        return success({ link: { sourceRef: "kanbaner.notes:note:note-1", targetRef: "" } });
      }
      if (operationId === "kanbaner.tasks.project.list") {
        return success({
          items: [
            { id: "project-1", title: "Оформление заказа" },
            { id: "project-2", title: "Личный кабинет" },
          ],
          total: 2,
          nextOffset: null,
        });
      }
      if (operationId === "kanbaner.tasks.task.list") {
        return success({
          items: [{ id: "task-1", title: "Починить корзину" }],
          total: 1,
          nextOffset: null,
        });
      }
      return success({ items: [] });
    };

    render(<NoteLinks noteId="note-1" invoke={invoke} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));
    const search = await screen.findByRole("combobox", { name: "Поиск проекта или задачи" });
    fireEvent.change(search, { target: { value: "оформ" } });

    const project = await screen.findByRole("option", { name: /Оформление заказа/ });
    expect(project).toHaveTextContent("Проект");
    expect(screen.queryByRole("option", { name: /Починить корзину/ })).not.toBeInTheDocument();

    fireEvent.click(project);

    await waitFor(() => expect(linkInputs).toHaveLength(1));
    expect(linkInputs[0]).toMatchObject({
      noteId: "note-1",
      targetRef: "kanbaner.tasks:project:project-1",
    });
    await waitFor(() => expect(screen.queryByTestId("note-link-picker")).not.toBeInTheDocument());
  });

  it("показывает ошибку создания связи и оставляет picker открытым", async () => {
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.link) return failure("Связь уже существует");
      if (operationId === "kanbaner.tasks.project.list") {
        return success({
          items: [{ id: "project-1", title: "Оформление заказа" }],
          total: 1,
          nextOffset: null,
        });
      }
      return success({ items: [] });
    };

    render(<NoteLinks noteId="note-1" invoke={invoke} />);

    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));
    fireEvent.click(await screen.findByRole("option", { name: /Оформление заказа/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Связь уже существует");
    expect(screen.getByTestId("note-link-picker")).toBeVisible();
  });

  it("не применяет запоздавший refresh связей прежней заметки", async () => {
    let resolveFirst: ((value: UiOperationResult) => void) | undefined;
    let linkCalls = 0;
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.links) {
        linkCalls += 1;
        if (linkCalls === 1) {
          return new Promise<UiOperationResult>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return success({ items: [resolvedLink("note-2", "task-2", "Задача второй")] });
      }
      return success({ items: [] });
    };

    const { rerender } = render(<NoteLinks noteId="note-1" invoke={invoke} />);
    rerender(<NoteLinks noteId="note-2" invoke={invoke} />);

    expect(await screen.findByText("Задача второй")).toBeVisible();
    expect(resolveFirst).toBeTypeOf("function");
    await act(async () => {
      resolveFirst?.(success({ items: [resolvedLink("note-1", "task-1", "Задача первой")] }));
      await Promise.resolve();
    });

    expect(screen.queryByText("Задача первой")).not.toBeInTheDocument();
    expect(screen.getByText("Задача второй")).toBeVisible();
  });

  it("не показывает позднюю ошибку связи прежней заметки и не трогает новый picker", async () => {
    let resolveLink: ((value: UiOperationResult) => void) | undefined;
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.link) {
        return new Promise<UiOperationResult>((resolve) => {
          resolveLink = resolve;
        });
      }
      if (operationId === "kanbaner.tasks.project.list") {
        return success({
          items: [{ id: "project-1", title: "Оформление заказа" }],
          total: 1,
          nextOffset: null,
        });
      }
      return success({ items: [] });
    };

    const { rerender } = render(<NoteLinks noteId="note-1" invoke={invoke} />);
    fireEvent.click(screen.getByTestId("note-link-picker-trigger"));
    fireEvent.click(await screen.findByRole("option", { name: /Оформление заказа/ }));
    await waitFor(() => expect(resolveLink).toBeTypeOf("function"));

    rerender(<NoteLinks noteId="note-2" invoke={invoke} />);
    expect(screen.queryByTestId("note-link-picker")).not.toBeInTheDocument();

    await act(async () => {
      resolveLink?.(failure("Связь уже существует"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("note-link-picker")).not.toBeInTheDocument();
    expect(screen.getByTestId("note-link-picker-trigger")).toBeVisible();
  });
});
