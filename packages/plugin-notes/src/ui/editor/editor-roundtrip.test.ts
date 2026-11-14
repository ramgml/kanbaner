import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";

import { prepareMarkdownForBlockNote, serializeBlockNoteMarkdown } from "./blocknote-markdown.ts";

function createEditor() {
  return BlockNoteEditor.create();
}

function roundtrip(markdown: string): string {
  const editor = createEditor();
  return serializeBlockNoteMarkdown(
    editor.blocksToMarkdownLossy(
      editor.tryParseMarkdownToBlocks(prepareMarkdownForBlockNote(markdown)),
    ),
  );
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
      ["До", "![Схема](attachment://img-1)", "после"],
    ],
    [
      "inline image в элементе списка",
      "- item ![Схема](attachment://img-1) tail",
      ["item", "![Схема](attachment://img-1)", "tail"],
    ],
    [
      "image в цитате",
      "> Цитата ![Схема](attachment://img-1) хвост",
      ["Цитата", "![Схема](attachment://img-1)", "хвост"],
    ],
    [
      "image в заголовке",
      "# Заголовок ![Схема](attachment://img-1)",
      ["# Заголовок", "![Схема](attachment://img-1)"],
    ],
    [
      "image в ячейке таблицы",
      "| A | B |\n| --- | --- |\n| ![Схема](attachment://img-1) | 2 |",
      ["| A", "| B", "| 2", "![Схема](attachment://img-1)"],
    ],
    [
      "reference image рядом с текстом",
      "Текст ![Схема][s] хвост\n\n[s]: attachment://img-1",
      ["Текст", "![Схема][s]", "хвост", "[s]: attachment://img-1"],
    ],
  ];

describe("prepareMarkdownForBlockNote", () => {
  it("не меняет документ без изображений", () => {
    const markdown = "## Заголовок\n\nТекст со [ссылкой](https://example.com) и `![код](x)`.";
    expect(prepareMarkdownForBlockNote(markdown)).toBe(markdown);
  });

  it("выносит inline image из абзаца, списка, цитаты и заголовка", () => {
    expect(prepareMarkdownForBlockNote("До ![Схема](attachment://img-1) после")).toBe(
      "До\n\n![Схема](attachment://img-1)\n\nпосле",
    );
    expect(prepareMarkdownForBlockNote("- item ![Схема](attachment://img-1) tail")).toBe(
      "- item\n\n  ![Схема](attachment://img-1)\n\n  tail",
    );
    expect(prepareMarkdownForBlockNote("> Цитата ![Схема](attachment://img-1) хвост")).toBe(
      "> Цитата  хвост\n\n![Схема](attachment://img-1)",
    );
    expect(prepareMarkdownForBlockNote("# Заголовок ![Схема](attachment://img-1)")).toBe(
      "# Заголовок \n\n![Схема](attachment://img-1)",
    );
  });

  it("выносит image из ячейки таблицы, сохраняя саму таблицу", () => {
    const markdown = "| A | B |\n| --- | --- |\n| ![Схема](attachment://img-1) | 2 |";

    expect(prepareMarkdownForBlockNote(markdown)).toBe(
      "| A | B |\n| --- | --- |\n|  | 2 |\n\n![Схема](attachment://img-1)",
    );
  });

  it("идемпотентен после первой нормализации", () => {
    const cases = [
      "До ![Схема](attachment://img-1) после",
      "- item ![Схема](attachment://img-1) tail",
      "> Цитата ![Схема](attachment://img-1) хвост",
      "| A | B |\n| --- | --- |\n| ![Схема](attachment://img-1) | 2 |",
      "Текст ![Схема][s] хвост\n\n[s]: attachment://img-1",
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

  it("вставляет изображение отдельным блоком", () => {
    const editor = createEditor();
    const reference = editor.document.at(-1);
    if (reference === undefined) throw new Error("Пустой редактор не содержит reference block");

    editor.insertBlocks(
      [{ type: "image", props: { url: "attachment://img-1", name: "Схема" } }],
      reference,
      "after",
    );

    expect(editor.blocksToMarkdownLossy()).toContain("![Схема](attachment://img-1)");
  });
});
