import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type { NoteDetails } from "../model.ts";
import { RelatedNotesPanel } from "./related-notes-panel.tsx";
import type { UiOperationInvoker, UiOperationResult } from "./runtime.ts";

const timestamp = "2026-11-13T00:00:00.000Z";
const taskRef = "kanbaner.tasks:task:task-1" as ResourceRef;

function success(data: unknown): UiOperationResult {
  return { ok: true, data: data as JsonValue };
}

function failure(message: string): UiOperationResult {
  return { ok: false, error: { code: "STORAGE_ERROR", message, retryable: true } };
}

function createdDetails(id: string): NoteDetails {
  return {
    view: {
      note: {
        id,
        title: "Заметка к задаче",
        contentMarkdown: "",
        parentId: null,
        position: 0,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      favorite: false,
      lastOpenedAt: null,
      childCount: 0,
    },
    ancestors: [],
    attachments: [],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RelatedNotesPanel", () => {
  it("показывает созданную заметку при ошибке связи и повторяет только link", async () => {
    const createKeys: Array<string | undefined> = [];
    const unlinked: unknown[] = [];
    let createCalls = 0;
    let linkCalls = 0;
    const openResource = vi.fn();
    const invoke: UiOperationInvoker = async (operationId, input, options) => {
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.create) {
        createCalls += 1;
        createKeys.push(options?.idempotencyKey);
        return success(createdDetails("note-1"));
      }
      if (operationId === NOTES_COMMAND_IDS.link) {
        linkCalls += 1;
        unlinked.push(input);
        return linkCalls === 1 ? failure("Связь недоступна") : success({ unlinked: true });
      }
      return success({ items: [] });
    };

    render(<RelatedNotesPanel resourceRef={taskRef} invoke={invoke} openResource={openResource} />);

    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Заметка создана, но связь не создана");
    expect(createCalls).toBe(1);
    expect(linkCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Открыть заметку" }));
    expect(openResource).toHaveBeenCalledWith("kanbaner.notes:note:note-1");

    fireEvent.click(screen.getByRole("button", { name: "Повторить связь" }));
    await waitFor(() => expect(linkCalls).toBe(2));
    // Повтор не создаёт вторую заметку и открывает уже созданную.
    expect(createCalls).toBe(1);
    expect(createKeys).toHaveLength(1);
    expect(openResource).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("не выдаёт ошибку refresh за ошибку создания и открывает заметку", async () => {
    let refreshCalls = 0;
    const openResource = vi.fn();
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.links) {
        refreshCalls += 1;
        return refreshCalls === 1 ? success({ items: [] }) : failure("Индекс недоступен");
      }
      if (operationId === NOTES_COMMAND_IDS.create) {
        return success(createdDetails("note-1"));
      }
      if (operationId === NOTES_COMMAND_IDS.link) return success({ unlinked: true });
      return success({ items: [] });
    };

    render(<RelatedNotesPanel resourceRef={taskRef} invoke={invoke} openResource={openResource} />);

    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => expect(openResource).toHaveBeenCalledWith("kanbaner.notes:note:note-1"));
    expect(screen.queryByText(/Не удалось создать заметку/)).toBeNull();
    await screen.findByText(/Список связанных заметок не обновлён/);
  });

  it("переиспользует ключ создания при retry после ошибки", async () => {
    const createKeys: Array<string | undefined> = [];
    let createCalls = 0;
    const invoke: UiOperationInvoker = async (operationId, _input, options) => {
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.create) {
        createCalls += 1;
        createKeys.push(options?.idempotencyKey);
        if (createCalls === 1) return failure("Создание не удалось");
        return success(createdDetails("note-1"));
      }
      if (operationId === NOTES_COMMAND_IDS.link) return success({ unlinked: true });
      return success({ items: [] });
    };

    render(<RelatedNotesPanel resourceRef={taskRef} invoke={invoke} openResource={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await screen.findByText("Создание не удалось");
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(createCalls).toBe(2));

    expect(createKeys[0]).toBeTruthy();
    expect(createKeys[1]).toBe(createKeys[0]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
