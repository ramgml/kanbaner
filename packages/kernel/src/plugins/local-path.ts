import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export type LocalPathFailure = "empty" | "remote" | "absolute" | "escape" | "invalid";

export type LocalPathResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: LocalPathFailure };

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Разрешает локальный путь внутри каталога плагина.
 *
 * Абсолютные пути, URL-схемы, `..`-выходы и обратные слэши отклоняются,
 * чтобы манифест нельзя было использовать для загрузки удалённого кода и
 * чтобы путь одинаково трактовался на Linux и Windows.
 */
export function resolveLocalPluginPath(directory: string, value: string): LocalPathResolution {
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

  const resolved = resolve(directory, value);
  const relativePath = relative(directory, resolved);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return { ok: false, reason: "escape" };
  }

  return { ok: true, path: resolved };
}
