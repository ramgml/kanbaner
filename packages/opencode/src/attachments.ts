export const ATTACHMENT_LIMITS = {
  maxFiles: 5,
  maxTextBytes: 1_048_576,
  maxMediaBytes: 5_242_880,
  maxTotalBytes: 8_388_608,
  maxRequestBytes: 12_000_000,
} as const;

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".css",
  ".html",
  ".xml",
  ".toml",
  ".ini",
  ".log",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".svg",
  ".vue",
  ".svelte",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".scala",
  ".lua",
]);
const TEXT_MIME = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/javascript",
  "application/x-javascript",
  "application/x-sh",
  "image/svg+xml",
]);
const GENERIC_MIME = new Set(["", "application/octet-stream"]);

export type OpenCodeAttachmentKind = "text" | "image" | "pdf";

export interface AttachmentMetadata {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export const ATTACHMENT_ACCEPT = [...Object.keys(IMAGE_MIME), ".pdf", ...TEXT_EXTENSIONS].join(",");

export function sanitizeAttachmentName(value: string): string {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return basename
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 200);
}

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

export function attachmentKind(name: string, mime: string): OpenCodeAttachmentKind | null {
  const normalizedMime = mime.trim().toLowerCase();
  if (normalizedMime === "application/pdf") return "pdf";
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(normalizedMime))
    return "image";
  if (normalizedMime.startsWith("text/") || TEXT_MIME.has(normalizedMime)) return "text";
  if (!GENERIC_MIME.has(normalizedMime)) return null;

  const ext = extension(name);
  if (ext === ".pdf") return "pdf";
  if (ext in IMAGE_MIME) return "image";
  return TEXT_EXTENSIONS.has(ext) ? "text" : null;
}

export function attachmentMime(name: string, mime: string, kind: OpenCodeAttachmentKind): string {
  const normalizedMime = mime.trim().toLowerCase();
  if (!GENERIC_MIME.has(normalizedMime)) return normalizedMime;
  if (kind === "pdf") return "application/pdf";
  if (kind === "image") return IMAGE_MIME[extension(name)] ?? "application/octet-stream";
  return "text/plain";
}

export function attachmentValidationError(file: AttachmentMetadata): string | null {
  const name = sanitizeAttachmentName(file.name);
  if (name.length === 0) return "Имя файла не должно быть пустым";
  if (!Number.isSafeInteger(file.size) || file.size <= 0)
    return `Файл ${name} пуст или имеет неверный размер`;
  const kind = attachmentKind(name, file.mime);
  if (kind === null) return `Тип файла ${name} не поддерживается`;
  const limit = kind === "text" ? ATTACHMENT_LIMITS.maxTextBytes : ATTACHMENT_LIMITS.maxMediaBytes;
  if (file.size > limit) {
    const mib = kind === "text" ? 1 : 5;
    return `Файл ${name} превышает лимит ${mib} MiB`;
  }
  return null;
}

export function selectionValidationError(files: readonly AttachmentMetadata[]): string | null {
  if (files.length > ATTACHMENT_LIMITS.maxFiles) {
    return `Можно прикрепить не больше ${ATTACHMENT_LIMITS.maxFiles} файлов`;
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > ATTACHMENT_LIMITS.maxTotalBytes) return "Общий размер файлов превышает 8 MiB";
  for (const file of files) {
    const error = attachmentValidationError(file);
    if (error !== null) return error;
  }
  return null;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
