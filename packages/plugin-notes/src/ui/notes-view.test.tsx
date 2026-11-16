import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@kanbaner/plugin-sdk";

import { NOTES_COMMAND_IDS, NOTES_QUERY_IDS } from "../constants.ts";
import type {
  Note,
  NoteAttachmentDescriptor,
  NoteDetails,
  NoteListPage,
  NoteView,
} from "../model.ts";
import { NotesView } from "./notes-view.tsx";
import type { UiOperationInvoker, UiOperationResult } from "./runtime.ts";

const editorState = vi.hoisted(() => ({
  bytes: [137, 80, 78, 71] as number[],
}));

vi.mock("./editor/markdown-note-editor.tsx", () => ({
  MarkdownNoteEditor: ({
    value,
    onChange,
    onUploadImage,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    onUploadImage?: (file: File) => Promise<string>;
    ariaLabel?: string;
  }) => (
    <div>
      <textarea
        aria-label={ariaLabel ?? "Содержимое заметки"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        data-testid="editor-upload"
        onClick={() => {
          const file = new File([new Uint8Array(editorState.bytes)], "image.png", {
            type: "image/png",
          });
          void onUploadImage?.(file).catch(() => undefined);
        }}
      >
        upload
      </button>
    </div>
  ),
}));

const timestamp = "2026-11-13T00:00:00.000Z";

function success(data: unknown): UiOperationResult {
  return { ok: true, data: data as JsonValue };
}

function failure(code: string, message: string): UiOperationResult {
  return { ok: false, error: { code, message, retryable: code !== "VERSION_CONFLICT" } };
}

function noteView(id: string, title = "Без названия", overrides: Partial<Note> = {}): NoteView {
  return {
    note: {
      id,
      title,
      contentMarkdown: "",
      parentId: null,
      position: 0,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...overrides,
    },
    favorite: false,
    lastOpenedAt: null,
    childCount: 0,
  };
}

function makeDetails(
  id: string,
  title = "Без названия",
  overrides: Partial<Note> = {},
): NoteDetails {
  return { view: noteView(id, title, overrides), ancestors: [], attachments: [] };
}

function listOf(...views: NoteView[]): NoteListPage {
  return { items: views, total: views.length, nextOffset: null };
}

function attachment(id: string, noteId: string): NoteAttachmentDescriptor {
  return { id, noteId, mimeType: "image/png", sizeBytes: 4, createdAt: timestamp };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stubObjectUrl() {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:draft"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
}

const DRAG_TYPE = "application/x-kanbaner-note";

function dragData() {
  const store = new Map<string, string>();
  return {
    types: [DRAG_TYPE],
    effectAllowed: "none",
    dropEffect: "none",
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  };
}

/** jsdom не считает layout, поэтому высота строки задаётся явно. */
function stubRowRect(height = 40): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 200,
    bottom: height,
    width: 200,
    height,
    toJSON: () => ({}),
  });
}

function fireDragOver(
  element: Element,
  dataTransfer: ReturnType<typeof dragData>,
  clientY: number,
) {
  const event = createEvent.dragOver(element, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}

function fireDrop(element: Element, dataTransfer: ReturnType<typeof dragData>, clientY: number) {
  const event = createEvent.drop(element, { dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Не найден элемент ${selector}`);
  return element;
}

beforeEach(() => {
  editorState.bytes = [137, 80, 78, 71];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NotesView autosave", () => {
  it("создаёт заметку и сохраняет title/content с expectedVersion", async () => {
    let details = makeDetails("note-1");
    let created = false;
    const updates: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(created ? listOf(details.view) : listOf());
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
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
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
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        return success({ view: details.view });
      }
      if (operationId === NOTES_COMMAND_IDS.update) {
        return failure("VERSION_CONFLICT", "Конфликт версий");
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

  it("не удаляет вложение, если после сохранения черновик изменился (undo)", async () => {
    const file = attachment("att-1", "note-1");
    const details: NoteDetails = {
      view: noteView("note-1", "С картинкой", {
        contentMarkdown: "![img](attachment://att-1)",
      }),
      ancestors: [],
      attachments: [file],
    };
    const update = deferred<UiOperationResult>();
    const deleted: string[] = [];
    let updateIssued = false;
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_QUERY_IDS.attachmentGet) {
        return success({ attachment: { ...file, contentBase64: "iVBORw0KGgo=" } });
      }
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.update) {
        updateIssued = true;
        return update.promise;
      }
      if (operationId === NOTES_COMMAND_IDS.attachmentDelete) {
        deleted.push(String((input as { id: string }).id));
        return success({ deleted: true });
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    const editor = await screen.findByRole("textbox", { name: "Содержимое заметки" });
    await waitFor(() => expect(editor).toHaveValue("![img](data:image/png;base64,iVBORw0KGgo=)"));

    // Удаляем картинку из черновика и запускаем сохранение.
    fireEvent.change(editor, { target: { value: "" } });
    await waitFor(() => expect(updateIssued).toBe(true), { timeout: 3000 });

    // Undo возвращает картинку, пока update ещё в полёте.
    fireEvent.change(editor, {
      target: { value: "![img](data:image/png;base64,iVBORw0KGgo=)" },
    });
    await act(async () => {
      update.resolve(success(details));
    });

    await screen.findByText("Есть изменения");
    expect(deleted).toEqual([]);
    expect(screen.queryByTestId("note-cleanup-warning")).toBeNull();
  });

  it("не удаляет вложение, загруженное во время сохранения", async () => {
    const existing = attachment("att-1", "note-1");
    const uploaded = attachment("att-2", "note-1");
    const details: NoteDetails = {
      view: noteView("note-1", "С картинкой", {
        contentMarkdown: "![img](attachment://att-1)",
      }),
      ancestors: [],
      attachments: [existing],
    };
    const update = deferred<UiOperationResult>();
    const deleted: string[] = [];
    let updateIssued = false;
    const uploadKeys: Array<string | undefined> = [];
    const invoke: UiOperationInvoker = async (operationId, _input, options) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_QUERY_IDS.attachmentGet) {
        return success({ attachment: { ...existing, contentBase64: "iVBORw0KGgo=" } });
      }
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.update) {
        updateIssued = true;
        return update.promise;
      }
      if (operationId === NOTES_COMMAND_IDS.attachmentCreate) {
        uploadKeys.push(options?.idempotencyKey);
        return success({ attachment: uploaded });
      }
      if (operationId === NOTES_COMMAND_IDS.attachmentDelete) {
        deleted.push(String((_input as { id: string }).id));
        return success({ deleted: true });
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    const editor = await screen.findByRole("textbox", { name: "Содержимое заметки" });
    await waitFor(() => expect(editor).toHaveValue("![img](data:image/png;base64,iVBORw0KGgo=)"));

    fireEvent.change(editor, { target: { value: "" } });
    await waitFor(() => expect(updateIssued).toBe(true), { timeout: 3000 });

    fireEvent.click(screen.getByTestId("editor-upload"));
    await waitFor(() => expect(uploadKeys).toHaveLength(1));
    expect(uploadKeys[0]).toBeTruthy();

    await act(async () => {
      update.resolve(success(details));
    });

    expect(deleted).toEqual([]);
  });

  it("не применяет deferred update к другой открытой заметке", async () => {
    window.confirm = vi.fn(() => true);
    const parent = makeDetails("note-1", "Родитель");
    const child = makeDetails("note-2", "Ребёнок", { parentId: "note-1" });
    const other = makeDetails("note-3", "Новая", { version: 5 });
    const notes: NoteDetails[] = [parent, child];
    const updates: Array<Record<string, unknown>> = [];
    const versions: Record<string, number> = { "note-1": 1, "note-2": 1, "note-3": 5 };
    const update = deferred<UiOperationResult>();
    const remove = deferred<UiOperationResult>();
    let updateIssued = false;
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(listOf(...notes.map((details) => details.view)));
      }
      if (operationId === NOTES_QUERY_IDS.get) {
        const id = (input as { id: string }).id;
        const found = [...notes, other].find((details) => details.view.note.id === id);
        return success(found ?? other);
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        const id = (input as { id: string }).id;
        const found = [...notes, other].find((details) => details.view.note.id === id);
        return success({ view: (found ?? other).view });
      }
      if (operationId === NOTES_COMMAND_IDS.delete) return remove.promise;
      if (operationId === NOTES_COMMAND_IDS.update) {
        const values = input as Record<string, unknown>;
        if (!updateIssued) {
          updateIssued = true;
          return update.promise;
        }
        updates.push(values);
        const id = String(values.id);
        const version = (versions[id] ?? 1) + 1;
        versions[id] = version;
        return success(
          makeDetails(id, String(values.title), {
            contentMarkdown: String(values.contentMarkdown),
            version,
          }),
        );
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-2" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Ребёнок"));

    fireEvent.change(title, { target: { value: "Черновик" } });
    fireEvent.click(screen.getByRole("button", { name: "Удалить Родитель" }));
    await waitFor(() => expect(updateIssued).toBe(true), { timeout: 3000 });

    notes.splice(0, notes.length, other);
    await act(async () => {
      remove.resolve(
        success({
          deleted: true,
          deletedNotes: [parent.view.note, child.view.note],
          deletedAttachmentIds: [],
          deletedResourceRefs: [],
        }),
      );
    });

    await waitFor(() => expect(title).toHaveValue("Новая"));

    await act(async () => {
      update.resolve(
        success({
          ...child,
          view: { ...child.view, note: { ...child.view.note, title: "Черновик", version: 2 } },
        }),
      );
    });

    expect(title).toHaveValue("Новая");
    fireEvent.change(title, { target: { value: "После переключения" } });
    await waitFor(() => expect(updates).toHaveLength(1), { timeout: 3000 });
    expect(updates[0]).toMatchObject({ id: "note-3", expectedVersion: 5 });
  });

  it("не сбрасывает черновик, если ввод начался после старта загрузки", async () => {
    stubObjectUrl();
    const server = makeDetails("note-1", "Серверная", { contentMarkdown: "Сервер" });
    const reloaded = makeDetails("note-1", "Серверная 2", {
      contentMarkdown: "Новое",
      version: 2,
    });
    const get = deferred<UiOperationResult>();
    let getCalls = 0;
    let updateIssued = 0;
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(server.view));
      if (operationId === NOTES_QUERY_IDS.get) {
        getCalls += 1;
        return getCalls === 1 ? success(server) : get.promise;
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: server.view });
      if (operationId === NOTES_COMMAND_IDS.update) {
        updateIssued += 1;
        return failure("VERSION_CONFLICT", "Конфликт версий");
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Серверная"));
    fireEvent.change(title, { target: { value: "Черновик" } });
    await screen.findByText("Конфликт версий", { exact: false });

    fireEvent.click(screen.getByTestId("note-conflict-reload"));
    await waitFor(() => expect(title).toBeDisabled());
    expect(updateIssued).toBe(1);

    const editor = screen.getByRole("textbox", { name: "Содержимое заметки" });
    fireEvent.change(editor, { target: { value: "Ввод во время загрузки" } });

    await act(async () => {
      get.resolve(success(reloaded));
    });

    await waitFor(() => expect(title).toHaveValue("Черновик"));
    expect(editor).toHaveValue("Ввод во время загрузки");
    expect(title).not.toBeDisabled();
    expect(screen.getByTestId("note-save-state")).toHaveTextContent("Есть изменения");
  });

  it("после move синхронизирует version и порядок без полной перезагрузки", async () => {
    const first = makeDetails("note-a", "Первая");
    const second = makeDetails("note-b", "Вторая", { position: 1 });
    let notes = [first, second];
    let getCalls = 0;
    const updates: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(listOf(...notes.map((details) => details.view)));
      }
      if (operationId === NOTES_QUERY_IDS.get) {
        getCalls += 1;
        const id = (input as { id: string }).id;
        return success(notes.find((details) => details.view.note.id === id) ?? second);
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        const id = (input as { id: string }).id;
        return success({ view: (notes.find((item) => item.view.note.id === id) ?? second).view });
      }
      if (operationId === NOTES_COMMAND_IDS.update) {
        const values = input as Record<string, unknown>;
        updates.push(values);
        const id = String(values.id);
        const updated = makeDetails(id, String(values.title), {
          position: id === "note-b" ? 1 : 0,
          version: (notes.find((item) => item.view.note.id === id)?.view.note.version ?? 1) + 1,
        });
        notes = notes.map((item) => (item.view.note.id === id ? updated : item));
        return success(updated);
      }
      if (operationId === NOTES_COMMAND_IDS.move) {
        const moved = makeDetails("note-b", "Черновик", { position: 0, version: 3 });
        const neighbor = makeDetails("note-a", "Первая", { position: 1, version: 2 });
        notes = [moved, neighbor];
        return success({
          note: moved.view.note,
          affectedNotes: [neighbor.view.note],
        });
      }
      return success({ items: [] });
    };

    const { container } = render(<NotesView invoke={invoke} search="?note=note-b" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Вторая"));

    fireEvent.change(title, { target: { value: "Черновик" } });
    await waitFor(() => expect(updates).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(title).not.toBeDisabled());

    const callsBeforeMove = getCalls;
    fireEvent.click(screen.getByRole("button", { name: "Переместить Черновик выше" }));
    await waitFor(() => expect(title).not.toBeDisabled());
    await waitFor(() =>
      expect(
        [...container.querySelectorAll("[data-note-tree-item]")].map((item) =>
          item.getAttribute("data-note-tree-item"),
        ),
      ).toEqual(["note-b", "note-a"]),
    );

    // Никакой полной перезагрузки: get вызывался только при открытии заметки.
    expect(getCalls).toBe(callsBeforeMove);
    expect(title).toHaveValue("Черновик");

    fireEvent.change(title, { target: { value: "После move" } });
    await waitFor(() => expect(updates).toHaveLength(2), { timeout: 3000 });
    expect(updates[1]).toMatchObject({ id: "note-b", expectedVersion: 3 });
  });

  it("переиспользует idempotency key для того же снимка update", async () => {
    let details = makeDetails("note-1", "Исходная");
    const updateKeys: Array<string | undefined> = [];
    let attempts = 0;
    const invoke: UiOperationInvoker = async (operationId, input, options) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.update) {
        attempts += 1;
        updateKeys.push(options?.idempotencyKey);
        if (attempts === 1) return failure("STORAGE_ERROR", "Временная ошибка");
        const values = input as Record<string, unknown>;
        details = makeDetails("note-1", String(values.title), {
          contentMarkdown: String(values.contentMarkdown),
          version: details.view.note.version + 1,
        });
        return success(details);
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Исходная"));
    fireEvent.change(title, { target: { value: "Первый вариант" } });

    const retry = await screen.findByRole("button", { name: "Повторить" }, { timeout: 3000 });
    fireEvent.click(retry);
    await screen.findByText("Сохранено", undefined, { timeout: 3000 });
    expect(updateKeys).toHaveLength(2);
    expect(updateKeys[0]).toBeTruthy();
    expect(updateKeys[1]).toBe(updateKeys[0]);

    fireEvent.change(title, { target: { value: "Второй вариант" } });
    await waitFor(() => expect(updateKeys).toHaveLength(3), { timeout: 3000 });
    expect(updateKeys[2]).not.toBe(updateKeys[0]);
  });

  it("держит idempotency key создания до успеха и меняет после него", async () => {
    const created: NoteDetails[] = [];
    const createKeys: Array<string | undefined> = [];
    const invoke: UiOperationInvoker = async (operationId, input, options) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(listOf(...created.map((details) => details.view)));
      }
      if (operationId === NOTES_QUERY_IDS.get) {
        const id = (input as { id: string }).id;
        return success(created.find((details) => details.view.note.id === id) ?? created[0]);
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        const id = (input as { id: string }).id;
        const visited = created.find((details) => details.view.note.id === id) ?? created[0];
        if (visited === undefined) throw new Error(`заметка ${id} не создана`);
        return success({ view: visited.view });
      }
      if (operationId === NOTES_COMMAND_IDS.create) {
        createKeys.push(options?.idempotencyKey);
        if (createKeys.length === 1) return failure("STORAGE_ERROR", "Временная ошибка");
        const details = makeDetails(`note-${created.length + 1}`);
        created.push(details);
        return success(details);
      }
      return success({ items: [] });
    };

    const { container } = render(<NotesView invoke={invoke} search="" />);
    fireEvent.click(await screen.findByTestId("note-create-empty"));
    await screen.findByText("Временная ошибка");
    const createTopButton = container.querySelector("[data-note-create-top]");
    expect(createTopButton).not.toBeNull();
    fireEvent.click(createTopButton as HTMLElement);
    await screen.findByTestId("note-title");
    fireEvent.click(createTopButton as HTMLElement);

    await waitFor(() => expect(createKeys).toHaveLength(3));
    expect(createKeys[0]).toBeTruthy();
    expect(createKeys[1]).toBe(createKeys[0]);
    expect(createKeys[2]).not.toBe(createKeys[0]);
  });

  it("использует ключ upload только для retry после ошибки", async () => {
    const details = makeDetails("note-1", "С картинкой");
    const uploadKeys: Array<string | undefined> = [];
    let sequence = 0;
    const invoke: UiOperationInvoker = async (operationId, _input, options) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.attachmentCreate) {
        uploadKeys.push(options?.idempotencyKey);
        sequence += 1;
        if (sequence === 1) return failure("STORAGE_ERROR", "Временная ошибка");
        return success({ attachment: attachment(`att-${sequence}`, "note-1") });
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    await screen.findByTestId("note-title");

    fireEvent.click(screen.getByTestId("editor-upload"));
    await waitFor(() => expect(uploadKeys).toHaveLength(1));
    fireEvent.click(screen.getByTestId("editor-upload"));
    await waitFor(() => expect(uploadKeys).toHaveLength(2));
    expect(uploadKeys[1]).toBe(uploadKeys[0]);

    fireEvent.click(screen.getByTestId("editor-upload"));
    await waitFor(() => expect(uploadKeys).toHaveLength(3));
    expect(uploadKeys[2]).not.toBe(uploadKeys[0]);

    editorState.bytes = [1, 2, 3, 4];
    fireEvent.click(screen.getByTestId("editor-upload"));
    await waitFor(() => expect(uploadKeys).toHaveLength(4));
    expect(uploadKeys[3]).not.toBe(uploadKeys[0]);
  });

  it("сериализует параллельные upload и сохраняет ключ retry", async () => {
    const details = makeDetails("note-1", "Параллельные изображения");
    const first = deferred<UiOperationResult>();
    const second = deferred<UiOperationResult>();
    const third = deferred<UiOperationResult>();
    const keys: Array<string | undefined> = [];
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const invoke: UiOperationInvoker = async (operationId, _input, options) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.attachmentCreate) {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        keys.push(options?.idempotencyKey);
        const deferred = calls === 1 ? first : calls === 2 ? second : third;
        return deferred.promise.finally(() => {
          active -= 1;
        });
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    await screen.findByTestId("note-title");
    fireEvent.click(screen.getByTestId("editor-upload"));
    await waitFor(() => expect(calls).toBe(1));

    editorState.bytes = [1, 2, 3, 4];
    fireEvent.click(screen.getByTestId("editor-upload"));
    expect(calls).toBe(1);
    first.resolve(success({ attachment: attachment("att-first", "note-1") }));
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => {
      second.resolve(failure("STORAGE_ERROR", "Временная ошибка"));
    });

    fireEvent.click(screen.getByTestId("editor-upload"));
    await waitFor(() => expect(calls).toBe(3));
    third.resolve(success({ attachment: attachment("att-retry", "note-1") }));
    await waitFor(() => expect(maxActive).toBe(1));
    expect(keys[1]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("удаляет неиспользуемое вложение только явным действием", async () => {
    const file = attachment("att-unused", "note-1");
    const details: NoteDetails = {
      ...makeDetails("note-1", "Без изображения"),
      attachments: [file],
    };
    const deleted: string[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_QUERY_IDS.attachmentGet) {
        return success({ attachment: { ...file, contentBase64: "aGVsbG8=" } });
      }
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.attachmentDelete) {
        deleted.push(String((input as { id: string }).id));
        return success({ deleted: true });
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Удалить вложение att-unused" }));

    await waitFor(() => expect(deleted).toEqual(["att-unused"]));
    expect(screen.queryByRole("button", { name: "Удалить вложение att-unused" })).toBeNull();
  });

  it("подтверждает удаление по свежему subtree и передаёт expectedDescendants", async () => {
    const details = makeDetails("note-1", "Удаляемая");
    const deleteInputs: Array<Record<string, unknown>> = [];
    let deleted = false;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(deleted ? { items: [], total: 0, nextOffset: null } : listOf(details.view));
      }
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_QUERY_IDS.subtree) {
        return success({ noteId: "note-1", noteCount: 3, attachmentCount: 2 });
      }
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.delete) {
        deleted = true;
        deleteInputs.push(input as Record<string, unknown>);
        return success({
          deleted: true,
          deletedNotes: [details.view.note],
          deletedAttachmentIds: [],
          deletedResourceRefs: [],
        });
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(deleteInputs).toHaveLength(1));
    expect(deleteInputs[0]).toMatchObject({ expectedDescendants: 3, confirm: true });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Страниц: 3, вложений: 2"));
  });

  it("показывает длинный заголовок в многострочном поле и сохраняет его без переводов строк", async () => {
    const longTitle = `Заголовок ${"сверхдлинноесловобезпробелов".repeat(2)}`;
    let details = makeDetails("note-1", longTitle);
    const updates: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(details.view));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      if (operationId === NOTES_COMMAND_IDS.update) {
        const values = input as Record<string, unknown>;
        updates.push(values);
        details = makeDetails("note-1", String(values.title), {
          contentMarkdown: String(values.contentMarkdown),
          version: details.view.note.version + 1,
        });
        return success(details);
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-1" />);
    const title = await screen.findByTestId("note-title");

    expect(title.tagName).toBe("TEXTAREA");
    expect(title).toHaveAttribute("aria-label", "Заголовок заметки");
    await waitFor(() => expect(title).toHaveValue(longTitle));

    const enter = createEvent.keyDown(title, { key: "Enter" });
    fireEvent(title, enter);
    expect(enter.defaultPrevented).toBe(true);

    fireEvent.change(title, { target: { value: "Первая строка\nВторая строка" } });
    await waitFor(() => expect(title).toHaveValue("Первая строка Вторая строка"));
    await waitFor(() => expect(updates).toHaveLength(1), { timeout: 3000 });
    expect(updates[0]).toMatchObject({
      id: "note-1",
      title: "Первая строка Вторая строка",
    });
  });

  it("обновляет многострочный заголовок при переключении заметки", async () => {
    const first = makeDetails("note-a", "Первая");
    const second = makeDetails("note-b", `Вторая ${"длинноеслово".repeat(5)}`);
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(listOf(first.view, second.view));
      }
      if (operationId === NOTES_QUERY_IDS.get) {
        const id = (input as { id: string }).id;
        return success(id === "note-b" ? second : first);
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        const id = (input as { id: string }).id;
        return success({ view: id === "note-b" ? second.view : first.view });
      }
      return success({ items: [] });
    };

    render(<NotesView invoke={invoke} search="?note=note-a" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Первая"));

    fireEvent.click(screen.getByRole("button", { name: second.view.note.title }));
    await waitFor(() => expect(title).toHaveValue(second.view.note.title));
    expect(title).toHaveValue(`Вторая ${"длинноеслово".repeat(5)}`);
  });

  it("не использует main, tablist и пересортировывает недавние", async () => {
    const first = noteView("note-a", "Первая", { position: 0 });
    const second = noteView("note-b", "Вторая", { position: 1 });
    const fresh = { ...second, lastOpenedAt: "2026-11-13T12:00:00.000Z" };
    const older = { ...first, lastOpenedAt: "2026-11-13T10:00:00.000Z" };
    const details = makeDetails("note-a", "Первая");
    const invoke: UiOperationInvoker = async (operationId) => {
      if (operationId === NOTES_QUERY_IDS.list) return success(listOf(older, fresh));
      if (operationId === NOTES_QUERY_IDS.get) return success(details);
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) return success({ view: details.view });
      return success({ items: [] });
    };

    const { container } = render(<NotesView invoke={invoke} search="?note=note-a" />);
    await screen.findByTestId("note-title");

    expect(screen.getByTestId("notes-view").tagName).toBe("DIV");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Дерево" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Недавние" }));
    await waitFor(() =>
      expect(
        [...container.querySelectorAll("[data-note-tree-item]")].map((item) =>
          item.getAttribute("data-note-tree-item"),
        ),
      ).toEqual(["note-b", "note-a"]),
    );
    expect(screen.queryByRole("button", { name: /Переместить/ })).toBeNull();
  });

  it("переносит страницу внутрь drop-ом, сохраняя черновик, предков и версии", async () => {
    const first = makeDetails("note-a", "Первая");
    const second = makeDetails("note-b", "Черновик", { position: 1 });
    let notes = [first, second];
    let versionB = 1;
    const moves: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        return success(listOf(...notes.map((details) => details.view)));
      }
      if (operationId === NOTES_QUERY_IDS.get) {
        const id = (input as { id: string }).id;
        return success(notes.find((details) => details.view.note.id === id) ?? second);
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        const id = (input as { id: string }).id;
        return success({ view: (notes.find((item) => item.view.note.id === id) ?? second).view });
      }
      if (operationId === NOTES_COMMAND_IDS.update) {
        const values = input as Record<string, unknown>;
        updates.push(values);
        versionB += 1;
        const current = notes.find((item) => item.view.note.id === "note-b") ?? second;
        const updated = makeDetails("note-b", String(values.title), {
          contentMarkdown: String(values.contentMarkdown),
          parentId: current.view.note.parentId,
          position: current.view.note.position,
          version: versionB,
        });
        notes = notes.map((item) => (item.view.note.id === "note-b" ? updated : item));
        return success(updated);
      }
      if (operationId === NOTES_COMMAND_IDS.move) {
        const values = input as Record<string, unknown>;
        moves.push(values);
        versionB += 1;
        const moved = makeDetails("note-b", "Черновик", {
          contentMarkdown: "Текст черновика",
          parentId: "note-a",
          position: 0,
          version: versionB,
        });
        const parent = makeDetails("note-a", "Первая", { version: 2 });
        notes = [parent, moved];
        return success({ note: moved.view.note, affectedNotes: [parent.view.note] });
      }
      return success({ items: [] });
    };

    const { container } = render(<NotesView invoke={invoke} search="?note=note-b" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Черновик"));

    fireEvent.change(title, { target: { value: "Черновик" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Содержимое заметки" }), {
      target: { value: "Текст черновика" },
    });
    await waitFor(() => expect(updates).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(title).not.toBeDisabled());

    stubRowRect(40);
    const dataTransfer = dragData();
    const source = required<HTMLElement>(container, "[data-note-tree-item='note-b']");
    const target = required<HTMLElement>(container, "[data-note-tree-item='note-a']");
    fireEvent.dragStart(source, { dataTransfer });
    fireDragOver(target, dataTransfer, 20);
    expect(
      required<HTMLElement>(container, "[data-note-drop-indicator='inside']"),
    ).toHaveTextContent("Внутрь");
    fireDrop(target, dataTransfer, 20);

    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0]).toMatchObject({
      id: "note-b",
      expectedVersion: 2,
      parentId: "note-a",
    });
    expect(moves[0]).not.toHaveProperty("position");

    // Ancestors и version пересчитаны из ответа move, черновик не перезагружен.
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Путь к странице" })).toHaveTextContent(
        "Первая",
      ),
    );
    expect(title).toHaveValue("Черновик");
    expect(screen.getByRole("textbox", { name: "Содержимое заметки" })).toHaveValue(
      "Текст черновика",
    );
    expect(screen.queryByRole("alert")).toBeNull();

    // Следующее сохранение использует version из ответа move, а не старую.
    await waitFor(() => expect(title).not.toBeDisabled());
    fireEvent.change(title, { target: { value: "После переноса" } });
    await waitFor(() => expect(updates).toHaveLength(2), { timeout: 3000 });
    expect(updates[1]).toMatchObject({ id: "note-b", expectedVersion: 3 });
  });

  it("показывает ошибку цикла без оптимистичного изменения дерева", async () => {
    const parent = makeDetails("note-a", "Родитель");
    const child = makeDetails("note-b", "Ребёнок", { parentId: "note-a", position: 0 });
    const moves: Array<Record<string, unknown>> = [];
    let moveFailure = "NOTE_TREE_CYCLE";
    let listCalls = 0;
    const invoke: UiOperationInvoker = async (operationId, input) => {
      if (operationId === NOTES_QUERY_IDS.list) {
        listCalls += 1;
        return success(listOf(parent.view, child.view));
      }
      if (operationId === NOTES_QUERY_IDS.get) {
        const id = (input as { id: string }).id;
        return success(id === "note-b" ? child : parent);
      }
      if (operationId === NOTES_QUERY_IDS.links) return success({ items: [] });
      if (operationId === NOTES_COMMAND_IDS.recordVisit) {
        const id = (input as { id: string }).id;
        return success({ view: id === "note-b" ? child.view : parent.view });
      }
      if (operationId === NOTES_COMMAND_IDS.move) {
        moves.push(input as Record<string, unknown>);
        return moveFailure === "NOTE_TREE_CYCLE"
          ? failure("NOTE_TREE_CYCLE", "Нельзя переместить страницу внутрь самой себя")
          : failure("NOTE_TREE_TOO_DEEP", "Превышена максимальная глубина дерева");
      }
      return success({ items: [] });
    };

    const { container } = render(<NotesView invoke={invoke} search="?note=note-a" />);
    const title = await screen.findByTestId("note-title");
    await waitFor(() => expect(title).toHaveValue("Родитель"));
    fireEvent.click(screen.getByRole("button", { name: "Развернуть Родитель" }));
    await screen.findByRole("button", { name: "Ребёнок" });

    const callsBeforeMove = listCalls;
    stubRowRect(40);
    const dataTransfer = dragData();
    fireEvent.dragStart(required<HTMLElement>(container, "[data-note-tree-item='note-a']"), {
      dataTransfer,
    });
    fireDragOver(
      required<HTMLElement>(container, "[data-note-tree-item='note-b']"),
      dataTransfer,
      20,
    );
    fireDrop(required<HTMLElement>(container, "[data-note-tree-item='note-b']"), dataTransfer, 20);

    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0]).toMatchObject({ id: "note-a", parentId: "note-b" });
    expect(
      await screen.findByText("Нельзя переместить страницу внутрь её собственной ветки"),
    ).toBeVisible();
    // Серверный отказ не перезагружает список и не меняет путь к странице.
    expect(listCalls).toBe(callsBeforeMove);
    expect(screen.getByRole("navigation", { name: "Путь к странице" })).not.toHaveTextContent(
      "Ребёнок",
    );
    expect(title).toHaveValue("Родитель");
    expect(
      [...container.querySelectorAll("[data-note-tree-item]")].map((item) =>
        item.getAttribute("data-note-tree-item"),
      ),
    ).toEqual(["note-a", "note-b"]);

    // Превышение глубины тоже показывается понятным текстом и не меняет дерево.
    moveFailure = "NOTE_TREE_TOO_DEEP";
    fireEvent.dragStart(required<HTMLElement>(container, "[data-note-tree-item='note-a']"), {
      dataTransfer,
    });
    fireDragOver(
      required<HTMLElement>(container, "[data-note-tree-item='note-b']"),
      dataTransfer,
      20,
    );
    fireDrop(required<HTMLElement>(container, "[data-note-tree-item='note-b']"), dataTransfer, 20);
    await waitFor(() => expect(moves).toHaveLength(2));
    expect(await screen.findByText("Превышена максимальная глубина дерева")).toBeVisible();
    expect(listCalls).toBe(callsBeforeMove);
    expect(title).toHaveValue("Родитель");
  });
});
