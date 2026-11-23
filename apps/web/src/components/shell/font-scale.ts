export const FONT_SCALE_STORAGE_KEY = "kanbaner.ui.fontScale";
export const FONT_SCALE_DEFAULT = 100;
export const FONT_SCALE_OPTIONS = [90, 100, 110, 125] as const;

export type FontScale = (typeof FONT_SCALE_OPTIONS)[number];

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Приводит значение к allowlist без numeric coercion: принимаются только точное
 * число из списка или его каноническая строка (`90`, а не `090`, ` 90 `, `9e1`).
 * Всё остальное означает 100% — так же строго, как inline-bootstrap.
 */
export function normalizeFontScale(raw: unknown): FontScale {
  if (typeof raw !== "number" && typeof raw !== "string") return FONT_SCALE_DEFAULT;
  const option = FONT_SCALE_OPTIONS.find(
    (candidate) => candidate === raw || String(candidate) === raw,
  );
  return option ?? FONT_SCALE_DEFAULT;
}

export function readStoredFontScale(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): FontScale {
  try {
    const raw = storage?.getItem(FONT_SCALE_STORAGE_KEY);
    if (raw === null || raw === undefined) return FONT_SCALE_DEFAULT;
    return normalizeFontScale(raw);
  } catch {
    return FONT_SCALE_DEFAULT;
  }
}

export function applyFontScale(scale: FontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = `${scale}%`;
}

export function persistFontScale(scale: FontScale, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(FONT_SCALE_STORAGE_KEY, String(scale));
  } catch {
    // Приватный режим и квоты не отменяют применение размера в текущей сессии.
  }
}

/**
 * Синхронный bootstrap до первой отрисовки: читает только ключ размера шрифта,
 * проверяет allowlist и ставит root font-size, чтобы Tailwind rem-размеры
 * масштабировались без вспышки прежнего значения.
 */
export const FONT_SCALE_BOOTSTRAP_SCRIPT = `(function(){var v="100";try{var s=localStorage.getItem("kanbaner.ui.fontScale");if(s==="90"||s==="100"||s==="110"||s==="125")v=s}catch(e){}document.documentElement.style.fontSize=v+"%"})()`;
