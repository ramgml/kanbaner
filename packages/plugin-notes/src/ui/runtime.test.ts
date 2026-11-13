import { describe, expect, it } from "vitest";
import type { JsonValue } from "@kanbaner/plugin-sdk";

import {
  invokeNotes,
  noteIdFromSearch,
  searchWithNote,
  snapshotIdempotencyKey,
  type UiOperationInvoker,
} from "./runtime.ts";

describe("idempotency ключи UI", () => {
  it("стабилен для одинакового снимка и меняется при изменении payload", () => {
    const payload = { id: "note-1", expectedVersion: 1, title: "A", contentMarkdown: "B" };
    expect(snapshotIdempotencyKey("update", payload)).toBe(
      snapshotIdempotencyKey("update", { ...payload }),
    );
    expect(snapshotIdempotencyKey("update", payload)).not.toBe(
      snapshotIdempotencyKey("update", { ...payload, title: "C" }),
    );
    expect(snapshotIdempotencyKey("update", payload)).not.toBe(
      snapshotIdempotencyKey("attachment", payload),
    );
  });

  it("передаёт options в invoke", async () => {
    const calls: Array<{ operationId: string; input: JsonValue; options: unknown }> = [];
    const invoke: UiOperationInvoker = async (operationId, input, options) => {
      calls.push({ operationId, input, options });
      return { ok: true, data: { saved: true } };
    };

    await expect(
      invokeNotes(invoke, "note.update", { id: "note-1" }, { idempotencyKey: "key-1" }),
    ).resolves.toEqual({ saved: true });
    expect(calls).toEqual([
      {
        operationId: "note.update",
        input: { id: "note-1" },
        options: { idempotencyKey: "key-1" },
      },
    ]);
  });
});

describe("notes URL state", () => {
  it("читает note и ResourceRef, игнорируя чужой ресурс", () => {
    expect(noteIdFromSearch("?note=note-1")).toBe("note-1");
    expect(noteIdFromSearch("?resource=kanbaner.notes%3Anote%3Anote-2")).toBe("note-2");
    expect(noteIdFromSearch("?resource=kanbaner.tasks%3Atask%3Atask-1")).toBeNull();
    expect(noteIdFromSearch("?resource=kanbaner.notes%3Anote%3A")).toBeNull();
  });

  it("заменяет resource на note и сохраняет остальные параметры", () => {
    expect(searchWithNote("note-2", "?resource=x&tag=a")).toBe("?tag=a&note=note-2");
    expect(searchWithNote(null, "?note=note-2&tag=a")).toBe("?tag=a");
  });
});
