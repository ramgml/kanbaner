import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  const content = container.querySelector<HTMLElement>(".kne-content");

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

afterEach(() => {
  cleanup();
});

describe("MarkdownNoteEditor: панель инструментов", () => {
  it("показывает доступную панель, блокирует её до готовности и делает активным текущий блок", async () => {
    const { container, onChange } = renderEditor();
    const toolbar = screen.getByRole("toolbar", { name: "Форматирование заметки" });

    expect(toolbar).toHaveAttribute("aria-controls");
    expect(within(toolbar).getByRole("button", { name: "Вставить блок" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );

    const content = await waitForReady(container);

    expect(content).toHaveAttribute("contenteditable", "true");
    expect(content).toHaveAttribute("aria-readonly", "false");
    expect(screen.getByRole("button", { name: "Жирный" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Обычный текст" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Заголовок 1" }));

    await waitFor(() => {
      expect(lastMarkdown(onChange)).toContain("# Привет");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Заголовок 1" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(screen.getByRole("button", { name: "Заголовок 1" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("button", { name: "Обычный текст" })).not.toHaveAttribute(
      "aria-pressed",
    );
  });

  it("поддерживает переход фокусом по кнопкам стрелками", async () => {
    const { container } = renderEditor();

    await waitForReady(container);

    const bold = screen.getByRole("button", { name: "Жирный" });

    bold.focus();
    fireEvent.keyDown(bold, { key: "ArrowRight" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Курсив" }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });

    expect(document.activeElement).toBe(bold);
  });
});

describe("MarkdownNoteEditor: синхронизация значения", () => {
  it("применяет внешнее значение без вызова onChange", async () => {
    const { container, rerender, onChange } = renderEditor();

    await waitForReady(container);
    rerender({ value: "## Внешний заголовок\n\nОбновлённый **текст**" });

    await waitFor(() => {
      expect(container.querySelector(".kne-content")).toHaveTextContent("Внешний заголовок");
    });
    expect(container.querySelector(".kne-content")).toHaveTextContent("Обновлённый текст");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("не трогает документ при эквивалентном значении с другим переводом строк", async () => {
    const { container, rerender, onChange } = renderEditor({ value: "Строка\n" });
    const content = await waitForReady(container);

    rerender({ value: "Строка\r\n" });
    await waitFor(() => {
      expect(container.querySelector(".kne-content")).toBe(content);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("пересоздаёт редактор при смене noteId и берёт новое значение", async () => {
    const { container, rerender, onChange } = renderEditor({ value: "Первый документ" });
    const first = await waitForReady(container);

    rerender({ noteId: "note-2", value: "Второй документ" });

    await waitFor(() => {
      const next = container.querySelector(".kne-content");

      expect(next).not.toBeNull();
      expect(next).not.toBe(first);
      expect(next).toHaveTextContent("Второй документ");
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MarkdownNoteEditor: readOnly и disabled", () => {
  it("в режиме readOnly запрещает ввод, панель и slash-меню", async () => {
    const { container } = renderEditor({ readOnly: true });
    const content = await waitForReady(container);

    expect(container.querySelector(".kanbaner-note-editor")).toHaveAttribute(
      "data-read-only",
      "true",
    );
    expect(content).toHaveAttribute("contenteditable", "false");
    expect(content).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("button", { name: "Жирный" })).toBeDisabled();

    fireEvent.keyDown(content, { key: "/" });

    expect(screen.queryByRole("dialog", { name: "Вставить блок" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Вставить блок" })).toBeDisabled();
  });
});

describe("MarkdownNoteEditor: изображения", () => {
  it("вставляет загруженное изображение и сообщает Markdown через onChange", async () => {
    const { container, onChange, onUploadImage } = renderEditor({ value: "" });

    await waitForReady(container);

    const input = screen.getByTestId("note-image-input");

    fireEvent.change(input, { target: { files: [imageFile()] } });

    await waitFor(() => {
      expect(onUploadImage).toHaveBeenCalledTimes(1);
      expect(lastMarkdown(onChange)).toContain("![схема.png](attachment://img-1)");
    });
    expect(onUploadImage.mock.calls[0]?.[0]).toBeInstanceOf(File);
    await waitFor(() => {
      expect(container.querySelector('img[src="attachment://img-1"]')).not.toBeNull();
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
});

describe("MarkdownNoteEditor: slash-меню", () => {
  it("открывается кнопкой, фильтрует действия и применяет выбранный блок", async () => {
    const { container, onChange } = renderEditor();

    await waitForReady(container);

    fireEvent.click(screen.getByRole("button", { name: "Вставить блок" }));

    const dialog = await screen.findByRole("dialog", { name: "Вставить блок" });
    const search = within(dialog).getByRole("combobox");

    fireEvent.change(search, { target: { value: "заголовок 1" } });

    expect(within(dialog).getByRole("option", { name: "Заголовок 1" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: "Заголовок 2" })).toBeNull();

    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Вставить блок" })).toBeNull();
      expect(lastMarkdown(onChange)).toContain("# Привет");
    });
  });

  it("открывается клавишей / в пустом блоке и закрывается Escape", async () => {
    const { container } = renderEditor({ value: "" });
    const content = await waitForReady(container);

    fireEvent.keyDown(content, { key: "/" });

    const dialog = await screen.findByRole("dialog", { name: "Вставить блок" });

    expect(within(dialog).getByRole("combobox")).toHaveFocus();

    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Вставить блок" })).toBeNull();
    });
  });

  it("не перехватывает / внутри непустого блока", async () => {
    const { container } = renderEditor();
    const content = await waitForReady(container);

    fireEvent.keyDown(content, { key: "/" });

    expect(screen.queryByRole("dialog", { name: "Вставить блок" })).toBeNull();
  });

  it("не показывает пустой список без совпадений", async () => {
    const { container } = renderEditor();

    await waitForReady(container);
    fireEvent.click(screen.getByRole("button", { name: "Вставить блок" }));

    const dialog = await screen.findByRole("dialog", { name: "Вставить блок" });

    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "нет такого блока" },
    });

    expect(
      within(dialog).getByText("Ничего не найдено. Попробуйте другой запрос."),
    ).toBeInTheDocument();
  });
});

describe("MarkdownNoteEditor: raw HTML", () => {
  it("показывает raw HTML текстом и не создаёт исполняемых узлов", async () => {
    const { container } = renderEditor({
      value: "<script>window.__noteXss = true</script>\n\nБезопасный текст",
    });

    await waitForReady(container);

    const html = container.querySelector('[data-type="html"]');

    expect(html).not.toBeNull();
    expect(html).toHaveTextContent("<script>window.__noteXss = true</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent("Безопасный текст");
  });
});
