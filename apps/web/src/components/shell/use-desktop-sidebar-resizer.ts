"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export const APP_SIDEBAR_DEFAULT_WIDTH = 288;
export const APP_SIDEBAR_MIN_WIDTH = 240;
export const APP_SIDEBAR_MAX_WIDTH = 560;
export const APP_SIDEBAR_MIN_CONTENT_WIDTH = 416;
export const APP_SIDEBAR_STEP = 16;
export const APP_SIDEBAR_LARGE_STEP = 48;
export const APP_SIDEBAR_STORAGE_KEY = "kanbaner.ui.sidebarWidth";

export function clampSidebarWidth(width: number, maxWidth: number = APP_SIDEBAR_MAX_WIDTH): number {
  const boundedMax = Math.max(
    APP_SIDEBAR_MIN_WIDTH,
    Math.min(APP_SIDEBAR_MAX_WIDTH, Math.round(maxWidth)),
  );
  if (!Number.isFinite(width)) return Math.min(APP_SIDEBAR_DEFAULT_WIDTH, boundedMax);
  return Math.min(Math.max(Math.round(width), APP_SIDEBAR_MIN_WIDTH), boundedMax);
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

export function readStoredSidebarWidth(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): number {
  try {
    const raw = storage?.getItem(APP_SIDEBAR_STORAGE_KEY);
    if (raw === null || raw === undefined || !STORED_WIDTH_PATTERN.test(raw)) {
      return APP_SIDEBAR_DEFAULT_WIDTH;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return APP_SIDEBAR_DEFAULT_WIDTH;
    return clampSidebarWidth(value);
  } catch {
    return APP_SIDEBAR_DEFAULT_WIDTH;
  }
}

function persistSidebarWidth(width: number, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(APP_SIDEBAR_STORAGE_KEY, String(width));
  } catch {
    // Приватный режим и квоты не мешают resize в текущей сессии.
  }
}

/** Максимум с учётом viewport и минимальной ширины основного контента. */
export function sidebarMaxWidthFor(viewportWidth: number | null | undefined): number {
  const available =
    viewportWidth !== null && viewportWidth !== undefined && viewportWidth > 0
      ? viewportWidth
      : typeof window === "undefined"
        ? 0
        : window.innerWidth;
  if (!(available > 0)) return APP_SIDEBAR_MAX_WIDTH;
  return Math.max(
    APP_SIDEBAR_MIN_WIDTH,
    Math.min(APP_SIDEBAR_MAX_WIDTH, Math.round(available) - APP_SIDEBAR_MIN_CONTENT_WIDTH),
  );
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  /** true, когда события обрабатываются на window вместо handle. */
  readonly fallback: boolean;
}

export interface AppSidebarResizerProps {
  readonly role: "separator";
  readonly tabIndex: 0;
  readonly "aria-orientation": "vertical";
  readonly "aria-valuemin": number;
  readonly "aria-valuemax": number;
  readonly "aria-valuenow": number;
  readonly "data-app-sidebar-resizer": "true";
  readonly "data-resizing"?: "true";
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
}

export interface AppSidebarResizer {
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly dragging: boolean;
  readonly asideStyle: CSSProperties;
  readonly separatorProps: AppSidebarResizerProps;
}

/** Drag правой границы, клавиатура и сохранение ширины между перезагрузками. */
export function useDesktopSidebarResizer(): AppSidebarResizer {
  const [desiredWidth, setDesiredWidth] = useState<number>(APP_SIDEBAR_DEFAULT_WIDTH);
  const [maxWidth, setMaxWidth] = useState<number>(APP_SIDEBAR_MAX_WIDTH);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const maxWidthRef = useRef(maxWidth);
  const width = clampSidebarWidth(desiredWidth, maxWidth);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    const stored = readStoredSidebarWidth();
    // SSR и первая клиентская отрисовка используют 288 px; сохранённое значение
    // применяется только после монтирования, поэтому hydration не расходится.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDesiredWidth(stored);
  }, []);

  useEffect(() => {
    const update = (): void => {
      const next = sidebarMaxWidthFor(window.innerWidth);
      maxWidthRef.current = next;
      setMaxWidth((current) => (current === next ? current : next));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const applyWidth = useCallback((next: number, persist: boolean) => {
    const clamped = clampSidebarWidth(next, maxWidthRef.current);
    widthRef.current = clamped;
    setDesiredWidth(clamped);
    if (persist) persistSidebarWidth(clamped);
  }, []);

  const resetWidth = useCallback(() => {
    applyWidth(APP_SIDEBAR_DEFAULT_WIDTH, true);
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
      applyWidth(drag.startWidth + nextX - drag.startX, false);
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
      persistSidebarWidth(widthRef.current);
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
        const step = event.shiftKey ? APP_SIDEBAR_LARGE_STEP : APP_SIDEBAR_STEP;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        applyWidth(widthRef.current + direction * step, true);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        applyWidth(APP_SIDEBAR_MIN_WIDTH, true);
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

  const separatorProps: AppSidebarResizerProps = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-valuemin": APP_SIDEBAR_MIN_WIDTH,
    "aria-valuemax": maxWidth,
    "aria-valuenow": width,
    "data-app-sidebar-resizer": "true",
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
    minWidth: APP_SIDEBAR_MIN_WIDTH,
    maxWidth,
    dragging,
    asideStyle: { width: `${width}px` },
    separatorProps,
  };
}
