"use client";

interface SavedInputSelection {
  readonly element: HTMLInputElement | HTMLTextAreaElement;
  readonly start: number | null;
  readonly end: number | null;
  readonly direction: "forward" | "backward" | "none" | null;
}

interface SavedSelection {
  readonly active: HTMLElement | null;
  readonly input: SavedInputSelection | null;
  readonly ranges: readonly Range[];
}

function activeElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function saveSelection(): SavedSelection {
  const active = activeElement();
  const input =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? {
          element: active,
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection,
        }
      : null;
  const ranges: Range[] = [];
  try {
    const selection = document.getSelection();
    if (selection !== null) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        ranges.push(selection.getRangeAt(index).cloneRange());
      }
    }
  } catch {
    // Selection API недоступен или уже потерян; фокус всё равно восстанавливаем.
  }
  return { active, input, ranges };
}

function focusWithoutScroll(element: HTMLElement | null): void {
  if (element === null || !element.isConnected) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    // Некоторые окружения не поддерживают options у focus().
    try {
      element.focus();
    } catch {
      // Фокус восстановить не удалось; копирование уже завершено.
    }
  }
}

function restoreSelection(saved: SavedSelection): void {
  focusWithoutScroll(saved.active);
  if (saved.input !== null && saved.input.element.isConnected) {
    try {
      saved.input.element.setSelectionRange(
        saved.input.start,
        saved.input.end,
        saved.input.direction ?? undefined,
      );
    } catch {
      // Input мог стать readOnly/disabled; диапазон не критичен.
    }
  }
  if (saved.ranges.length === 0) return;
  try {
    const selection = document.getSelection();
    if (selection === null) return;
    selection.removeAllRanges();
    for (const range of saved.ranges) selection.addRange(range);
  } catch {
    // Диапазоны относятся к удалённым узлам; фокус уже восстановлен.
  }
}

/**
 * Синхронный legacy fallback без Clipboard API. Временная readonly textarea
 * монтируется offscreen, а activeElement и Selection восстанавливаются в
 * finally при любом исходе.
 */
export function legacyCopyText(text: string): boolean {
  if (text.length === 0 || typeof document === "undefined" || document.body === null) return false;
  if (typeof document.execCommand !== "function") return false;

  const saved = saveSelection();
  const textarea = document.createElement("textarea");

  try {
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    textarea.setAttribute("tabindex", "-1");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
    restoreSelection(saved);
  }
}

/**
 * Копирует точный текст. Сначала Clipboard API; при отсутствии, отказе или
 * throw используется legacy `execCommand`. Empty text не копируется, а ошибки
 * никогда не покидают функцию rejected Promise-ом.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text.length === 0) return false;

  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Отказ разрешения или недоступный Clipboard API: пробуем legacy путь.
  }

  return legacyCopyText(text);
}
