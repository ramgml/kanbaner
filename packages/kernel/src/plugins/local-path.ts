import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export type LocalPathFailure =
  | "empty"
  | "remote"
  | "absolute"
  | "escape"
  | "invalid"
  | "not_found"
  | "realpath_failed"
  | "symlink_escape";

export type LocalPathResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: LocalPathFailure };

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * Разрешает локальный путь внутри каталога плагина.
 *
 * Проверка выполняется в два этапа: лексическая (абсолютные пути, URL-схемы,
 * `..`-выходы, обратные слэши) и каноническая через `realpath`. Второй этап
 * запрещает symlink/junction-выход за пределы каталога плагина. Возвращается
 * канонический путь, который runtime использует для `stat` и dynamic import.
 */
export async function resolveLocalPluginPath(
  directory: string,
  value: string,
): Promise<LocalPathResolution> {
  if (value.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (value.includes("\0") || value.includes("\\")) {
    return { ok: false, reason: "invalid" };
  }

  if (SCHEME_PATTERN.test(value)) {
    return { ok: false, reason: "remote" };
  }

  if (isAbsolute(value) || win32.isAbsolute(value)) {
    return { ok: false, reason: "absolute" };
  }

  const lexicalCandidate = resolve(directory, value);
  const lexicalRelative = relative(directory, lexicalCandidate);

  if (
    lexicalRelative === "" ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    return { ok: false, reason: "escape" };
  }

  let canonicalDirectory: string;

  try {
    canonicalDirectory = await realpath(directory);
  } catch {
    return { ok: false, reason: "realpath_failed" };
  }

  let canonicalCandidate: string;

  try {
    canonicalCandidate = await realpath(lexicalCandidate);
  } catch (error) {
    return {
      ok: false,
      reason: isNotFound(error) ? "not_found" : "realpath_failed",
    };
  }

  const canonicalRelative = relative(canonicalDirectory, canonicalCandidate);

  if (
    canonicalRelative === "" ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    return { ok: false, reason: "symlink_escape" };
  }

  return { ok: true, path: canonicalCandidate };
}
