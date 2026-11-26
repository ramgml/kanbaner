import "@testing-library/jest-dom/vitest";

import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearStoredSessionID,
  DRAFT_MAX_ENTRIES,
  DRAFT_MAX_ENTRY_CHARS,
  DRAFT_MAX_TOTAL_CHARS,
  DRAFTS_VERSION,
  OPENCODE_DRAFTS_KEY,
  OPENCODE_SESSION_KEY,
  readDrafts,
  readStoredSessionID,
  removeDraft,
  storeSessionID,
  useSessionDraft,
  writeDraft,
} from "./drafts.ts";

function rawDrafts(): unknown {
  const raw = window.localStorage.getItem(OPENCODE_DRAFTS_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function storedText(sessionID: string): string | null {
  return readDrafts().get(sessionID) ?? null;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("draft storage", () => {
  it("сохраняет и читает exact composer text по session ID", () => {
    writeDraft("ses-1", "первый\nвторой & <tag>", 1000);

    expect(storedText("ses-1")).toBe("первый\nвторой & <tag>");
    expect(rawDrafts()).toEqual({
      v: DRAFTS_VERSION,
      drafts: { "ses-1": { text: "первый\nвторой & <tag>", updatedAt: 1000 } },
    });
    expect(window.localStorage.getItem(OPENCODE_DRAFTS_KEY)).not.toContain("base64");
  });

  it("пустой текст удаляет entry, а последняя запись удаляет ключ", () => {
    writeDraft("ses-1", "one");
    writeDraft("ses-2", "two");

    writeDraft("ses-1", "");
    expect(storedText("ses-1")).toBeNull();
    expect(storedText("ses-2")).toBe("two");

    writeDraft("ses-2", "");
    expect(window.localStorage.getItem(OPENCODE_DRAFTS_KEY)).toBeNull();
  });

  it("игнорирует невалидный JSON, version, shape, NaN/negative timestamp и empty text", () => {
    window.localStorage.setItem(OPENCODE_DRAFTS_KEY, "{not json");
    expect(readDrafts().size).toBe(0);

    window.localStorage.setItem(OPENCODE_DRAFTS_KEY, JSON.stringify({ v: 2, drafts: {} }));
    expect(readDrafts().size).toBe(0);

    window.localStorage.setItem(OPENCODE_DRAFTS_KEY, JSON.stringify({ v: 1, drafts: [] }));
    expect(readDrafts().size).toBe(0);

    window.localStorage.setItem(
      OPENCODE_DRAFTS_KEY,
      JSON.stringify({
        v: 1,
        drafts: {
          good: { text: "ok", updatedAt: 5 },
          nan: { text: "bad", updatedAt: "NaN" },
          negative: { text: "bad", updatedAt: -1 },
          wrongText: { text: 42, updatedAt: 5 },
          wrongShape: "text",
          empty: { text: "", updatedAt: 5 },
          nullEntry: null,
        },
      }),
    );

    expect([...readDrafts().entries()]).toEqual([["good", "ok"]]);
  });

  it("игнорирует oversized stored entry, не теряя валидную соседнюю запись", () => {
    window.localStorage.setItem(
      OPENCODE_DRAFTS_KEY,
      JSON.stringify({
        v: 1,
        drafts: {
          huge: { text: "x".repeat(DRAFT_MAX_ENTRY_CHARS + 1), updatedAt: 1 },
          valid: { text: "ok", updatedAt: 2 },
        },
      }),
    );

    expect(storedText("huge")).toBeNull();
    expect(storedText("valid")).toBe("ok");
  });

  it("держит не больше 20 записей, удаляя самые старые по updatedAt (LRU)", () => {
    for (let index = 0; index <= DRAFT_MAX_ENTRIES; index += 1) {
      writeDraft(`ses-${index}`, `text-${index}`, 1000 + index);
    }

    expect(readDrafts().size).toBe(DRAFT_MAX_ENTRIES);
    expect(storedText("ses-0")).toBeNull();
    expect(storedText("ses-1")).toBe("text-1");
    expect(storedText(`ses-${DRAFT_MAX_ENTRIES}`)).toBe(`text-${DRAFT_MAX_ENTRIES}`);
  });

  it("держит суммарный лимит 65 536 символов, защищая текущую запись", () => {
    const chunk = "x".repeat(DRAFT_MAX_ENTRY_CHARS);
    for (let index = 0; index < 5; index += 1) {
      writeDraft(`big-${index}`, chunk, 1000 + index);
    }

    const drafts = readDrafts();
    let total = 0;
    for (const text of drafts.values()) total += text.length;

    expect(total).toBeLessThanOrEqual(DRAFT_MAX_TOTAL_CHARS);
    expect(drafts.size).toBe(DRAFT_MAX_TOTAL_CHARS / DRAFT_MAX_ENTRY_CHARS);
    expect(storedText("big-0")).toBeNull();
    expect(storedText("big-4")).toBe(chunk);
  });

  it("сверхлимитный текущий текст не сохраняется и удаляет stale старую запись", () => {
    writeDraft("ses-1", "старый ввод", 1000);
    writeDraft("ses-1", "x".repeat(DRAFT_MAX_ENTRY_CHARS + 1), 2000);

    expect(window.localStorage.getItem(OPENCODE_DRAFTS_KEY)).toBeNull();
    expect(storedText("ses-1")).toBeNull();
  });

  it("не падает и не пишет при throw в getItem/setItem/removeItem", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked get");
    });
    expect(readDrafts().size).toBe(0);
    expect(readStoredSessionID()).toBeNull();
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeDraft("ses-1", "text")).not.toThrow();
    expect(() => storeSessionID("ses-1")).not.toThrow();
    setItem.mockRestore();

    writeDraft("ses-1", "text");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked remove");
    });
    expect(() => writeDraft("ses-1", "")).not.toThrow();
    expect(() => removeDraft("ses-1")).not.toThrow();
    expect(() => clearStoredSessionID()).not.toThrow();
    removeItem.mockRestore();
  });

  it("переживает полностью заблокированный localStorage getter", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    try {
      expect(readStoredSessionID()).toBeNull();
      expect(readDrafts().size).toBe(0);
      expect(() => writeDraft("ses-1", "text")).not.toThrow();
      expect(() => writeDraft("ses-1", "")).not.toThrow();
      expect(() => storeSessionID("ses-1")).not.toThrow();
      expect(() => clearStoredSessionID()).not.toThrow();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
    }
  });

  it("поддерживает weird session IDs без prototype pollution", () => {
    const ids = ["__proto__", "constructor", "session with spaces", "сессия-😀", "a/b:c"];

    for (const id of ids) writeDraft(id, `text-${id}`, 1000);

    for (const id of ids) expect(storedText(id)).toBe(`text-${id}`);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect((Object.prototype as { text?: unknown }).text).toBeUndefined();

    writeDraft("__proto__", "", 2000);
    expect(storedText("__proto__")).toBeNull();
    expect(storedText("constructor")).toBe("text-constructor");
  });
});

describe("session ID storage", () => {
  it("безопасно читает, пишет и удаляет last session ID", () => {
    expect(readStoredSessionID()).toBeNull();
    storeSessionID("ses-1");
    expect(window.localStorage.getItem(OPENCODE_SESSION_KEY)).toBe("ses-1");
    expect(readStoredSessionID()).toBe("ses-1");
    clearStoredSessionID();
    expect(readStoredSessionID()).toBeNull();
  });
});

describe("useSessionDraft", () => {
  function renderDraft(initial: string | null) {
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    return renderHook(
      ({ sessionID }: { readonly sessionID: string | null }) => useSessionDraft(sessionID),
      {
        initialProps: { sessionID: initial },
        wrapper,
      },
    );
  }

  it("восстанавливает свой черновик, сохраняет и изолирует session ID", () => {
    writeDraft("ses-1", "черновик один", 1000);
    writeDraft("ses-2", "черновик два", 2000);
    const { result, rerender } = renderDraft("ses-1");

    expect(result.current.text).toBe("черновик один");

    act(() => result.current.setText("новый один"));
    expect(storedText("ses-1")).toBe("новый один");
    expect(storedText("ses-2")).toBe("черновик два");

    rerender({ sessionID: "ses-2" });
    expect(result.current.text).toBe("черновик два");
    expect(storedText("ses-1")).toBe("новый один");

    act(() => result.current.setText("новый два"));
    rerender({ sessionID: "ses-1" });
    expect(result.current.text).toBe("новый один");
    expect(storedText("ses-2")).toBe("новый два");

    rerender({ sessionID: "ses-new" });
    expect(result.current.text).toBe("");
  });

  it("clearDraft очищает только явную сессию и не трогает активный текст другой", () => {
    writeDraft("ses-1", "one", 1000);
    writeDraft("ses-2", "two", 2000);
    const { result } = renderDraft("ses-1");

    act(() => result.current.clearDraft("ses-2"));

    expect(result.current.text).toBe("one");
    expect(storedText("ses-1")).toBe("one");
    expect(storedText("ses-2")).toBeNull();

    act(() => result.current.clearDraft("ses-1"));
    expect(result.current.text).toBe("");
    expect(window.localStorage.getItem(OPENCODE_DRAFTS_KEY)).toBeNull();
  });

  it("StrictMode не затирает сохранённый черновик пустой строкой", () => {
    writeDraft("ses-1", "сохранено", 1000);
    const { result } = renderDraft("ses-1");

    expect(result.current.text).toBe("сохранено");
    expect(storedText("ses-1")).toBe("сохранено");
  });

  it("сверхлимитный ввод остаётся в памяти, но не переживает remount", () => {
    const oversized = "x".repeat(DRAFT_MAX_ENTRY_CHARS + 1);
    const { result, unmount } = renderDraft("ses-1");

    act(() => result.current.setText(oversized));
    expect(result.current.text).toBe(oversized);
    expect(window.localStorage.getItem(OPENCODE_DRAFTS_KEY)).toBeNull();

    unmount();
    const reloaded = renderDraft("ses-1");
    expect(reloaded.result.current.text).toBe("");
  });

  it("с blocked localStorage composer остаётся рабочим в памяти", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    try {
      const { result } = renderDraft("ses-1");
      expect(result.current.text).toBe("");
      act(() => result.current.setText("в памяти"));
      expect(result.current.text).toBe("в памяти");
      act(() => result.current.clearDraft("ses-1"));
      expect(result.current.text).toBe("");
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
    }
  });
});
