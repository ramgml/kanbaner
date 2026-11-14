import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
