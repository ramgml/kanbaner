import { describe, expect, it } from "vitest";

import { attachmentUrl } from "../markdown-attachments.ts";
import { AttachmentUrlCache } from "./attachment-cache.ts";

describe("AttachmentUrlCache", () => {
  it("заменяет URL только в image-узлах и восстанавливает canonical attachment", () => {
    const cache = new AttachmentUrlCache();
    const dataUrl = cache.set("image-1", "image/png", "aGVsbG8=");
    const canonical = [
      "![Схема](attachment://image-1)",
      "",
      "`attachment://image-1` в коде не меняется",
      "",
      "```md",
      "![Код](attachment://image-1)",
      "```",
    ].join("\n");

    const editor = cache.toEditor(canonical);
    expect(editor).toContain(`![Схема](${dataUrl})`);
    expect(editor).toContain("`attachment://image-1` в коде");
    expect(editor).toContain("![Код](attachment://image-1)");
    expect(cache.toCanonical(editor)).toBe(canonical);
    expect(attachmentUrl("image-1")).toBe("attachment://image-1");
  });
});
