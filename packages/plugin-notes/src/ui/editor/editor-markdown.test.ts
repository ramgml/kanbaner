import { describe, expect, it } from "vitest";

import {
  imageUploadErrorMessage,
  isImageFile,
  markdownDocumentsEqual,
  normalizeMarkdownDocument,
  sanitizeImageSource,
  validateLinkHref,
} from "./editor-markdown.ts";

function file(name: string, type: string): File {
  return new File(["binary"], name, { type });
}

describe("normalizeMarkdownDocument", () => {
  it("приводит CRLF к LF и убирает хвостовые переводы строк", () => {
    expect(normalizeMarkdownDocument("Строка\r\n\r\n")).toBe("Строка");
    expect(normalizeMarkdownDocument("Строка\rВторая")).toBe("Строка\nВторая");
    expect(normalizeMarkdownDocument("\n\n")).toBe("");
  });

  it("сравнивает документы без учёта платформенных переводов строк", () => {
    expect(markdownDocumentsEqual("Текст\n\n", "Текст\r\n")).toBe(true);
    expect(markdownDocumentsEqual("Текст\n", "Текст\n\n")).toBe(true);
    expect(markdownDocumentsEqual("Текст", "Другой текст")).toBe(false);
  });
});

describe("validateLinkHref", () => {
  it.each([
    "https://example.com/docs",
    "http://example.com",
    "mailto:user@example.com",
    "tel:+79990000000",
    "/view/notes",
    "notes/kan-037",
    "#anchor",
  ])("разрешает безопасный адрес %s", (href) => {
    expect(validateLinkHref(href)).toEqual({ ok: true, href });
  });

  it("удаляет управляющие символы и обрезает пробелы", () => {
    expect(validateLinkHref("  https://example.com/\u0000\u001fpath  ")).toEqual({
      ok: true,
      href: "https://example.com/path",
    });
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
  ])("отклоняет небезопасную схему %s", (href) => {
    const result = validateLinkHref(href);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toContain("http");
    }
  });

  it("отклоняет пустой адрес", () => {
    expect(validateLinkHref("   ")).toEqual({ ok: false, error: "Введите адрес ссылки." });
  });
});

describe("sanitizeImageSource", () => {
  it.each([
    "attachment://img-1",
    "https://example.com/image.png",
    "http://localhost:3000/image.png",
    "blob:http://localhost/9ff2",
    "images/local.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/jpeg;base64,/9j/4AAQ",
    "data:image/webp;base64,UklGRg==",
  ])("разрешает изображение %s", (source) => {
    expect(sanitizeImageSource(source)).toBe(source);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "file:///tmp/image.png",
    "",
    "   ",
  ])("отклоняет небезопасный источник %s", (source) => {
    expect(sanitizeImageSource(source)).toBeNull();
  });
});

describe("imageUploadErrorMessage", () => {
  it("добавляет понятный префикс к короткой ошибке", () => {
    expect(imageUploadErrorMessage(new Error("Сервер недоступен"))).toBe(
      "Не удалось загрузить изображение: Сервер недоступен",
    );
  });

  it("не раскрывает длинные и нечитаемые ошибки", () => {
    expect(imageUploadErrorMessage(new Error("x".repeat(300)))).toBe(
      "Не удалось загрузить изображение. Попробуйте ещё раз.",
    );
    expect(imageUploadErrorMessage("not an error")).toBe(
      "Не удалось загрузить изображение. Попробуйте ещё раз.",
    );
    expect(imageUploadErrorMessage(new Error("   "))).toBe(
      "Не удалось загрузить изображение. Попробуйте ещё раз.",
    );
  });
});

describe("isImageFile", () => {
  it("распознаёт изображения по MIME-типу", () => {
    expect(isImageFile(file("схема.png", "image/png"))).toBe(true);
    expect(isImageFile(file("фото.jpeg", "image/jpeg"))).toBe(true);
    expect(isImageFile(file("документ.pdf", "application/pdf"))).toBe(false);
    expect(isImageFile(file("заметка.txt", "text/plain"))).toBe(false);
  });
});
