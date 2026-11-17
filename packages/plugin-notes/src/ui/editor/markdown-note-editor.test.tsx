import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownNoteEditor, type MarkdownNoteEditorProps } from "./markdown-note-editor.tsx";

const DEFAULT_NOTE_ID = "note-1";
const DEFAULT_VALUE = "Привет";

interface RenderedEditor {
  readonly container: HTMLElement;
  readonly rerender: (props: Partial<MarkdownNoteEditorProps>) => void;
  readonly onChange: ReturnType<typeof vi.fn<(markdown: string) => void>>;
  readonly onUploadImage: ReturnType<typeof vi.fn<(file: File) => Promise<string>>>;
}

function renderEditor(overrides: Partial<MarkdownNoteEditorProps> = {}): RenderedEditor {
  const onChange = vi.fn<(markdown: string) => void>();
  const onUploadImage = vi.fn<(file: File) => Promise<string>>(async () => "attachment://img-1");
  const props: MarkdownNoteEditorProps = {
    noteId: DEFAULT_NOTE_ID,
    value: DEFAULT_VALUE,
    onChange,
    onUploadImage,
    ...overrides,
  };
  const view = render(<MarkdownNoteEditor {...props} />);

  return {
    container: view.container,
    rerender: (next) => {
      view.rerender(<MarkdownNoteEditor {...props} {...next} />);
    },
    onChange,
    onUploadImage,
  };
}

async function waitForReady(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector(".kanbaner-note-editor")).toHaveAttribute("data-ready", "true");
  });

  const content = container.querySelector<HTMLElement>(".bn-editor");
  expect(content).not.toBeNull();
  return content as HTMLElement;
}

function consoleMessages(spy: { readonly mock: { readonly calls: readonly unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map((part) => String(part)).join(" ")).join("\n");
}

interface TestBlockEditor {
  readonly document: ReadonlyArray<{ readonly id: string }>;
  readonly updateBlock: (
    block: { readonly id: string },
    update: { readonly type: string; readonly props?: Record<string, unknown> },
  ) => { readonly id: string };
  readonly setTextCursorPosition: (
    block: { readonly id: string },
    placement: "start" | "end",
  ) => void;
  readonly getExtension: (key: string) =>
    | {
        readonly openSuggestionMenu: (
          trigger: string,
          options?: { readonly deleteTriggerCharacter?: boolean },
        ) => void;
      }
    | undefined;
}

/**
 * BlockNote не отдаёт экземпляр редактора наружу, а в unit-тесте нужен
 * публичный API suggestion menu. Достаём editor из props BlockNoteView через
 * React fiber контейнера.
 */
function blockEditorFor(content: HTMLElement): TestBlockEditor {
  const fiberKey = Object.keys(content).find((key) => key.startsWith("__reactFiber"));
  let fiber = (
    fiberKey === undefined ? null : (content as unknown as Record<string, unknown>)[fiberKey]
  ) as { return?: unknown; memoizedProps?: Record<string, unknown> } | null;

  while (fiber !== null) {
    const editor = fiber.memoizedProps?.editor;
    if (typeof editor === "object" && editor !== null && "getExtension" in editor) {
      return editor as unknown as TestBlockEditor;
    }
    fiber = (fiber.return ?? null) as typeof fiber;
  }

  throw new Error("BlockNote editor не найден в React fiber");
}

/**
 * Открывает slash-меню, выбирает «Картинка» и имитирует отмену системного
 * picker: hidden input получает click, но change с файлом не приходит.
 */
async function cancelImagePickerFromSlashMenu(content: HTMLElement): Promise<void> {
  const editor = blockEditorFor(content);
  const firstBlock = editor.document.at(0);
  if (firstBlock === undefined) throw new Error("В документе нет блоков");
  editor.setTextCursorPosition(firstBlock, "end");
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
    toJSON: () => ({}),
  } as DOMRect);

  editor.getExtension("suggestionMenu")?.openSuggestionMenu("/", {
    deleteTriggerCharacter: true,
  });
  const imageOption = await screen.findByRole("option", { name: /Картинка/u });
  const input = screen.getByTestId("note-image-input");
  const click = vi.spyOn(input, "click").mockImplementation(() => undefined);

  fireEvent.click(imageOption);
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
}

function contentTypes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-content-type]")).map(
    (element) => element.getAttribute("data-content-type") ?? "",
  );
}

function lastMarkdown(onChange: RenderedEditor["onChange"]): string {
  const calls = onChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return String(calls[calls.length - 1]?.[0] ?? "");
}

function imageFile(name = "схема.png", type = "image/png"): File {
  return new File(["binary"], name, { type });
}

function pasteFile(element: HTMLElement, file: File): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: ["Files"],
      files: [file],
      items: [{ type: file.type, getAsFile: () => file }],
      getData: () => "",
    },
  });
  element.dispatchEvent(event);
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  class ClipboardEventStub extends Event {
    readonly clipboardData: unknown;

    constructor(type: string, init?: { readonly clipboardData?: unknown }) {
      super(type);
      this.clipboardData = init?.clipboardData;
    }
  }
  vi.stubGlobal("ClipboardEvent", ClipboardEventStub);
  if (!("getClientRects" in Node.prototype)) {
    Object.defineProperty(Node.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
  if (!("getClientRects" in Range.prototype)) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
  if (!("getBoundingClientRect" in Range.prototype)) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }),
    });
  }
  if (!("getBoundingClientRect" in Node.prototype)) {
    Object.defineProperty(Node.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarkdownNoteEditor: синхронизация значения", () => {
  it("показывает Markdown как блоки без ложного onChange", async () => {
    const { container, onChange } = renderEditor({
      value: "## Заголовок\n\nТекст с **акцентом**",
    });

    const content = await waitForReady(container);
    expect(content).toHaveAttribute("contenteditable", "true");
    expect(content).toHaveAttribute("aria-readonly", "false");
    expect(content).toHaveTextContent("Заголовок");
    expect(content).toHaveTextContent("Текст с акцентом");
    expect(container.querySelector("h2")).toHaveTextContent("Заголовок");
    expect(container.querySelector("strong")).toHaveTextContent("акцентом");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("применяет внешнее значение без вызова onChange", async () => {
    const { container, rerender, onChange } = renderEditor();
    await waitForReady(container);
    rerender({ value: "## Внешний заголовок\n\nОбновлённый **текст**" });

    await waitFor(() => {
      expect(container.querySelector(".bn-editor")).toHaveTextContent("Внешний заголовок");
    });
    expect(container.querySelector(".bn-editor")).toHaveTextContent("Обновлённый текст");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("не пересоздаёт документ при эквивалентном значении с другим переводом строк", async () => {
    const { container, rerender, onChange } = renderEditor({ value: "Строка\n" });
    const content = await waitForReady(container);

    rerender({ value: "Строка\r\n" });
    expect(container.querySelector(".bn-editor")).toBe(content);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("пересоздаёт редактор при смене noteId и берёт новое значение", async () => {
    const { container, rerender, onChange } = renderEditor({ value: "Первый документ" });
    const first = await waitForReady(container);

    rerender({ noteId: "note-2", value: "Второй документ" });

    await waitFor(() => {
      expect(first).not.toHaveTextContent("Первый документ");
      expect(container.querySelector(".bn-editor")).toHaveTextContent("Второй документ");
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MarkdownNoteEditor: readOnly и disabled", () => {
  it("в режиме readOnly запрещает ввод и скрывает редактирующие контролы", async () => {
    const { container } = renderEditor({ readOnly: true });
    const content = await waitForReady(container);

    expect(container.querySelector(".kanbaner-note-editor")).toHaveAttribute(
      "data-read-only",
      "true",
    );
    expect(content).toHaveAttribute("contenteditable", "false");
    expect(content).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByTestId("note-image-input")).toBeDisabled();
  });

  it("в режиме disabled помечает редактор aria-disabled", async () => {
    const { container } = renderEditor({ disabled: true });
    const content = await waitForReady(container);

    expect(container.querySelector(".kanbaner-note-editor")).toHaveAttribute(
      "data-disabled",
      "true",
    );
    expect(content).toHaveAttribute("aria-disabled", "true");
    expect(content).toHaveAttribute("contenteditable", "false");
  });
});

describe("MarkdownNoteEditor: отмена picker из slash-меню", () => {
  it("не меняет непустой абзац", async () => {
    const { container, onChange } = renderEditor({ value: "Текст" });
    const content = await waitForReady(container);

    await cancelImagePickerFromSlashMenu(content);

    expect(content.textContent).toBe("Текст");
    expect(contentTypes(container)).toEqual(["paragraph"]);
    expect(container.querySelector("[data-content-type='image']")).toBeNull();
    await waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0] ?? "").toBe("Текст");
    });
  });

  it.each([
    { label: "пустой heading", type: "heading", props: { level: 1 } },
    { label: "пустой список", type: "bulletListItem", props: undefined },
  ])("не меняет $label и его тип", async ({ type, props }) => {
    const { container } = renderEditor({ value: "" });
    const content = await waitForReady(container);
    const editor = blockEditorFor(content);
    const firstBlock = editor.document.at(0);
    if (firstBlock === undefined) throw new Error("В документе нет блоков");
    const block = editor.updateBlock(firstBlock, props === undefined ? { type } : { type, props });
    editor.setTextCursorPosition(block, "end");

    await cancelImagePickerFromSlashMenu(content);

    expect(contentTypes(container)).toEqual([type]);
    expect(content.textContent).toBe("");
    expect(container.querySelector("[data-content-type='image']")).toBeNull();
  });
});

describe("MarkdownNoteEditor: изображения", () => {
  it("вставляет загруженное изображение и сообщает Markdown через onChange", async () => {
    const { container, onChange, onUploadImage } = renderEditor({ value: "" });
    await waitForReady(container);

    fireEvent.change(screen.getByTestId("note-image-input"), {
      target: { files: [imageFile()] },
    });

    await waitFor(() => {
      expect(onUploadImage).toHaveBeenCalledTimes(1);
      expect(lastMarkdown(onChange)).toContain("![схема.png](attachment://img-1)");
    });
    expect(onUploadImage.mock.calls[0]?.[0]).toBeInstanceOf(File);
    await waitFor(() => {
      expect(container.querySelector('img[src="attachment://img-1"]')).not.toBeNull();
    });
  });

  it("вставляет изображение рядом с существующим текстом, не теряя его", async () => {
    const { container, onChange } = renderEditor({ value: "Текст до" });
    await waitForReady(container);

    fireEvent.change(screen.getByTestId("note-image-input"), {
      target: { files: [imageFile()] },
    });

    await waitFor(() => {
      const markdown = lastMarkdown(onChange);
      expect(markdown).toContain("Текст до");
      expect(markdown).toContain("![схема.png](attachment://img-1)");
    });
  });

  it("копирует живой FileList до reset input", async () => {
    const { container, onUploadImage } = renderEditor({ value: "" });
    await waitForReady(container);

    const input = screen.getByTestId("note-image-input");
    const liveFiles = [imageFile()];
    let value = "";
    Object.defineProperty(input, "files", {
      configurable: true,
      get: () => liveFiles,
    });
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => value,
      set: (next: string) => {
        value = next;
        if (next === "") liveFiles.splice(0);
      },
    });

    fireEvent.change(input);

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));
    expect(value).toBe("");
  });

  it("показывает ошибку загрузки и не меняет документ", async () => {
    const onUploadImage = vi.fn<(file: File) => Promise<string>>(async () => {
      throw new Error("Хранилище недоступно");
    });
    const { container, onChange } = renderEditor({ value: "", onUploadImage });

    await waitForReady(container);
    fireEvent.change(screen.getByTestId("note-image-input"), {
      target: { files: [imageFile()] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось загрузить изображение: Хранилище недоступно",
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector("img[src^='attachment:']")).toBeNull();
  });

  it("отклоняет не-image файл до загрузки", async () => {
    const { container, onChange, onUploadImage } = renderEditor({ value: "" });
    await waitForReady(container);
    fireEvent.change(screen.getByTestId("note-image-input"), {
      target: { files: [imageFile("документ.pdf", "application/pdf")] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Можно загрузить только файл изображения.",
    );
    expect(onUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("не публикует pending placeholder при ошибке встроенного upload", async () => {
    const onUploadImage = vi.fn<(file: File) => Promise<string>>(async () => {
      throw new Error("Хранилище недоступно");
    });
    const { container, onChange } = renderEditor({ value: "", onUploadImage });
    const content = await waitForReady(container);

    content.focus();
    pasteFile(content, imageFile("diagram]v2.png"));

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось загрузить изображение: Хранилище недоступно",
    );
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // onChange — единственный канал, который запускает note.update/autosave.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("возвращает атомарный url и безопасный alt при успешном встроенном upload", async () => {
    const { container, onChange } = renderEditor({ value: "" });
    const content = await waitForReady(container);

    content.focus();
    pasteFile(content, imageFile("diagram]v2.png"));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
      const first = String(onChange.mock.calls[0]?.[0] ?? "");
      expect(first).toContain("![diagram v2.png](attachment://img-1)");
      expect(first).not.toContain("]v2");
    });
    expect(container.querySelector('img[src="attachment://img-1"]')).not.toBeNull();
  });

  it("публикует текст, введённый во время загрузки, без pending image", async () => {
    let resolveUpload: ((url: string) => void) | undefined;
    const onUploadImage = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const { container, rerender, onChange } = renderEditor({
      value: "- пункт",
      onUploadImage,
    });
    const content = await waitForReady(container);

    content.focus();
    pasteFile(content, imageFile());
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));

    const paragraph = content.querySelector("p");
    const textNode = paragraph?.firstChild;
    if (textNode !== null && textNode !== undefined) {
      textNode.textContent = `${textNode.textContent ?? ""} Дописанный текст`;
    } else {
      paragraph?.append(" Дописанный текст");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => {
      const markdown = lastMarkdown(onChange);
      expect(markdown).toContain("Дописанный текст");
      expect(markdown).not.toContain("data:image/gif");
      expect(markdown).not.toContain("attachment://");
    });

    const draft = lastMarkdown(onChange);
    rerender({ value: draft });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastMarkdown(onChange)).toBe(draft);

    rerender({ noteId: "note-2", value: "Другая заметка" });
    resolveUpload?.("attachment://img-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container).toHaveTextContent("Другая заметка");
    const emitted = onChange.mock.calls.map(([markdown]) => String(markdown));
    expect(emitted.some((markdown) => markdown.includes("Дописанный текст"))).toBe(true);
    expect(emitted.at(-1) ?? "").not.toContain("attachment://img-1");
  });

  it("не публикует failed upload на документе, требующем нормализации", async () => {
    const onUploadImage = vi.fn<(file: File) => Promise<string>>(async () => {
      throw new Error("Хранилище недоступно");
    });
    const { container, onChange } = renderEditor({
      value: "<div>raw</div>\n\n- пункт\n\n![ref][s]\n\n[s]: attachment://a",
      onUploadImage,
    });
    const content = await waitForReady(container);

    content.focus();
    pasteFile(content, imageFile());

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось загрузить изображение: Хранилище недоступно",
    );
    await waitFor(() => {
      expect(container.querySelector('img[src=""]')).toBeNull();
      expect(container.querySelector('img[src^="data:image/gif"]')).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("не вставляет image, если заметка заблокирована до завершения загрузки", async () => {
    let resolveUpload: ((url: string) => void) | undefined;
    const onUploadImage = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const { container, rerender, onChange } = renderEditor({ value: "", onUploadImage });
    await waitForReady(container);

    fireEvent.change(screen.getByTestId("note-image-input"), {
      target: { files: [imageFile()] },
    });
    rerender({ readOnly: true });
    resolveUpload?.("attachment://img-1");

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector("img")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MarkdownNoteEditor: raw HTML", () => {
  it("не создаёт исполняемых HTML-узлов", async () => {
    const { container } = renderEditor({
      value: "<script>window.__noteXss = true</script>\n\nБезопасный текст",
    });

    await waitForReady(container);
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent("Безопасный текст");
    expect(container).not.toContainHTML("<script>window.__noteXss = true</script>");
  });

  it("показывает raw HTML литерально и сохраняет его при следующем onChange", async () => {
    const { container, onChange } = renderEditor({
      value: "<script>window.__noteXss = true</script>\n\nБезопасный текст",
    });
    await waitForReady(container);

    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent("<script>window.__noteXss = true</script>");
    expect(container).toHaveTextContent("Безопасный текст");

    fireEvent.change(screen.getByTestId("note-image-input"), {
      target: { files: [imageFile()] },
    });

    await waitFor(() => {
      expect(lastMarkdown(onChange)).toContain("<script>window.__noteXss = true</script>");
    });
  });
});

describe("MarkdownNoteEditor: lifecycle сериализации", () => {
  const INLINE_IMAGE = "До ![Схема](attachment://img-1) после";

  it("не вызывает flushSync из lifecycle при инициализации с inline image", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, onChange } = renderEditor({ value: INLINE_IMAGE });

    const content = await waitForReady(container);

    expect(content.querySelector('img[src="attachment://img-1"]')).not.toBeNull();
    expect(consoleMessages(consoleError)).not.toContain("flushSync");
    expect(consoleMessages(consoleWarn)).not.toContain("renderHTML() failed");
    expect(onChange).not.toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("не сериализует inline image при lifecycle-смене editable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, rerender, onChange } = renderEditor({ value: INLINE_IMAGE });
    await waitForReady(container);

    // BlockNoteView меняет editor.isEditable внутри своего эффекта, а setEditable
    // эмитит change. Сериализация этого события не должна попадать в lifecycle.
    rerender({ readOnly: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(consoleMessages(consoleError)).not.toContain("flushSync");
    expect(consoleMessages(consoleWarn)).not.toContain("renderHTML() failed");
    expect(onChange).not.toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("не применяет старую инициализацию при быстрой смене noteId", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, rerender, onChange } = renderEditor({ value: "Первый документ" });
    await waitForReady(container);

    // Два разных noteId до ожидания готовности: применяется только последний,
    // промежуточный и исходный документы не должны протечь в редактор.
    rerender({ noteId: "note-2", value: "Второй документ" });
    rerender({ noteId: "note-3", value: INLINE_IMAGE });

    await waitFor(() => {
      expect(container.querySelector(".bn-editor")).toHaveTextContent("До");
      expect(container.querySelector(".bn-editor")).not.toHaveTextContent("Первый документ");
      expect(container.querySelector(".bn-editor")).not.toHaveTextContent("Второй документ");
    });
    expect(container.querySelector('img[src="attachment://img-1"]')).not.toBeNull();
    expect(consoleMessages(consoleError)).not.toContain("flushSync");
    expect(consoleMessages(consoleWarn)).not.toContain("renderHTML() failed");
    expect(onChange).not.toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("применяет последнее внешнее значение и не публикует устаревший документ", async () => {
    const { container, rerender, onChange } = renderEditor({ value: "Исходный" });
    await waitForReady(container);

    rerender({ value: INLINE_IMAGE });
    rerender({ value: "Финальный" });

    await waitFor(() => {
      const content = container.querySelector(".bn-editor");
      expect(content).toHaveTextContent("Финальный");
      expect(content).not.toHaveTextContent("Исходный");
      expect(content).not.toHaveTextContent("Схема");
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("не публикует onChange при инициализации inline image", async () => {
    const { container, onChange } = renderEditor({ value: INLINE_IMAGE });
    await waitForReady(container);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('img[src="attachment://img-1"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MarkdownNoteEditor: догрузка вложений", () => {
  const DATA_URL = "data:image/png;base64,aGVsbG8=";
  const URLS = new Map([["attachment://img-1", DATA_URL]]);

  it("подставляет inline data URL без onChange", async () => {
    const { container, rerender, onChange } = renderEditor({
      value: "До ![Схема](attachment://img-1) после",
    });
    const content = await waitForReady(container);
    expect(content.querySelector('img[src="attachment://img-1"]')).not.toBeNull();

    rerender({ attachmentUrls: URLS });

    await waitFor(() => {
      expect(container.querySelector(`img[src="${DATA_URL}"]`)).not.toBeNull();
    });
    expect(content).toHaveTextContent("До");
    expect(content).toHaveTextContent("после");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("подставляет URL block image и сохраняет его при внешнем значении", async () => {
    const { container, rerender, onChange } = renderEditor({
      value: "![Схема](attachment://img-1)",
    });
    await waitForReady(container);

    rerender({ attachmentUrls: URLS });
    await waitFor(() => {
      expect(container.querySelector(`img[src="${DATA_URL}"]`)).not.toBeNull();
    });

    // Внешнее значение с canonical URL заново строит блоки: подстановка
    // вложений обязана примениться и к новому дереву, не помечая документ.
    rerender({
      value: "Обновлённый текст\n\n![Схема](attachment://img-1)",
      attachmentUrls: URLS,
    });
    await waitFor(() => {
      expect(container.querySelector(".bn-editor")).toHaveTextContent("Обновлённый текст");
      expect(container.querySelector(`img[src="${DATA_URL}"]`)).not.toBeNull();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("не публикует onChange при смене editable с подставленными вложениями", async () => {
    const { container, rerender, onChange } = renderEditor({
      value: "![Схема](attachment://img-1)",
    });
    await waitForReady(container);
    rerender({ attachmentUrls: URLS });
    await waitFor(() => {
      expect(container.querySelector(`img[src="${DATA_URL}"]`)).not.toBeNull();
    });

    // Блокировка на время загрузки другой страницы меняет editor.isEditable;
    // ProseMirror эмитит change, но документ не изменился и autosave не нужен.
    rerender({ attachmentUrls: URLS, readOnly: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    rerender({ attachmentUrls: URLS, readOnly: false });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onChange).not.toHaveBeenCalled();
  });
});
