"use client";

import { Check, Copy, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { copyText } from "./clipboard.ts";

export const CODE_COPY_RESET_MS = 2000;

type CopyState = "idle" | "copied" | "failed";

const idleLabel = "Копировать код";
const copiedLabel = "Код скопирован";
const failedLabel = "Не удалось скопировать код";

function copyLabel(state: CopyState): string {
  switch (state) {
    case "idle":
      return idleLabel;
    case "copied":
      return copiedLabel;
    case "failed":
      return failedLabel;
  }
}

/**
 * Native кнопка копирования code block. Таймер сброса StrictMode-safe:
 * mounted/cleanup контролируют setState после размонтирования, второй live-region
 * не добавляется (у ленты уже есть aria-live).
 */
export function CodeBlockCopyAction({ code }: { readonly code: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const mountedRef = useRef(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  const onClick = useCallback(() => {
    void copyText(code).then((copied) => {
      if (!mountedRef.current) return;
      setState(copied ? "copied" : "failed");
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        if (mountedRef.current) setState("idle");
      }, CODE_COPY_RESET_MS);
    });
  }, [code]);

  const label = copyLabel(state);

  return (
    <button
      type="button"
      data-testid="opencode-copy-code"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background/95 text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent"
    >
      {state === "copied" ? (
        <Check aria-hidden="true" className="size-4 text-emerald-600 dark:text-emerald-400" />
      ) : state === "failed" ? (
        <X aria-hidden="true" className="size-4 text-destructive" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}
