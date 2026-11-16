"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/** Стандартная ширина дерева; совпадает с прежним `lg:w-72` (18rem). */
export const NOTE_SIDEBAR_DEFAULT_WIDTH = 288;
/** Ниже этой ширины дерево теряет читаемые названия и действия строки. */
export const NOTE_SIDEBAR_MIN_WIDTH = 240;
/** Верхняя граница, чтобы sidebar не превращался во вторую колонку редактора. */
export const NOTE_SIDEBAR_MAX_WIDTH = 560;
/** Минимальная ширина, которая всегда остаётся главному редактору. */
export const NOTE_SIDEBAR_MIN_EDITOR_WIDTH = 320;
export const NOTE_SIDEBAR_STEP = 16;
export const NOTE_SIDEBAR_LARGE_STEP = 48;
export const NOTE_SIDEBAR_STORAGE_KEY = "kanbaner.notes.sidebarWidth";

/**
 * Ограничивает ширину дерева разумным диапазоном.
 *
 * `maxWidth` приходит из viewport: на узком desktop он меньше
 * `NOTE_SIDEBAR_MAX_WIDTH`, но никогда не опускается ниже минимума.
 */
export function clampSidebarWidth(
  width: number,
  maxWidth: number = NOTE_SIDEBAR_MAX_WIDTH,
): number {
  const boundedMax = Math.max(
    NOTE_SIDEBAR_MIN_WIDTH,
    Math.min(NOTE_SIDEBAR_MAX_WIDTH, Math.round(maxWidth)),
  );
  if (!Number.isFinite(width)) return Math.min(NOTE_SIDEBAR_DEFAULT_WIDTH, boundedMax);
  return Math.min(Math.max(Math.round(width), NOTE_SIDEBAR_MIN_WIDTH), boundedMax);
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Приватный режим или запрет хранилища не должен ронять дерево.
    return null;
  }
}

/** Читает сохранённую ширину; любое повреждённое значение даёт стандарт. */
export function readStoredSidebarWidth(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): number {
  try {
    const raw = storage?.getItem(NOTE_SIDEBAR_STORAGE_KEY);
    if (raw === null || raw === undefined) return NOTE_SIDEBAR_DEFAULT_WIDTH;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clampSidebarWidth(value) : NOTE_SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return NOTE_SIDEBAR_DEFAULT_WIDTH;
  }
}

function persistSidebarWidth(width: number, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(NOTE_SIDEBAR_STORAGE_KEY, String(width));
  } catch {
    // Квоты и приватный режим не должны мешать ресайзу в текущей сессии.
  }
}

/**
 * Максимальная ширина sidebar с учётом контейнера представления.
 *
 * Если layout ещё не измерен (jsdom, первый рендер), используется viewport:
 * ширина дерева не может забрать у редактора его минимальную ширину.
 */
export function sidebarMaxWidthFor(containerWidth: number | null | undefined): number {
  const available =
    containerWidth !== null && containerWidth !== undefined && containerWidth > 0
      ? containerWidth
      : typeof window === "undefined"
        ? 0
        : window.innerWidth;
  if (!(available > 0)) return NOTE_SIDEBAR_MAX_WIDTH;
  return Math.max(
    NOTE_SIDEBAR_MIN_WIDTH,
    Math.min(NOTE_SIDEBAR_MAX_WIDTH, Math.round(available) - NOTE_SIDEBAR_MIN_EDITOR_WIDTH),
  );
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

export interface NoteSidebarResizerProps {
  readonly role: "separator";
  readonly tabIndex: 0;
  readonly "aria-orientation": "vertical";
  readonly "aria-valuemin": number;
  readonly "aria-valuemax": number;
  readonly "aria-valuenow": number;
  readonly "data-note-sidebar-resizer": "true";
  readonly "data-resizing"?: "true";
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
}

export interface NoteSidebarResizer {
  /** Ставится на корневой контейнер представления: по нему считается максимум. */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly dragging: boolean;
  /** CSS-переменная ширины: применяется только к desktop-классу `lg:w-[var(...)]`. */
  readonly asideStyle: CSSProperties;
  readonly separatorProps: NoteSidebarResizerProps;
}

/**
 * Ширина дерева заметок на desktop: drag за правую границу, клавиатура и
 * сохранение между перезагрузками.
 *
 * Мобильный полноэкранный sidebar не участвует: handle скрыт классами
 * `hidden lg:block`, а ширина задаётся только внутри `lg:`-варианта.
 */
export function useNoteSidebarResizer(): NoteSidebarResizer {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Рендерер плагина подключается на клиенте, поэтому ленивое чтение
  // localStorage не создаёт серверный HTML с чужой шириной.
  const [desiredWidth, setDesiredWidth] = useState<number>(() => readStoredSidebarWidth());
  const [maxWidth, setMaxWidth] = useState<number>(NOTE_SIDEBAR_MAX_WIDTH);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const maxWidthRef = useRef(maxWidth);
  const width = clampSidebarWidth(desiredWidth, maxWidth);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    const element = containerRef.current;
    const update = (): void => {
      const next = sidebarMaxWidthFor(element?.clientWidth ?? null);
      maxWidthRef.current = next;
      setMaxWidth((current) => (current === next ? current : next));
    };
    update();
    window.addEventListener("resize", update);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && element !== null) {
      observer = new ResizeObserver(update);
      observer.observe(element);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);

  const applyWidth = useCallback((next: number, persist: boolean) => {
    const clamped = clampSidebarWidth(next, maxWidthRef.current);
    widthRef.current = clamped;
    setDesiredWidth(clamped);
    if (persist) persistSidebarWidth(clamped);
  }, []);

  const resetWidth = useCallback(() => {
    applyWidth(NOTE_SIDEBAR_DEFAULT_WIDTH, true);
  }, [applyWidth]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Только основная кнопка мыши/пера: touch на мобильном не ресайзит,
    // правая кнопка не должна запускать захват.
    if ((event.button ?? 0) !== 0 || event.pointerType === "touch") return;
    event.preventDefault();
    const element = event.currentTarget;
    const pointerId = event.pointerId ?? 0;
    dragRef.current = {
      pointerId,
      startX: Number.isFinite(event.clientX) ? event.clientX : 0,
      startWidth: widthRef.current,
    };
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // jsdom и старые браузеры без Pointer Capture: drag продолжит работать
      // на обычных pointermove внутри handle.
    }
    setDragging(true);
    element.focus({ preventScroll: true });
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== (event.pointerId ?? 0)) return;
      event.preventDefault();
      const clientX = Number.isFinite(event.clientX) ? event.clientX : drag.startX;
      applyWidth(drag.startWidth + clientX - drag.startX, false);
    },
    [applyWidth],
  );

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    setDragging(false);
    if (drag.pointerId === (event.pointerId ?? 0)) {
      try {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      } catch {
        // Захват мог быть уже снят браузером.
      }
    }
    // Записываем один раз за drag, а не на каждый pointermove.
    persistSidebarWidth(widthRef.current);
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? NOTE_SIDEBAR_LARGE_STEP : NOTE_SIDEBAR_STEP;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        applyWidth(widthRef.current + direction * step, true);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        applyWidth(NOTE_SIDEBAR_MIN_WIDTH, true);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        applyWidth(maxWidthRef.current, true);
      }
    },
    [applyWidth],
  );

  const onDoubleClick = useCallback(() => {
    resetWidth();
  }, [resetWidth]);

  const separatorProps: NoteSidebarResizerProps = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-valuemin": NOTE_SIDEBAR_MIN_WIDTH,
    "aria-valuemax": maxWidth,
    "aria-valuenow": width,
    "data-note-sidebar-resizer": "true",
    ...(dragging ? { "data-resizing": "true" as const } : {}),
    onPointerDown,
    onPointerMove,
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
    onLostPointerCapture: finishDrag,
    onKeyDown,
    onDoubleClick,
  };

  return {
    containerRef,
    width,
    minWidth: NOTE_SIDEBAR_MIN_WIDTH,
    maxWidth,
    dragging,
    asideStyle: { "--note-sidebar-width": `${width}px` } as CSSProperties,
    separatorProps,
  };
}
