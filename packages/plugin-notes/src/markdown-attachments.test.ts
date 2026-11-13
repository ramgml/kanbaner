// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  extractAttachmentIds,
  markdownImageUrls,
  replaceMarkdownImageUrls,
} from "./markdown-attachments.ts";

const SOURCE = [
  "Прямая ![inline](attachment://inline-1)",
  "",
  "Ссылочная ![ref][logo] и сокращённая ![shortcut].",
  "",
  "`![inline-code](attachment://code-inline)`",
  "",
  "```",
  "![fenced](attachment://code-fenced)",
  "[logo]: attachment://code-definition",
  "```",
  "",
  '[logo]: attachment://ref-1 "Логотип"',
  "[shortcut]: https://example.com/shortcut.png",
].join("\n");

describe("markdown-attachments", () => {
  it("распознаёт direct, reference и shortcut images, игнорируя код", () => {
    expect(markdownImageUrls(SOURCE)).toEqual([
      "attachment://inline-1",
      "attachment://ref-1",
      "https://example.com/shortcut.png",
    ]);
    expect(extractAttachmentIds(SOURCE)).toEqual(["inline-1", "ref-1"]);
  });

  it("заменяет URL в definition, сохраняя direct images и код", () => {
    const replaced = replaceMarkdownImageUrls(SOURCE, (url) =>
      url.startsWith("attachment://") ? "data:image/png;base64,AAAA" : url,
    );

    expect(replaced).toContain("![inline](data:image/png;base64,AAAA)");
    expect(replaced).toContain('[logo]: data:image/png;base64,AAAA "Логотип"');
    expect(replaced).not.toContain('[logo]: attachment://ref-1 "Логотип"');
    expect(replaced).toContain("![ref][logo]");
    expect(replaced).toContain("![shortcut]");
    expect(replaced).toContain("`![inline-code](attachment://code-inline)`");
    expect(replaced).toContain("![fenced](attachment://code-fenced)");
    expect(replaced).toContain("[logo]: attachment://code-definition");
  });

  it("заменяет общий definition один раз для нескольких ссылок", () => {
    const source = "![a][x] и ![b][x]\n\n[x]: attachment://shared\n";

    expect(replaceMarkdownImageUrls(source, () => "data:image/png;base64,AAAA")).toBe(
      "![a][x] и ![b][x]\n\n[x]: data:image/png;base64,AAAA\n",
    );
  });

  it("не трогает неразрешённую ссылку и сохраняет direct image без изменений", () => {
    const source = "![missing][nope] и ![direct](attachment://direct)";

    expect(markdownImageUrls(source)).toEqual(["attachment://direct"]);
    expect(replaceMarkdownImageUrls(source, (url) => url)).toBe(source);
  });
});
