// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_LIMITS,
  attachmentKind,
  attachmentMime,
  attachmentValidationError,
  formatAttachmentSize,
  sanitizeAttachmentName,
  selectionValidationError,
} from "./attachments.ts";

describe("OpenCode attachments", () => {
  it("определяет text, image и pdf по MIME или расширению", () => {
    expect(attachmentKind("notes.txt", "text/plain")).toBe("text");
    expect(attachmentKind("page.md", "")).toBe("text");
    expect(attachmentKind("data.bin", "application/octet-stream")).toBeNull();
    expect(attachmentKind("photo.png", "image/png")).toBe("image");
    expect(attachmentKind("photo.webp", "")).toBe("image");
    expect(attachmentKind("doc.pdf", "")).toBe("pdf");
    expect(attachmentKind("tool.exe", "application/x-msdownload")).toBeNull();
    expect(attachmentMime("notes.unknown", "", "text")).toBe("text/plain");
    expect(attachmentMime("photo.png", "", "image")).toBe("image/png");
    expect(attachmentMime("doc.pdf", "application/octet-stream", "pdf")).toBe("application/pdf");
  });

  it("нормализует имя без пути и управляющих символов", () => {
    expect(sanitizeAttachmentName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(sanitizeAttachmentName("../secret.txt")).toBe("secret.txt");
    expect(sanitizeAttachmentName("bad\u0000name.txt")).toBe("badname.txt");
    expect(sanitizeAttachmentName("   ")).toBe("");
  });

  it("проверяет размеры text, image и pdf", () => {
    expect(attachmentValidationError({ name: "a.txt", mime: "text/plain", size: 1 })).toBeNull();
    expect(
      attachmentValidationError({
        name: "a.txt",
        mime: "text/plain",
        size: ATTACHMENT_LIMITS.maxTextBytes + 1,
      }),
    ).toContain("1 MiB");
    expect(attachmentValidationError({ name: "a.png", mime: "image/png", size: 1 })).toBeNull();
    expect(
      attachmentValidationError({
        name: "a.pdf",
        mime: "application/pdf",
        size: ATTACHMENT_LIMITS.maxMediaBytes + 1,
      }),
    ).toContain("5 MiB");
    expect(attachmentValidationError({ name: "a.exe", mime: "", size: 1 })).toContain(
      "не поддерживается",
    );
    expect(attachmentValidationError({ name: "a.txt", mime: "text/plain", size: 0 })).toContain(
      "пуст",
    );
  });

  it("ограничивает количество и суммарный размер выбранных файлов", () => {
    const file = { name: "a.txt", mime: "text/plain", size: 1 };
    expect(selectionValidationError([file])).toBeNull();
    expect(
      selectionValidationError(
        Array.from({ length: 6 }, (_value, index) => ({
          ...file,
          name: `file-${index}.txt`,
        })),
      ),
    ).toContain("не больше 5 файлов");
    expect(
      selectionValidationError([
        { name: "a.png", mime: "image/png", size: ATTACHMENT_LIMITS.maxMediaBytes },
        { name: "b.png", mime: "image/png", size: ATTACHMENT_LIMITS.maxMediaBytes },
      ]),
    ).toContain("8 MiB");
    expect(formatAttachmentSize(999)).toBe("999 B");
    expect(formatAttachmentSize(2048)).toBe("2 KiB");
    expect(formatAttachmentSize(2_097_152)).toBe("2.0 MiB");
  });
});
