import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Editor } from "@milkdown/kit/core";

import { createNoteEditor, destroyNoteEditor } from "./create-note-editor.ts";
import {
  applyNoteEditorLink,
  currentLinkHref,
  insertNoteEditorImage,
  readNoteEditorToolbarState,
  replaceNoteMarkdown,
  serializeNoteMarkdown,
} from "./editor-actions.ts";
import { normalizeMarkdownDocument } from "./editor-markdown.ts";

interface Harness {
  readonly editor: Editor;
  readonly root: HTMLElement;
  readonly changes: string[];
  readonly cleanup: () => Promise<void>;
}

const editors: Harness[] = [];

async function createHarness(markdown: string, readOnly = false): Promise<Harness> {
  const root = document.createElement("div");
  document.body.append(root);
  const changes: string[] = [];
  const editor = await createNoteEditor({
    root,
    markdown,
    readOnly,
    disabled: false,
    ariaLabel: "Тестовая заметка",
    editorId: `note-editor-${editors.length}`,
    onMarkdownChange: (next) => {
      changes.push(next);
    },
    onToolbarStateChange: () => {},
  });
  const harness: Harness = {
    editor,
    root,
    changes,
    cleanup: async () => {
      await destroyNoteEditor(editor);
      root.remove();
    },
  };
  editors.push(harness);
  return harness;
}

afterEach(async () => {
  const pending = editors.splice(0, editors.length);
  await Promise.all(pending.map((harness) => harness.cleanup()));
});

/**
 * Канонический вывод Milkdown Kit 7.23.0. Отличия от входа ожидаемы и
 * безопасны: списки переводятся в `*`, разделители таблиц сокращаются,
 * жёсткий перенос кодируется обратной косой чертой.
 */
const ROUNDTRIP_FIXTURES: readonly (readonly [name: string, input: string, output: string])[] = [
  [
    "заголовок и inline-разметка",
    "## Заголовок\n\nТекст **жирный** и *курсив*, ~~зачёркнутый~~ и `код`.",
    "## Заголовок\n\nТекст **жирный** и *курсив*, ~~зачёркнутый~~ и `код`.\n",
  ],
  [
    "маркированный и нумерованный списки",
    "- один\n- два\n\n1. первый\n2. второй",
    "* один\n* два\n\n1. первый\n2. второй\n",
  ],
  [
    "цитата и блок кода",
    "> Цитата\n\n```ts\nconst x = 1;\n```",
    "> Цитата\n\n```ts\nconst x = 1;\n```\n",
  ],
  ["task list GFM", "- [x] Готово\n- [ ] Сделать", "* [x] Готово\n* [ ] Сделать\n"],
  ["таблица GFM", "| A | B |\n| --- | --- |\n| 1 | 2 |", "| A | B |\n| - | - |\n| 1 | 2 |\n"],
  [
    "ссылка и изображение",
    "[Ссылка](https://example.com) и ![Схема](attachment://img-1)",
    "[Ссылка](https://example.com) и ![Схема](attachment://img-1)\n",
  ],
  ["raw HTML остаётся текстом", "<script>alert(1)</script>", "<script>alert(1)</script>\n"],
  ["жёсткий перенос", "Строка с  \nжёстким переносом", "Строка с\\\nжёстким переносом\n"],
  ["пустой документ", "", ""],
];

describe("roundtrip Markdown через Milkdown Kit", () => {
  it.each(ROUNDTRIP_FIXTURES)("сохраняет %s", async (_name, input, output) => {
    const { editor } = await createHarness(input);

    expect(serializeNoteMarkdown(editor)).toBe(output);
  });

  it("идемпотентен: повторная сериализация канонического Markdown не меняет документ", async () => {
    const { editor } = await createHarness(
      "## Заголовок\n\n- [x] Готово\n- [ ] Сделать\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
    );
    const first = serializeNoteMarkdown(editor);

    // ProseMirror сравнивает узлы вместе с атрибутами, а свежий парсинг
    // создаёт эквивалентный, но не идентичный по ссылкам документ.
    replaceNoteMarkdown(editor, first);

    expect(serializeNoteMarkdown(editor)).toBe(first);
  });

  it("применяет внешний Markdown и сохраняет безопасное выделение", async () => {
    const { editor } = await createHarness("Старый текст");
    const next = "# Новый заголовок\n\nАбзац с **акцентом**";

    expect(replaceNoteMarkdown(editor, next)).toBe(true);
    expect(normalizeMarkdownDocument(serializeNoteMarkdown(editor))).toBe(next);

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const position = view.state.doc.content.size;
      view.focus();
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(Math.max(0, position - 1))),
        ),
      );
    });

    expect(replaceNoteMarkdown(editor, "Короткий")).toBe(true);
    expect(normalizeMarkdownDocument(serializeNoteMarkdown(editor))).toBe("Короткий");
  });

  it("возвращает состояние панели для текущего блока", async () => {
    const { editor } = await createHarness("## Заголовок\n\n**Жирный текст**");

    expect(readNoteEditorToolbarState(editor).heading).toBe(2);

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(view.state.doc.content.size - 1)),
        ),
      );
    });

    const state = readNoteEditorToolbarState(editor);

    expect(state.heading).toBe(0);
    expect(state.bold).toBe(true);
  });

  it("вставляет ссылку на пустое выделение и отклоняет небезопасные схемы", async () => {
    const { editor } = await createHarness("");

    expect(applyNoteEditorLink(editor, "javascript:alert(1)")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(serializeNoteMarkdown(editor)).toBe("");

    expect(applyNoteEditorLink(editor, "https://example.com/docs")).toEqual({
      ok: true,
      href: "https://example.com/docs",
    });
    expect(serializeNoteMarkdown(editor)).toBe("<https://example.com/docs>\n");
    expect(currentLinkHref(editor)).toBe("https://example.com/docs");
  });

  it("вставляет изображение только с разрешённым адресом", async () => {
    const { editor } = await createHarness("");

    expect(insertNoteEditorImage(editor, "javascript:alert(1)", "Схема")).toBe(false);
    expect(serializeNoteMarkdown(editor)).toBe("");

    expect(insertNoteEditorImage(editor, "attachment://img-1", "Схема")).toBe(true);
    expect(serializeNoteMarkdown(editor)).toContain("![Схема](attachment://img-1)");
  });

  it("не включает редактирование для readOnly-документа", async () => {
    const { root } = await createHarness("Только чтение", true);
    const content = root.querySelector<HTMLElement>(".kne-content");

    expect(content).not.toBeNull();
    expect(content).toHaveAttribute("contenteditable", "false");
    expect(content).toHaveAttribute("aria-readonly", "true");
  });
});
