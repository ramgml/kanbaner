import { describe, expect, it } from "vitest";

import { noteIdFromSearch, searchWithNote } from "./runtime.ts";

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
