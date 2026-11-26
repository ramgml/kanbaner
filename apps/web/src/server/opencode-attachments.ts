import {
  attachmentKind,
  attachmentMime,
  attachmentValidationError,
  isRecord,
  OpenCodeGatewayError,
  sanitizeAttachmentName,
  selectionValidationError,
  type AttachmentMetadata,
  type OpenCodePromptAttachment,
} from "@kanbaner/opencode";

function invalid(message: string): never {
  throw new OpenCodeGatewayError("VALIDATION_ERROR", message);
}

function decodeBase64(name: string, value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return invalid(`Файл ${name} содержит некорректный Base64`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return invalid(`Файл ${name} содержит некорректный Base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    return invalid(`Файл ${name} содержит некорректный Base64`);
  }
  return bytes;
}

function hasBytes(bytes: Buffer, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function validImage(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png")
    return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === "image/jpeg") return hasBytes(bytes, [0xff, 0xd8, 0xff]);
  if (mime === "image/gif") {
    const header = bytes.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (mime === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

function validateContent(
  bytes: Buffer,
  mime: string,
  kind: "text" | "image" | "pdf",
  name: string,
): void {
  if (kind === "text") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalid(`Файл ${name} не является UTF-8 текстом`);
    }
    return;
  }
  if (kind === "pdf") {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      invalid(`Файл ${name} не содержит корректную PDF-сигнатуру`);
    }
    return;
  }
  if (!validImage(bytes, mime)) invalid(`Содержимое ${name} не соответствует формату ${mime}`);
}

export function parsePromptAttachments(value: unknown): readonly OpenCodePromptAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("Вложения должны быть массивом");
  const decoded: Array<{ file: AttachmentMetadata; bytes: Buffer; base64: string }> = [];

  for (const item of value) {
    if (!isRecord(item)) invalid("Некорректное вложение");
    const keys = Object.keys(item);
    if (
      keys.length !== 3 ||
      keys.some((key) => key !== "name" && key !== "mime" && key !== "base64")
    ) {
      invalid("Вложение должно содержать только name, mime и base64");
    }
    const rawName = typeof item.name === "string" ? item.name : "";
    if (rawName.includes("/") || rawName.includes("\\")) {
      invalid("Имя файла не должно содержать путь");
    }
    const name = sanitizeAttachmentName(rawName);
    if (name.length === 0) invalid("Имя файла не должно быть пустым");
    const mime = typeof item.mime === "string" ? item.mime : "";
    const base64 = item.base64;
    const bytes = decodeBase64(name, base64);
    const metadata = { name, mime, size: bytes.length };
    const error = attachmentValidationError(metadata);
    if (error !== null) invalid(error);
    decoded.push({ file: metadata, bytes, base64: base64 as string });
  }

  const selectionError = selectionValidationError(decoded.map((item) => item.file));
  if (selectionError !== null) invalid(selectionError);

  return decoded.map(({ file, bytes, base64 }) => {
    const kind = attachmentKind(file.name, file.mime);
    if (kind === null) invalid(`Тип файла ${file.name} не поддерживается`);
    const mime = attachmentMime(file.name, file.mime, kind);
    validateContent(bytes, mime, kind, file.name);
    return { name: file.name, dataUri: `data:${mime};base64,${base64}` };
  });
}
