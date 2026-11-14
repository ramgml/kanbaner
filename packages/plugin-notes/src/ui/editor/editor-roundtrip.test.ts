import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";

import { extractAttachmentIds } from "../../markdown-attachments.ts";
import {
  markdownToEditorBlocks,
  prepareMarkdownForBlockNote,
  serializeBlockNoteMarkdown,
} from "./blocknote-markdown.ts";
import { noteEditorSchema } from "./note-editor-schema.tsx";

interface InspectableBlock {
  readonly type: string;
  readonly props?: Record<string, unknown>;
  readonly content?: readonly { readonly type: string; readonly props?: Record<string, unknown> }[];
  readonly children?: readonly InspectableBlock[];
}

function createEditor() {
  return BlockNoteEditor.create({ schema: noteEditorSchema });
}

function roundtrip(markdown: string): string {
  const editor = createEditor();
  return serializeBlockNoteMarkdown(
    editor.blocksToMarkdownLossy(markdownToEditorBlocks(editor, markdown)),
  );
}

function blocksOf(markdown: string): readonly InspectableBlock[] {
  const editor = createEditor();
  return markdownToEditorBlocks(editor, markdown) as unknown as readonly InspectableBlock[];
}

const ROUNDTRIP_FIXTURES: readonly (readonly [name: string, input: string, expected: string[]])[] =
  [
    [
      "заголовок и inline-разметка",
      "## Заголовок\n\nТекст **жирный** и *курсив*, ~~зачёркнутый~~ и `код`.",
      ["## Заголовок", "**жирный**", "*курсив*", "~~зачёркнутый~~", "`код`"],
    ],
    ["маркированный список", "- один\n- два", ["* один", "* два"]],
    ["нумерованный список", "1. первый\n2. второй", ["1. первый", "2. второй"]],
    [
      "цитата и блок кода",
      "> Цитата\n\n```ts\nconst x = 1;\n```",
      ["> Цитата", "```ts", "const x = 1;"],
    ],
    ["task list GFM", "- [x] Готово\n- [ ] Сделать", ["* [x] Готово", "* [ ] Сделать"]],
    ["таблица GFM", "| A | B |\n| --- | --- |\n| 1 | 2 |", ["| A", "| B", "| 1", "| 2"]],
    [
      "ссылка и изображение",
      "[Ссылка](https://example.com) и ![Схема](attachment://img-1)",
      ["[Ссылка](https://example.com)", "![Схема](attachment://img-1)"],
    ],
    [
      "вложенный список",
      "- Родитель\n  - Потомок\n  - Второй потомок",
      ["* Родитель", "  * Потомок", "  * Второй потомок"],
    ],
    ["разделитель", "До\n\n---\n\nПосле", ["До", "***", "После"]],
    [
      "inline image в абзаце",
      "До ![Схема](attachment://img-1) после",
      ["До ![Схема](attachment://img-1) после"],
    ],
    [
      "inline image в элементе списка",
      "- item ![Схема](attachment://img-1) tail",
      ["* item ![Схема](attachment://img-1) tail"],
    ],
    [
      "image в цитате",
      "> Цитата ![Схема](attachment://img-1) хвост",
      ["> Цитата ![Схема](attachment://img-1) хвост"],
    ],
    [
      "image в заголовке",
      "# Заголовок ![Схема](attachment://img-1)",
      ["# Заголовок ![Схема](attachment://img-1)"],
    ],
    [
      "image в ячейке таблицы",
      "| A | B |\n| --- | --- |\n| ![Схема](attachment://img-1) | 2 |",
      ["![Схема](attachment://img-1)", "| 2"],
    ],
  ];

describe("prepareMarkdownForBlockNote", () => {
  it("не меняет документ без изображений и raw HTML", () => {
    const markdown = "## Заголовок\n\nТекст со [ссылкой](https://example.com) и `![код](x)`.";
    expect(prepareMarkdownForBlockNote(markdown)).toBe(markdown);
  });

  it("разрешает imageReference через definition и удаляет definition", () => {
    expect(prepareMarkdownForBlockNote("![Схема][s]\n\n[s]: attachment://img-1")).toBe(
      "![Схема](attachment://img-1)\n\n",
    );
  });

  it("сохраняет definition, если на него ссылается обычная ссылка", () => {
    const prepared = prepareMarkdownForBlockNote(
      "![Схема][s] и [документ][s]\n\n[s]: attachment://img-1",
    );
    expect(prepared).toContain("![Схема](attachment://img-1)");
    expect(prepared).toContain("[s]: attachment://img-1");
  });

  it("превращает raw HTML в литеральный код без исполнения", () => {
    const prepared = prepareMarkdownForBlockNote("<script>window.__noteXss = true</script>");
    expect(prepared).toContain("`<script>window.__noteXss = true</script>`");
    expect(prepared).not.toMatch(/^<script>/u);
  });

  it("идемпотентен после первой нормализации", () => {
    const cases = [
      "До ![Схема](attachment://img-1) после",
      "[![Схема](attachment://img-1)](https://example.com)",
      "![Схема][s]\n\n[s]: attachment://img-1",
      "<script>alert(1)</script>",
    ];

    for (const markdown of cases) {
      const prepared = prepareMarkdownForBlockNote(markdown);
      expect(prepareMarkdownForBlockNote(prepared)).toBe(prepared);
    }
  });
});

describe("roundtrip Markdown через BlockNote", () => {
  it.each(ROUNDTRIP_FIXTURES)("сохраняет %s", (_name, input, expected) => {
    const output = roundtrip(input);
    for (const fragment of expected) expect(output).toContain(fragment);
  });

  it("сохраняет image, обёрнутый в ссылку, без обрыва Markdown", () => {
    const markdown = "[![Схема](attachment://a)](https://example.com)";
    const blocks = blocksOf(markdown);
    const content = blocks[0]?.content ?? [];

    expect(blocks[0]?.type).toBe("paragraph");
    expect(content[0]?.type).toBe("linkedImage");
    expect(content[0]?.props).toMatchObject({
      url: "attachment://a",
      name: "Схема",
      href: "https://example.com",
    });
    expect(roundtrip(markdown)).toBe(markdown);
  });

  it("сохраняет текст и image внутри ссылки, включая attachment usage", () => {
    const markdown = "[до ![Схема][s] после](https://example.com)\n\n[s]: attachment://a";
    const output = roundtrip(markdown);
    const blocks = blocksOf(output);
    const content = blocks[0]?.content ?? [];

    expect(output).toContain("![Схема](attachment://a)");
    expect(output).toContain("https://example.com");
    expect(content.some((item) => item.type === "linkedImage")).toBe(true);
    expect(extractAttachmentIds(output)).toEqual(["a"]);
    expect(roundtrip(output)).toBe(output);
  });

  it("не обрезает destination с пробелами, скобками и control-символами", () => {
    const standalone = "![x](<https://example.com/a b(1).png>)";
    const first = roundtrip(standalone);
    expect(first).toContain("https://example.com/a%20b%281%29.png");
    expect(blocksOf(first)[0]?.props).toMatchObject({
      url: "https://example.com/a%20b%281%29.png",
    });
    expect(roundtrip(first)).toBe(first);

    const inline = "Текст ![x](<https://example.com/a b.png>) хвост";
    const inlineOutput = roundtrip(inline);
    expect(inlineOutput).toContain("![x](https://example.com/a%20b.png)");
    expect(roundtrip(inlineOutput)).toBe(inlineOutput);

    const linked = "[![x](<https://example.com/a b.png>)](<https://example.com/p q>)";
    const linkedOutput = roundtrip(linked);
    const linkedContent = blocksOf(linkedOutput)[0]?.content ?? [];
    expect(linkedOutput).toContain("a%20b.png");
    expect(linkedOutput).toContain("p%20q");
    expect(linkedContent[0]?.props).toMatchObject({
      url: "https://example.com/a%20b.png",
      href: "https://example.com/p%20q",
    });
    expect(roundtrip(linkedOutput)).toBe(linkedOutput);
  });

  it("сохраняет image внутри strong с парными маркерами", () => {
    const markdown = "**До ![Схема](attachment://a) после**";
    const blocks = blocksOf(markdown);
    const content = blocks[0]?.content ?? [];

    expect(blocks[0]?.type).toBe("paragraph");
    expect(content.map((item) => item.type)).toEqual(["text", "inlineImage", "text"]);
    expect((content[0] as { styles?: Record<string, unknown> }).styles).toMatchObject({
      bold: true,
    });

    const output = roundtrip(markdown);
    expect(output.match(/\*\*/gu)).toHaveLength(4);
    expect(output).toContain("![Схема](attachment://a)");
    expect(roundtrip(output)).toBe(output);
  });

  it("сохраняет image внутри emphasis с парными маркерами", () => {
    const markdown = "*До ![Схема](attachment://a) после*";
    const output = roundtrip(markdown);

    expect(output.match(/(?<!\*)\*(?!\*)/gu)?.length).toBe(4);
    expect(output).toContain("![Схема](attachment://a)");
    expect(roundtrip(output)).toBe(output);
  });

  it("разрешает reference image в image-блок с фактическим URL", () => {
    const markdown = "![Схема][s]\n\n[s]: attachment://img-1";
    const blocks = blocksOf(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("image");
    expect(blocks[0]?.props).toMatchObject({
      url: "attachment://img-1",
      name: "Схема",
    });
    expect(roundtrip(markdown)).toBe("![Схема](attachment://img-1)");
  });

  it("превращает inline reference image во inline image с фактическим URL", () => {
    const markdown = "Текст ![Схема][s] хвост\n\n[s]: attachment://img-1";
    const blocks = blocksOf(markdown);
    const content = blocks[0]?.content ?? [];

    expect(content.map((item) => item.type)).toEqual(["text", "inlineImage", "text"]);
    expect(content[1]?.props).toMatchObject({ url: "attachment://img-1" });
    expect(roundtrip(markdown)).toContain("![Схема](attachment://img-1)");
    expect(roundtrip(markdown)).not.toContain("[s]:");
  });

  it("сохраняет raw HTML литеральным текстом", () => {
    const markdown = "<script>window.__noteXss = true</script>\n\nБезопасный текст";
    const output = roundtrip(markdown);

    expect(output).toContain("`<script>window.__noteXss = true</script>`");
    expect(output).toContain("Безопасный текст");
    expect(roundtrip(output)).toBe(output);
  });

  it("нормализует alt с квадратной скобкой и переживает повторный разбор", () => {
    const markdown = "![diagram\\]v2.png](attachment://a)";
    const first = roundtrip(markdown);
    const reparsed = blocksOf(first);

    expect(first).toContain("diagram v2.png");
    expect(first).not.toContain("\\]");
    expect(reparsed[0]?.type).toBe("image");
    expect(reparsed[0]?.props).toMatchObject({ url: "attachment://a" });
    expect(roundtrip(first)).toBe(first);
  });

  it("нормализует fail-безопасный alt при импорте Markdown", () => {
    const markdown = "![diagram\\]v2\\\\final\nimage.png](attachment://a)";
    const first = roundtrip(markdown);
    const reparsed = blocksOf(first);

    expect(first).not.toContain("\\]");
    expect(first).not.toContain("\\\\");
    expect(reparsed[0]?.type).toBe("image");
    expect(reparsed[0]?.props).toMatchObject({ url: "attachment://a" });
    expect(roundtrip(first)).toBe(first);
  });

  it("идемпотентен после первой нормализации", () => {
    const first = roundtrip(
      "## Заголовок\n\n- [x] Готово\n- [ ] Сделать\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(roundtrip(first)).toBe(first);
  });

  it("сохраняет пустой документ пустым", () => {
    expect(roundtrip("")).toBe("");
  });

  it("сохраняет data URL загруженного изображения до canonical-преобразования", () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    expect(roundtrip(`![Схема](${dataUrl})`)).toContain(`![Схема](${dataUrl})`);
    expect(roundtrip(`Текст ![Схема](${dataUrl}) хвост`)).toContain(`![Схема](${dataUrl})`);
  });
});
