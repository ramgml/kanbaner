"use client";

import { useCallback, useState } from "react";

export const OPENCODE_SESSION_KEY = "kanbaner.opencode.sessionId";
export const OPENCODE_DRAFTS_KEY = "kanbaner.opencode.drafts.v1";
export const DRAFTS_VERSION = 1;
export const DRAFT_MAX_ENTRY_CHARS = 16_384;
export const DRAFT_MAX_ENTRIES = 20;
export const DRAFT_MAX_TOTAL_CHARS = 65_536;

interface DraftRecord {
  readonly text: string;
  readonly updatedAt: number;
}

interface StoredDraft {
  readonly text: unknown;
  readonly updatedAt: unknown;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Полностью заблокированный localStorage не должен ломать панель.
    return null;
  }
}

function readItem(key: string): string | null {
  const storage = browserStorage();
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  const storage = browserStorage();
  if (storage === null) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Quota/SecurityError: ввод остаётся в памяти, но не переживает reload.
  }
}

function removeItem(key: string): void {
  const storage = browserStorage();
  if (storage === null) return;
  try {
    storage.removeItem(key);
  } catch {
    // Storage недоступен; удалять нечего.
  }
}

/** Последняя session ID: ошибки storage не маскируются под сбой Service. */
export function readStoredSessionID(): string | null {
  const value = readItem(OPENCODE_SESSION_KEY);
  return value === null || value.length === 0 ? null : value;
}

export function storeSessionID(sessionID: string): void {
  if (sessionID.length === 0) return;
  writeItem(OPENCODE_SESSION_KEY, sessionID);
}

export function clearStoredSessionID(): void {
  removeItem(OPENCODE_SESSION_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DRAFT_MAX_ENTRY_CHARS;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validSessionID(value: string): boolean {
  return value.length > 0;
}

/**
 * LRU: самые старые по `updatedAt` удаляются первыми. При равном времени
 * порядок детерминирован лексикографическим session ID, а защищённая запись
 * удаляется только если без неё всё ещё превышен лимит (для неё это невозможно
 * при 16 384 < 65 536).
 */
function pruneDrafts(
  entries: Map<string, DraftRecord>,
  protectedKey: string | null,
): Map<string, DraftRecord> {
  let total = 0;
  for (const entry of entries.values()) total += entry.text.length;
  if (entries.size <= DRAFT_MAX_ENTRIES && total <= DRAFT_MAX_TOTAL_CHARS) return entries;

  const ordered = [...entries.keys()].sort((left, right) => {
    const leftEntry = entries.get(left);
    const rightEntry = entries.get(right);
    const leftTime = leftEntry?.updatedAt ?? 0;
    const rightTime = rightEntry?.updatedAt ?? 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const pruned = new Map(entries);
  for (const key of ordered) {
    if (pruned.size <= DRAFT_MAX_ENTRIES && total <= DRAFT_MAX_TOTAL_CHARS) break;
    if (key === protectedKey && pruned.size > 1) {
      // Защищённую запись пробуем сохранить: сначала удаляем другие.
      continue;
    }
    const entry = pruned.get(key);
    if (entry === undefined) continue;
    pruned.delete(key);
    total -= entry.text.length;
  }
  return pruned;
}

/**
 * Читает только валидные записи. Невалидный JSON/version/shape, NaN-время и
 * oversize entry игнорируются по отдельности и не ломают остальные черновики.
 */
function parseDrafts(raw: string | null): Map<string, DraftRecord> {
  const entries = new Map<string, DraftRecord>();
  if (raw === null) return entries;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries;
  }
  if (!isRecord(parsed) || parsed.v !== DRAFTS_VERSION || !isRecord(parsed.drafts)) {
    return entries;
  }

  for (const sessionID of Object.keys(parsed.drafts)) {
    if (!validSessionID(sessionID)) continue;
    const candidate = parsed.drafts[sessionID];
    if (!isRecord(candidate)) continue;
    const { text, updatedAt } = candidate as unknown as StoredDraft;
    if (!validText(text) || !validTimestamp(updatedAt)) continue;
    entries.set(sessionID, { text, updatedAt });
  }

  return pruneDrafts(entries, null);
}

/** Все сохранённые черновики для composer; значения — только text. */
export function readDrafts(): ReadonlyMap<string, string> {
  const drafts = new Map<string, string>();
  for (const [sessionID, entry] of parseDrafts(readItem(OPENCODE_DRAFTS_KEY))) {
    drafts.set(sessionID, entry.text);
  }
  return drafts;
}

function persistDrafts(entries: Map<string, DraftRecord>): void {
  if (entries.size === 0) {
    removeItem(OPENCODE_DRAFTS_KEY);
    return;
  }
  const drafts: Record<string, DraftRecord> = Object.fromEntries(entries);
  writeItem(OPENCODE_DRAFTS_KEY, JSON.stringify({ v: DRAFTS_VERSION, drafts }));
}

/**
 * Синхронная запись текущего composer-текста. Пустой текст удаляет запись,
 * последняя запись удаляет ключ целиком. Сверхлимитный текст не сохраняется:
 * существовавшая запись этой сессии детерминированно удаляется, чтобы после
 * reload не восстановить устаревший ввод; сам текст остаётся в памяти composer.
 */
export function writeDraft(sessionID: string, text: string, now = Date.now()): void {
  if (!validSessionID(sessionID)) return;
  const entries = parseDrafts(readItem(OPENCODE_DRAFTS_KEY));

  if (text.length === 0 || text.length > DRAFT_MAX_ENTRY_CHARS) {
    entries.delete(sessionID);
  } else {
    entries.set(sessionID, { text, updatedAt: validTimestamp(now) ? now : Date.now() });
  }

  persistDrafts(pruneDrafts(entries, sessionID));
}

export function removeDraft(sessionID: string): void {
  if (!validSessionID(sessionID)) return;
  const entries = parseDrafts(readItem(OPENCODE_DRAFTS_KEY));
  if (!entries.delete(sessionID)) return;
  persistDrafts(entries);
}

export interface SessionDraft {
  readonly text: string;
  /** Пишет синхронно только в session ID текущего render. */
  readonly setText: (text: string) => void;
  /** Очищает черновик явной сессии; in-memory текст меняется только для неё. */
  readonly clearDraft: (sessionID: string) => void;
}

/**
 * Per-session черновик composer. Карта читается из storage один раз при mount,
 * поэтому смена session ID сразу берёт её значение без effect-cleanup записи и
 * без кадра текста другой сессии. StrictMode не пишет пустую строку при
 * повторном mount: cleanup-эффекта записи нет вообще.
 */
export function useSessionDraft(sessionID: string | null): SessionDraft {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(readDrafts);

  const setText = useCallback(
    (text: string) => {
      if (sessionID === null || sessionID.length === 0) return;
      setDrafts((current) => {
        if ((current.get(sessionID) ?? "") === text) return current;
        const next = new Map(current);
        if (text.length === 0) next.delete(sessionID);
        else next.set(sessionID, text);
        return next;
      });
      writeDraft(sessionID, text);
    },
    [sessionID],
  );

  const clearDraft = useCallback((target: string) => {
    removeDraft(target);
    setDrafts((current) => {
      if (!current.has(target)) return current;
      const next = new Map(current);
      next.delete(target);
      return next;
    });
  }, []);

  return {
    text: sessionID === null ? "" : (drafts.get(sessionID) ?? ""),
    setText,
    clearDraft,
  };
}
