"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export const APP_ASSISTANT_DEFAULT_WIDTH = 384;
export const APP_ASSISTANT_MIN_WIDTH = 320;
export const APP_ASSISTANT_MAX_WIDTH = 640;
/**
 * Ширина, которую панель оставляет остальному shell: левый sidebar (до 288 px
 * по умолчанию) и разумный минимум основного содержимого.
 */
export const APP_ASSISTANT_RESERVED_WIDTH = 640;
export const APP_ASSISTANT_STEP = 16;
export const APP_ASSISTANT_LARGE_STEP = 48;
export const APP_ASSISTANT_STORAGE_KEY = "kanbaner.opencode.panelWidth";
/** Тот же breakpoint, что и Tailwind `md`. */
export const APP_ASSISTANT_DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

/** Ширина панели: целое число в пределах min/max. */
export function clampAssistantPanelWidth(
  width: number,
  maxWidth: number = APP_ASSISTANT_MAX_WIDTH,
): number {
  const boundedMax = Math.max(
    APP_ASSISTANT_MIN_WIDTH,
    Math.min(APP_ASSISTANT_MAX_WIDTH, Math.round(maxWidth)),
  );
  if (!Number.isFinite(width)) return Math.min(APP_ASSISTANT_DEFAULT_WIDTH, boundedMax);
  return Math.min(Math.max(Math.round(width), APP_ASSISTANT_MIN_WIDTH), boundedMax);
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const STORED_WIDTH_PATTERN = /^\d+$/u;

export function readStoredAssistantPanelWidth(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): number {
  try {
    const raw = storage?.getItem(APP_ASSISTANT_STORAGE_KEY);
    if (raw === null || raw === undefined || !STORED_WIDTH_PATTERN.test(raw)) {
      return APP_ASSISTANT_DEFAULT_WIDTH;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return APP_ASSISTANT_DEFAULT_WIDTH;
    return clampAssistantPanelWidth(value);
  } catch {
    return APP_ASSISTANT_DEFAULT_WIDTH;
  }
}

function persistAssistantPanelWidth(width: number, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(APP_ASSISTANT_STORAGE_KEY, String(width));
  } catch {
    // Приватный режим и квоты не мешают resize в текущей сессии.
  }
}

/** Максимум с учётом viewport и места для левого sidebar и основного контента. */
export function assistantMaxWidthFor(viewportWidth: number | null | undefined): number {
  const available =
    viewportWidth !== null && viewportWidth !== undefined && viewportWidth > 0
      ? viewportWidth
      : typeof window === "undefined"
        ? 0
        : window.innerWidth;
  if (!(available > 0)) return APP_ASSISTANT_MAX_WIDTH;
  return Math.max(
    APP_ASSISTANT_MIN_WIDTH,
    Math.min(APP_ASSISTANT_MAX_WIDTH, Math.round(available) - APP_ASSISTANT_RESERVED_WIDTH),
  );
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  /** true, когда события обрабатываются на window вместо handle. */
  readonly fallback: boolean;
}

export interface AppAssistantResizerProps {
  readonly role: "separator";
  readonly tabIndex: 0;
  readonly "aria-orientation": "vertical";
  readonly "aria-valuemin": number;
  readonly "aria-valuemax": number;
  readonly "aria-valuenow": number;
  readonly "data-app-assistant-resizer": "true";
  readonly "data-resizing"?: "true";
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
}

export type AppAssistantAsideStyle = CSSProperties;

export interface AppAssistantResizer {
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly dragging: boolean;
  /**
   * Inline width только на desktop. На mobile панель остаётся `w-full` и
   * fullscreen, без inline width.
   */
  readonly asideStyle: AppAssistantAsideStyle;
  readonly separatorProps: AppAssistantResizerProps;
}

function subscribeDesktop(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(APP_ASSISTANT_DESKTOP_MEDIA_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getDesktopSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // jsdom не реализует matchMedia; unit-тесты работают как desktop.
    return true;
  }
  return window.matchMedia(APP_ASSISTANT_DESKTOP_MEDIA_QUERY).matches;
}

function getServerDesktopSnapshot(): boolean {
  return false;
}

/** Drag левой границы панели, клавиатура и сохранение ширины между перезагрузками. */
export function useDesktopAssistantResizer(): AppAssistantResizer {
  const [desiredWidth, setDesiredWidth] = useState<number>(APP_ASSISTANT_DEFAULT_WIDTH);
  const [maxWidth, setMaxWidth] = useState<number>(APP_ASSISTANT_MAX_WIDTH);
  const [dragging, setDragging] = useState(false);
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    getServerDesktopSnapshot,
  );
  const dragRef = useRef<DragState | null>(null);
  const maxWidthRef = useRef(maxWidth);
  const width = clampAssistantPanelWidth(desiredWidth, maxWidth);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    const stored = readStoredAssistantPanelWidth();
    // SSR и первая клиентская отрисовка используют 384 px; сохранённое значение
    // применяется только после монтирования, поэтому hydration не расходится.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDesiredWidth(stored);
  }, []);

  useEffect(() => {
    const update = (): void => {
      const next = assistantMaxWidthFor(window.innerWidth);
      maxWidthRef.current = next;
      setMaxWidth((current) => (current === next ? current : next));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const applyWidth = useCallback((next: number, persist: boolean) => {
    const clamped = clampAssistantPanelWidth(next, maxWidthRef.current);
    widthRef.current = clamped;
    setDesiredWidth(clamped);
    if (persist) persistAssistantPanelWidth(clamped);
  }, []);

  const resetWidth = useCallback(() => {
    applyWidth(APP_ASSISTANT_DEFAULT_WIDTH, true);
  }, [applyWidth]);

  const cleanupFallbackRef = useRef<() => void>(() => undefined);
  const cleanupFallback = useCallback(() => {
    cleanupFallbackRef.current();
    cleanupFallbackRef.current = () => undefined;
  }, []);

  const moveDrag = useCallback(
    (pointerId: number, clientX: number) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== pointerId) return;
      const nextX = Number.isFinite(clientX) ? clientX : drag.startX;
      // Панель прижата к правому краю: движение влево увеличивает ширину.
      applyWidth(drag.startWidth + drag.startX - nextX, false);
    },
    [applyWidth],
  );

  const completeDrag = useCallback(
    (pointerId: number, releaseCapture?: (pointerId: number) => void) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== pointerId) return;
      dragRef.current = null;
      cleanupFallback();
      setDragging(false);
      try {
        releaseCapture?.(pointerId);
      } catch {
        // Захват мог быть уже снят браузером.
      }
      persistAssistantPanelWidth(widthRef.current);
    },
    [cleanupFallback],
  );

  const attachWindowFallback = useCallback(
    (pointerId: number) => {
      cleanupFallback();
      const onMove = (event: PointerEvent): void => {
        if (event.pointerId !== pointerId) return;
        event.preventDefault();
        moveDrag(pointerId, event.clientX);
      };
      const onFinish = (event: PointerEvent): void => {
        if (event.pointerId !== pointerId) return;
        completeDrag(pointerId);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onFinish);
      window.addEventListener("pointercancel", onFinish);
      cleanupFallbackRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onFinish);
        window.removeEventListener("pointercancel", onFinish);
      };
    },
    [cleanupFallback, completeDrag, moveDrag],
  );

  useEffect(() => () => cleanupFallback(), [cleanupFallback]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current !== null) return;
      if ((event.button ?? 0) !== 0 || event.pointerType === "touch") return;
      event.preventDefault();
      const element = event.currentTarget;
      const pointerId = event.pointerId ?? 0;
      let captureFailed = false;
      try {
        element.setPointerCapture(pointerId);
      } catch {
        captureFailed = true;
      }
      dragRef.current = {
        pointerId,
        startX: Number.isFinite(event.clientX) ? event.clientX : 0,
        startWidth: widthRef.current,
        fallback: captureFailed,
      };
      if (captureFailed) attachWindowFallback(pointerId);
      setDragging(true);
      element.focus({ preventScroll: true });
    },
    [attachWindowFallback],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.fallback || drag.pointerId !== (event.pointerId ?? 0)) return;
      event.preventDefault();
      moveDrag(event.pointerId ?? 0, event.clientX);
    },
    [moveDrag],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.fallback) return;
      completeDrag(event.pointerId ?? 0, (pointerId) => {
        event.currentTarget.releasePointerCapture(pointerId);
      });
    },
    [completeDrag],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? APP_ASSISTANT_LARGE_STEP : APP_ASSISTANT_STEP;
        // Левая граница: ArrowLeft расширяет панель, ArrowRight сужает.
        const direction = event.key === "ArrowLeft" ? 1 : -1;
        applyWidth(widthRef.current + direction * step, true);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        applyWidth(APP_ASSISTANT_MIN_WIDTH, true);
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

  const separatorProps: AppAssistantResizerProps = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-valuemin": APP_ASSISTANT_MIN_WIDTH,
    "aria-valuemax": maxWidth,
    "aria-valuenow": width,
    "data-app-assistant-resizer": "true",
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
    width,
    minWidth: APP_ASSISTANT_MIN_WIDTH,
    maxWidth,
    dragging,
    asideStyle: desktop ? { width: `${width}px` } : {},
    separatorProps,
  };
}
