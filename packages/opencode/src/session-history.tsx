"use client";

import { History, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenCodeSessionSummary } from "./types.ts";

export const SESSION_HISTORY_CACHE_TTL_MS = 30_000;

export type SessionSwitchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-found" | "unavailable" | "cancelled" };

export interface SessionHistoryProps {
  readonly currentID: string | null;
  readonly currentTitle: string | null;
  readonly busy: boolean;
  /** Растёт после newChat, завершённого prompt и rename: кэш считается stale. */
  readonly version: number;
  readonly loadSessions: (signal: AbortSignal) => Promise<readonly OpenCodeSessionSummary[]>;
  readonly onSelect: (sessionID: string) => Promise<SessionSwitchResult>;
}

const buttonClass =
  "inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function formatSessionUpdatedAt(updatedAt: number): string {
  if (!Number.isFinite(updatedAt)) return "";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(updatedAt));
  } catch {
    return "";
  }
}

/** Короткий детерминированный суффикс ID: различает одинаковые заголовки. */
export function sessionIDSuffix(sessionID: string): string {
  return sessionID.length <= 6 ? sessionID : sessionID.slice(-6);
}

interface CacheEntry {
  readonly items: readonly OpenCodeSessionSummary[];
  readonly at: number;
}

export function SessionHistory({
  currentID,
  currentTitle,
  busy,
  version,
  loadSessions,
  onSelect,
}: SessionHistoryProps) {
  const [items, setItems] = useState<readonly OpenCodeSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<{ readonly target: string } | null>(null);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const cacheRef = useRef<CacheEntry | null>(null);
  const loadingRef = useRef(false);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const versionRef = useRef(version);

  const refresh = useCallback(
    async (force: boolean) => {
      if (loadingRef.current) return;
      const cached = cacheRef.current;
      if (!force && cached !== null && Date.now() - cached.at < SESSION_HISTORY_CACHE_TTL_MS) {
        setItems(cached.items);
        setError(null);
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      setSwitchError(null);
      const requestID = ++requestRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const next = await loadSessions(controller.signal);
        if (requestID !== requestRef.current) return;
        const normalized = Array.isArray(next) ? next : [];
        cacheRef.current = { items: normalized, at: Date.now() };
        setItems(normalized);
      } catch (reason) {
        if (requestID !== requestRef.current) return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        cacheRef.current = null;
        setError("Не удалось загрузить историю сессий");
      } finally {
        if (requestID === requestRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [loadSessions],
  );

  useEffect(() => {
    if (versionRef.current === version) return;
    versionRef.current = version;
    cacheRef.current = null;
    // Инвалидация версии отменяет in-flight list: его response уже устарел и
    // не должен попасть в state или 30-секундный кэш.
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    loadingRef.current = false;
    if (detailsRef.current?.open === true) void refresh(true);
  }, [refresh, version]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const close = (): void => {
    if (detailsRef.current !== null && detailsRef.current.open) {
      detailsRef.current.open = false;
    }
  };

  const select = async (sessionID: string): Promise<void> => {
    if (busy || pendingTarget !== null) return;
    if (sessionID === currentID) {
      close();
      summaryRef.current?.focus();
      return;
    }
    setPendingTarget(sessionID);
    setSwitchError(null);
    try {
      const result = await onSelect(sessionID);
      if (result.ok) {
        close();
        summaryRef.current?.focus();
        return;
      }
      if (result.reason === "not-found") {
        // Удаляется только недоступная запись; текущая сессия не меняется.
        const index = items.findIndex((item) => item.id === sessionID);
        const focusID = items[index + 1]?.id ?? items[index - 1]?.id ?? null;
        setItems((current) => current.filter((item) => item.id !== sessionID));
        if (cacheRef.current !== null) {
          cacheRef.current = {
            items: cacheRef.current.items.filter((item) => item.id !== sessionID),
            at: cacheRef.current.at,
          };
        }
        // Кнопка удалена из DOM: переводим focus на следующую/предыдущую
        // запись, иначе на summary, чтобы клавиатура не потерялась.
        window.requestAnimationFrame(() => {
          const target = focusID === null ? null : itemRefs.current.get(focusID);
          (target ?? summaryRef.current)?.focus();
        });
        return;
      }
      if (result.reason === "unavailable") setSwitchError({ target: sessionID });
    } finally {
      setPendingTarget(null);
    }
  };

  return (
    <details
      ref={detailsRef}
      data-testid="opencode-session-history"
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsRef.current?.open === true) {
          event.preventDefault();
          event.stopPropagation();
          close();
          summaryRef.current?.focus();
        }
      }}
      className="border-b px-3 py-2 text-xs"
    >
      <summary
        ref={summaryRef}
        className="flex min-h-11 min-w-0 cursor-pointer select-none items-center gap-1.5 font-medium"
      >
        <History aria-hidden="true" className="size-3.5 shrink-0" />
        История сессий
      </summary>
      <div className="mt-2 flex max-h-64 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <p role="status" className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
            Загружаем историю…
          </p>
        ) : null}
        {!loading && error !== null ? (
          <div
            role="alert"
            className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive"
          >
            <span className="min-w-0 break-words">{error}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh(true)}
              className={`${buttonClass} shrink-0`}
            >
              <RefreshCw aria-hidden="true" className="size-3.5" /> Повторить
            </button>
          </div>
        ) : null}
        {!loading && error === null && items.length === 0 ? (
          <p className="text-muted-foreground">Сессий пока нет.</p>
        ) : null}
        {!loading && error === null && items.length > 0 ? (
          <ul aria-label="История сессий" className="flex min-w-0 flex-col gap-1">
            {items.map((item) => {
              const title =
                item.id === currentID && currentTitle !== null ? currentTitle : item.title;
              return (
                <li key={item.id} className="min-w-0">
                  <button
                    ref={(node) => {
                      if (node === null) itemRefs.current.delete(item.id);
                      else itemRefs.current.set(item.id, node);
                    }}
                    type="button"
                    aria-current={item.id === currentID ? "true" : undefined}
                    disabled={busy || pendingTarget !== null}
                    onClick={() => void select(item.id)}
                    className={`flex min-h-11 w-full min-w-0 flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                      item.id === currentID ? "border-border bg-accent" : "border-transparent"
                    }`}
                  >
                    <span className="w-full min-w-0 truncate" title={title ?? "Без названия"}>
                      {title ?? "Без названия"}
                    </span>
                    <span className="w-full min-w-0 truncate text-muted-foreground">
                      {formatSessionUpdatedAt(item.updatedAt)} · {sessionIDSuffix(item.id)}
                      {pendingTarget === item.id ? " · Открываем…" : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {switchError !== null && !loading ? (
          <div
            role="alert"
            className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive"
          >
            <span className="min-w-0 break-words">Не удалось открыть сессию</span>
            <button
              type="button"
              disabled={busy || pendingTarget !== null}
              onClick={() => void select(switchError.target)}
              className={`${buttonClass} shrink-0`}
            >
              <RefreshCw aria-hidden="true" className="size-3.5" /> Повторить
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
