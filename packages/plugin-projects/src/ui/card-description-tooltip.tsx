"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { MarkdownContent } from "./markdown-content.tsx";

const VIEWPORT_MARGIN = 8;
const TOOLTIP_OFFSET = 8;

interface TooltipSize {
  readonly width: number;
  readonly height: number;
}

interface AnchorRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
}

export interface CardDescriptionTooltipPosition {
  readonly top: number;
  readonly left: number;
  readonly placement: "top" | "bottom";
}

export function descriptionPreview(description: string): string {
  return description.trim().length === 0 ? "" : description;
}

export function computeCardDescriptionTooltipPosition(
  anchor: AnchorRect,
  tooltip: TooltipSize,
  viewport: TooltipSize,
): CardDescriptionTooltipPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - tooltip.width - VIEWPORT_MARGIN);
  const centeredLeft = anchor.left + anchor.width / 2 - tooltip.width / 2;
  const left = Math.min(Math.max(VIEWPORT_MARGIN, centeredLeft), maxLeft);
  const topPlacement = anchor.top - tooltip.height - TOOLTIP_OFFSET;
  const bottomPlacement = anchor.bottom + TOOLTIP_OFFSET;
  const fitsTop = topPlacement >= VIEWPORT_MARGIN;
  const fitsBottom = bottomPlacement + tooltip.height <= viewport.height - VIEWPORT_MARGIN;
  const placement = fitsTop || !fitsBottom ? "top" : "bottom";
  const requestedTop = placement === "top" ? topPlacement : bottomPlacement;
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - tooltip.height - VIEWPORT_MARGIN);

  return {
    top: Math.min(Math.max(VIEWPORT_MARGIN, requestedTop), maxTop),
    left,
    placement,
  };
}

export interface CardDescriptionTooltipProps {
  readonly taskId: string;
  readonly description: string;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly onKeepOpen: () => void;
  readonly onRequestClose: () => void;
}

/** Fixed portal не обрезается overflow колонки и не меняет layout карточки. */
export function CardDescriptionTooltip({
  taskId,
  description,
  anchorRef,
  onKeepOpen,
  onRequestClose,
}: CardDescriptionTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CardDescriptionTooltipPosition | null>(null);
  const preview = descriptionPreview(description);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;

    if (anchor === null || tooltip === null || preview.length === 0) {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    setPosition(
      computeCardDescriptionTooltipPosition(anchorRect, tooltipRect, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [anchorRef, preview]);

  if (preview.length === 0 || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      id={`kanban-card-description-${taskId}`}
      role="tooltip"
      data-testid={`kanban-card-description-${taskId}`}
      data-card-description-scroll
      data-placement={position?.placement ?? "top"}
      tabIndex={0}
      onFocus={onKeepOpen}
      onBlur={onRequestClose}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") {
          onKeepOpen();
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") {
          onRequestClose();
        }
      }}
      className="fixed z-50 max-h-[min(16rem,calc(100dvh-1rem))] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed break-words text-popover-foreground shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{
        top: position?.top ?? VIEWPORT_MARGIN,
        left: position?.left ?? VIEWPORT_MARGIN,
        visibility: position === null ? "hidden" : "visible",
      }}
    >
      <MarkdownContent source={preview} className="text-xs" />
    </div>,
    document.body,
  );
}
