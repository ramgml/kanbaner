"use client";

import {
  Bot,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResourceRef } from "@kanbaner/plugin-sdk";
import { MarkdownContent } from "@kanbaner/markdown-ui";

import {
  ATTACHMENT_ACCEPT,
  attachmentKind,
  attachmentMime,
  formatAttachmentSize,
  sanitizeAttachmentName,
  selectionValidationError,
} from "./attachments.ts";
import {
  OPENCODE_AGENT_ID,
  OPENCODE_PLUGIN_ID,
  OPENCODE_UI_CONTRACT,
  opencodeUiContributions,
} from "./metadata.ts";
import {
  isRecord,
  type OpenCodeAttachmentPayload,
  type OpenCodeAttachmentView,
  type OpenCodeCatalog,
  type OpenCodeChatMessage,
  type OpenCodeModelRefView,
  type OpenCodeModelView,
  type OpenCodeSessionView,
  type OpenCodeStreamEvent,
  type OpenCodeToolView,
  type OpenCodeTurnStatus,
} from "./types.ts";
import { opencodeToolSource } from "./tool-metadata.ts";
import {
  finishToolMessages,
  mergeToolMessage,
  ToolCallMessage,
  type OpenCodeToolMessage,
} from "./tool-call.tsx";

export { OPENCODE_PLUGIN_ID, OPENCODE_UI_CONTRACT, opencodeUiContributions } from "./metadata.ts";

interface OpenCodePanelProps {
  readonly search?: string | undefined;
}

const SESSION_KEY = "kanbaner.opencode.sessionId";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const inputClass =
  "rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const iconButtonClass =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Assistant/system Markdown рендерится тем же безопасным renderer, что и в остальных плагинах. */
const MarkdownMessage = memo(function MarkdownMessage({ source }: { readonly source: string }) {
  return <MarkdownContent source={source} />;
});

function ToolList({
  tools,
  label,
}: {
  readonly tools: readonly OpenCodeToolView[];
  readonly label: string;
}) {
  return (
    <ul aria-label={label} className="mt-1 flex flex-col gap-1">
      {tools.map((tool) => (
        <li key={tool.name} className="flex items-center justify-between gap-2">
          <code className="truncate">{tool.name}</code>
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <span>{tool.risk}</span>
            {tool.requiresExpectedVersion ? <span>expectedVersion</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Catalog разделён на стандартные built-in tools OpenCode и ручной Kanbaner MCP
 * allowlist. Заголовок показывает фактическое общее число, а не только MCP.
 */
const ToolCatalog = memo(function ToolCatalog({
  tools,
}: {
  readonly tools: readonly OpenCodeToolView[];
}) {
  const builtin = tools.filter((tool) => opencodeToolSource(tool) === "builtin");
  const mcp = tools.filter((tool) => opencodeToolSource(tool) === "mcp");

  return (
    <details className="border-b px-3 py-2 text-xs">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium">
        <Wrench aria-hidden="true" className="size-3.5" />
        Инструменты агента ({tools.length})
      </summary>
      <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
        Полный доступ: интернет, файлы и shell
      </p>
      {builtin.length > 0 ? (
        <section className="mt-2">
          <h3 className="font-medium">Встроенные инструменты OpenCode ({builtin.length})</h3>
          <ToolList tools={builtin} label="Встроенные инструменты OpenCode" />
        </section>
      ) : null}
      {mcp.length > 0 ? (
        <section className="mt-2">
          <h3 className="font-medium">Инструменты Kanbaner MCP ({mcp.length})</h3>
          <ToolList tools={mcp} label="Инструменты Kanbaner MCP" />
        </section>
      ) : null}
    </details>
  );
});

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function envelope<T>(response: Response): Promise<T> {
  const result: unknown = await response.json().catch(() => null);
  if (isRecord(result) && result.ok === true && "data" in result) return result.data as T;
  if (isRecord(result) && result.ok === false && isRecord(result.error)) {
    const message =
      typeof result.error.message === "string" ? result.error.message : "Запрос отклонён";
    const code = typeof result.error.code === "string" ? result.error.code : "INTERNAL_ERROR";
    throw new ApiError(message, response.status, code);
  }
  throw new Error("INVALID_OPENCODE_RESPONSE");
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "x-kanbaner-client": "ui", ...init?.headers },
  });
  return envelope<T>(response);
}

function publicError(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) return reason.message;
  if (reason instanceof Error && reason.message === "FILE_READ_FAILED") {
    return "Не удалось прочитать прикреплённый файл";
  }
  if (reason instanceof Error && reason.message === "ATTACHMENT_TYPE") {
    return "Тип прикреплённого файла не поддерживается";
  }
  return fallback;
}

function contextRefFromSearch(search: string | undefined): ResourceRef | null {
  const params = new URLSearchParams(search ?? "");
  const direct = params.get("resource")?.trim();
  if (direct !== undefined && direct.includes(":")) return direct;
  const note = params.get("note")?.trim();
  return note === undefined || note.length === 0 ? null : `kanbaner.notes:note:${note}`;
}

function messageKey(message: OpenCodeChatMessage, index: number): string {
  return `${message.id}-${index}`;
}

/**
 * Локальный File остаётся только в UI-слое и никогда не попадает в history.
 * URL создаётся из File один раз и живёт до тех пор, пока запись сопоставлена
 * с сообщением текущей session.
 */
interface LocalImageAttachment {
  readonly sessionID: string;
  readonly userOrdinal: number;
  readonly attachmentIndex: number;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly file: File;
  readonly url: string;
}

function createObjectUrl(blob: Blob): string | null {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function revokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // URL уже освобождён или среда не поддерживает object URL.
  }
}

const PREVIEW_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Endpoint строится локально из session/message id и индекса вложения.
 * URL из server payload не используется.
 */
function attachmentPreviewPath(
  sessionID: string,
  messageID: string,
  attachmentIndex: number,
): string {
  return `/api/opencode/session/${encodeURIComponent(sessionID)}/messages/${encodeURIComponent(
    messageID,
  )}/attachments/${attachmentIndex}`;
}

function canonicalUserMessageID(message: OpenCodeChatMessage): string | null {
  if (message.role !== "user") return null;
  if (!message.id.startsWith("user:") || message.id.startsWith("user:optimistic:")) return null;
  const raw = message.id.slice("user:".length);
  return raw.length === 0 ? null : raw;
}

/**
 * Бинарный preview canonical history. Запрос идёт только когда нет usable
 * local preview. Object URL освобождается при смене identity и unmount,
 * in-flight fetch отменяется, stale response не применяется.
 */
function useRemoteAttachmentPreview(
  sessionID: string | null,
  messageID: string | null,
  attachmentIndex: number,
  enabled: boolean,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс при смене canonical attachment; cleanup этого же эффекта освобождает URL.
    setUrl(null);
    if (!enabled || sessionID === null || messageID === null) return;
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(attachmentPreviewPath(sessionID, messageID, attachmentIndex), {
          cache: "no-store",
          headers: { "x-kanbaner-client": "ui" },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const mime =
          (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        if (!PREVIEW_IMAGE_MIME.has(mime)) return;
        const blob = await response.blob();
        if (!active || controller.signal.aborted) return;
        objectUrl = createObjectUrl(blob);
        if (objectUrl !== null) setUrl(objectUrl);
      } catch {
        // Preview недоступен: остаётся chip с name/mime.
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl !== null) revokeObjectUrl(objectUrl);
    };
  }, [attachmentIndex, enabled, messageID, sessionID]);
  return url;
}

function userMessageAt(
  messages: readonly OpenCodeChatMessage[],
  ordinal: number,
): OpenCodeChatMessage | undefined {
  let current = -1;
  for (const message of messages) {
    if (message.role !== "user") continue;
    current += 1;
    if (current === ordinal) return message;
  }
  return undefined;
}

function localImageVisible(
  local: LocalImageAttachment,
  sessionID: string | null,
  messages: readonly OpenCodeChatMessage[],
): boolean {
  if (sessionID === null || local.sessionID !== sessionID) return false;
  const message = userMessageAt(messages, local.userOrdinal);
  if (message === undefined || message.role !== "user") return false;
  const attachment = message.attachments?.[local.attachmentIndex];
  if (attachment === undefined) return false;
  return (
    attachment.name === local.name &&
    attachment.mime === local.mime &&
    (attachment.size === undefined || attachment.size === local.size)
  );
}

function localImageMatch(
  localImages: readonly LocalImageAttachment[],
  sessionID: string | null,
  userOrdinal: number,
  attachmentIndex: number,
  attachment: OpenCodeAttachmentView,
): LocalImageAttachment | null {
  if (sessionID === null) return null;
  for (const local of localImages) {
    if (
      local.sessionID === sessionID &&
      local.userOrdinal === userOrdinal &&
      local.attachmentIndex === attachmentIndex &&
      local.name === attachment.name &&
      local.mime === attachment.mime &&
      (attachment.size === undefined || attachment.size === local.size)
    ) {
      return local;
    }
  }
  return null;
}

/** Blob URL для выбранного файла; освобождается при смене file или unmount. */
function useFileObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- blob URL нельзя создавать в render: cleanup этого же эффекта гарантирует ровно один revoke.
      setUrl(null);
      return;
    }
    const next = createObjectUrl(file);
    setUrl(next);
    return () => {
      if (next !== null) revokeObjectUrl(next);
    };
  }, [file]);
  return url;
}

function PendingAttachmentChip({
  file,
  busy,
  onRemove,
}: {
  readonly file: File;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) {
  const name = sanitizeAttachmentName(file.name);
  const image = attachmentKind(name, file.type) === "image";
  const url = useFileObjectUrl(image ? file : null);

  return (
    <li className="flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-1 text-xs">
      {image ? (
        url === null ? (
          <span aria-hidden="true" className="size-12 shrink-0 rounded bg-muted" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- blob URL локального File нельзя отдать next/image.
          <img
            src={url}
            alt={name}
            data-testid="composer-image-preview"
            className="size-12 shrink-0 rounded object-cover"
          />
        )
      ) : (
        <FileText aria-hidden="true" className="size-3 shrink-0" />
      )}
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-muted-foreground">{formatAttachmentSize(file.size)}</span>
      <button
        type="button"
        aria-label={`Удалить вложение ${name}`}
        disabled={busy}
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 hover:bg-accent disabled:opacity-50"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}

function MessageAttachmentItem({
  attachment,
  url,
  sessionID,
  messageID,
  attachmentIndex,
}: {
  readonly attachment: OpenCodeAttachmentView;
  readonly url: string | null;
  readonly sessionID: string | null;
  readonly messageID: string | null;
  readonly attachmentIndex: number;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedRemoteUrl, setFailedRemoteUrl] = useState<string | null>(null);
  const image = attachmentKind(attachment.name, attachment.mime) === "image";
  const localUsable = image && url !== null && failedUrl !== url;
  const remoteUrl = useRemoteAttachmentPreview(
    sessionID,
    messageID,
    attachmentIndex,
    image && !localUsable,
  );
  const displayUrl =
    localUsable && url !== null
      ? url
      : remoteUrl !== null && remoteUrl !== failedRemoteUrl
        ? remoteUrl
        : null;

  if (image && displayUrl !== null) {
    return (
      <figure className="flex min-w-0 max-w-full flex-col gap-1">
        {/* eslint-disable-next-line @next/next/no-img-element -- blob URL вложения нельзя отдать next/image. */}
        <img
          src={displayUrl}
          alt={attachment.name}
          data-testid="message-image-preview"
          onError={() => {
            if (localUsable && url !== null) setFailedUrl(url);
            else if (remoteUrl !== null) setFailedRemoteUrl(remoteUrl);
          }}
          className="max-h-56 max-w-60 rounded border border-current/20 object-contain"
        />
        <figcaption className="max-w-60 truncate text-xs opacity-80" title={attachment.name}>
          {attachment.name}
        </figcaption>
      </figure>
    );
  }

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-current/30 px-1.5 py-0.5 text-xs">
      <FileText aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{attachment.name}</span>
      <span className="opacity-75">{attachment.mime}</span>
    </span>
  );
}

function selection(
  model: OpenCodeModelView,
  previous: OpenCodeModelRefView | null,
): OpenCodeModelRefView {
  const variant =
    previous?.providerID === model.providerID &&
    previous.id === model.id &&
    previous.variant !== undefined &&
    model.variants.includes(previous.variant)
      ? previous.variant
      : model.variants[0];
  return {
    id: model.id,
    providerID: model.providerID,
    ...(variant === undefined ? {} : { variant }),
  };
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

type TurnPhase = "connecting" | "running" | "finalizing" | "done" | "cancelled" | "error";

/**
 * Состояние одного prompt-хода. generation/sessionID не дают stale-ответу
 * перезаписать новый ход; snapshot текста и файлов нужен для безопасного
 * повтора только точно не принятого запроса.
 */
interface TurnState {
  readonly generation: number;
  readonly sessionID: string;
  /** Client-generated stable identity; не ordinal и не зависит от history. */
  readonly turnID: string;
  /** Фактический admitted ID, если Service его подменил. */
  readonly admittedTurnID: string | null;
  readonly phase: TurnPhase;
  readonly reason: "unconfirmed" | null;
  readonly errorText: string | null;
  readonly retryable: boolean;
  readonly requestText: string;
  readonly displayText: string;
  readonly files: readonly File[];
  readonly optimisticAppended: boolean;
  readonly checking: boolean;
  readonly statusNote: string | null;
}

function terminalPhase(phase: TurnPhase): boolean {
  return phase === "done" || phase === "cancelled" || phase === "error";
}

interface PromptAttempt {
  readonly text: string;
  readonly displayText: string;
  readonly files: readonly File[];
  readonly turnID: string;
  readonly optimisticAppended: boolean;
}

function turnPhaseLabel(turn: TurnState): string {
  switch (turn.phase) {
    case "connecting":
      return "Подключаемся…";
    case "running":
      return "Выполняется…";
    case "finalizing":
      return "Завершаем…";
    case "done":
      return "Готово";
    case "cancelled":
      return "Остановлено";
    case "error":
      return turn.reason === "unconfirmed" ? "Результат не подтверждён" : "Ошибка запроса";
  }
}

/**
 * Stable client turn identity, известная ещё до сетевого запроса. Ordinal или
 * UI-текст не используются: canonical outcome считает сервер по raw history.
 */
function createTurnID(): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  return `msg_${uuid}`;
}

function retryableResponseStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function readFileBase64(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const reader = new FileReader();
    const cleanup = (): void => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (reason: unknown): void => {
      cleanup();
      reject(reason);
    };
    const onAbort = (): void => {
      cleanup();
      try {
        reader.abort();
      } catch {
        // Чтение уже завершено; отменять нечего.
      }
      reject(abortError());
    };
    reader.onload = () => {
      const result = reader.result;
      cleanup();
      if (typeof result !== "string") {
        reject(new Error("FILE_READ_FAILED"));
        return;
      }
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("FILE_READ_FAILED"));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.onerror = () => fail(new Error("FILE_READ_FAILED"));
    reader.onabort = () => fail(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (reason) {
      fail(reason);
    }
  });
}

async function attachmentPayload(
  file: File,
  signal: AbortSignal,
): Promise<OpenCodeAttachmentPayload> {
  const name = sanitizeAttachmentName(file.name);
  const kind = attachmentKind(name, file.type);
  if (kind === null) throw new Error("ATTACHMENT_TYPE");
  return {
    name,
    mime: attachmentMime(name, file.type, kind),
    base64: await readFileBase64(file, signal),
  };
}

export function OpenCodePanel({ search }: OpenCodePanelProps) {
  const [catalog, setCatalog] = useState<OpenCodeCatalog | null>(null);
  const [session, setSession] = useState<OpenCodeSessionView | null>(null);
  const [messages, setMessages] = useState<readonly OpenCodeChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [promptPending, setPromptPending] = useState(false);
  const [modelPending, setModelPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [turn, setTurn] = useState<TurnState | null>(null);
  const [attachedRef, setAttachedRef] = useState<ResourceRef | null>(null);
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([]);
  const [localImages, setLocalImages] = useState<readonly LocalImageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const generationRef = useRef(0);
  const localImagesRef = useRef<readonly LocalImageAttachment[]>([]);
  const initializeAbortRef = useRef<AbortController | null>(null);
  const modelAbortRef = useRef<AbortController | null>(null);
  const promptAbortRef = useRef<AbortController | null>(null);
  const refreshControllersRef = useRef(new Set<AbortController>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useMemo(() => contextRefFromSearch(search), [search]);
  const busy = loading || creating || modelPending || promptPending;

  const beginOperation = useCallback((): number => {
    const generation = ++generationRef.current;
    initializeAbortRef.current?.abort();
    modelAbortRef.current?.abort();
    promptAbortRef.current?.abort();
    for (const controller of refreshControllersRef.current) controller.abort();
    refreshControllersRef.current.clear();
    initializeAbortRef.current = null;
    modelAbortRef.current = null;
    promptAbortRef.current = null;
    setLoading(false);
    setCreating(false);
    setModelPending(false);
    setPromptPending(false);
    return generation;
  }, []);

  const applySession = useCallback((next: OpenCodeSessionView, generation: number): boolean => {
    if (generation !== generationRef.current) return false;
    setSession(next);
    setMessages(next.messages);
    window.localStorage.setItem(SESSION_KEY, next.id);
    return true;
  }, []);

  const createSession = useCallback(
    async (model: OpenCodeModelRefView | undefined, generation: number, signal: AbortSignal) => {
      const created = await request<OpenCodeSessionView>("/api/opencode/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: OPENCODE_AGENT_ID,
          ...(model === undefined ? {} : { model }),
        }),
        signal,
      });
      applySession(created, generation);
    },
    [applySession],
  );

  const initialize = useCallback(async () => {
    const generation = beginOperation();
    const controller = new AbortController();
    initializeAbortRef.current = controller;
    setLoading(true);
    setPanelError(null);
    try {
      const nextCatalog = await request<OpenCodeCatalog>("/api/opencode/catalog", {
        signal: controller.signal,
      });
      if (generation !== generationRef.current) return;
      setCatalog(nextCatalog);
      const stored = window.localStorage.getItem(SESSION_KEY);
      if (stored !== null && stored.length > 0) {
        try {
          const restored = await request<OpenCodeSessionView>(
            `/api/opencode/session/${encodeURIComponent(stored)}`,
            { signal: controller.signal },
          );
          applySession(restored, generation);
          return;
        } catch (reason) {
          if (generation !== generationRef.current) return;
          if (!(reason instanceof ApiError && reason.status === 404)) throw reason;
          window.localStorage.removeItem(SESSION_KEY);
        }
      }
      await createSession(nextCatalog.defaultModel ?? undefined, generation, controller.signal);
    } catch (reason) {
      if (
        generation === generationRef.current &&
        !(reason instanceof Error && reason.name === "AbortError")
      ) {
        setPanelError(publicError(reason, "OpenCode Service недоступен"));
      }
    } finally {
      if (initializeAbortRef.current === controller) initializeAbortRef.current = null;
      if (generation === generationRef.current) setLoading(false);
    }
  }, [applySession, beginOperation, createSession]);

  useEffect(() => {
    const refreshControllers = refreshControllersRef.current;
    const frame = window.requestAnimationFrame(() => {
      void initialize();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      generationRef.current += 1;
      initializeAbortRef.current?.abort();
      modelAbortRef.current?.abort();
      promptAbortRef.current?.abort();
      for (const controller of refreshControllers) controller.abort();
      refreshControllers.clear();
    };
  }, [initialize]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setAttachedRef(null));
    return () => window.cancelAnimationFrame(frame);
  }, [currentRef]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  useEffect(() => {
    localImagesRef.current = localImages;
  }, [localImages]);

  /**
   * Canonical refresh заменяет optimistic messages, но запись остаётся, пока
   * user-message ordinal и attachment index всё ещё указывают на тот же
   * name/mime. Всё остальное освобождается, чтобы не показать чужое превью.
   */
  useEffect(() => {
    const sessionID = session?.id ?? null;
    const current = localImagesRef.current;
    const stale = current.filter((local) => !localImageVisible(local, sessionID, messages));
    if (stale.length === 0) return;
    const staleUrls = new Set(stale.map((local) => local.url));
    const kept = current.filter((local) => !staleUrls.has(local.url));
    localImagesRef.current = kept;
    setLocalImages(kept);
    for (const local of stale) revokeObjectUrl(local.url);
  }, [messages, session?.id]);

  useEffect(
    () => () => {
      for (const local of localImagesRef.current) revokeObjectUrl(local.url);
      localImagesRef.current = [];
    },
    [],
  );

  const refreshSession = useCallback(
    (sessionID: string, generation: number): void => {
      const controller = new AbortController();
      refreshControllersRef.current.add(controller);
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      void request<OpenCodeSessionView>(`/api/opencode/session/${encodeURIComponent(sessionID)}`, {
        signal: controller.signal,
      })
        .then((restored) => {
          applySession(restored, generation);
        })
        .catch(() => {
          // Streaming result уже показан; временный сбой canonical refresh не скрываем как новый сбой prompt.
        })
        .finally(() => {
          window.clearTimeout(timeout);
          refreshControllersRef.current.delete(controller);
        });
    },
    [applySession],
  );

  const switchModel = async (model: OpenCodeModelRefView) => {
    if (session === null || busy) return;
    const sessionID = session.id;
    const generation = beginOperation();
    const controller = new AbortController();
    modelAbortRef.current = controller;
    setModelPending(true);
    setPanelError(null);
    try {
      await request(`/api/opencode/session/${encodeURIComponent(sessionID)}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (generation !== generationRef.current) return;
      setSession((current) =>
        generation !== generationRef.current || current === null || current.id !== sessionID
          ? current
          : { ...current, model },
      );
    } catch (reason) {
      if (
        generation === generationRef.current &&
        !(reason instanceof Error && reason.name === "AbortError")
      ) {
        setPanelError(publicError(reason, "Не удалось сменить модель"));
      }
    } finally {
      if (modelAbortRef.current === controller) modelAbortRef.current = null;
      if (generation === generationRef.current) setModelPending(false);
    }
  };

  const selectedModel = session?.model ?? catalog?.defaultModel ?? null;
  const models = useMemo(
    () => catalog?.models.filter((model) => model.providerID === selectedModel?.providerID) ?? [],
    [catalog, selectedModel?.providerID],
  );
  const variants = useMemo(
    () => models.find((model) => model.id === selectedModel?.id)?.variants ?? [],
    [models, selectedModel?.id],
  );
  const selectedModelName = models.find((model) => model.id === selectedModel?.id)?.name;
  const selectedModelLabel = selectedModelName ?? selectedModel?.id ?? "Не выбрана";

  const userOrdinals = useMemo(() => {
    let ordinal = -1;
    return messages.map((message) => {
      if (message.role === "user") ordinal += 1;
      return ordinal;
    });
  }, [messages]);

  const attachmentMetadata = (file: File): { name: string; mime: string; size: number } => ({
    name: sanitizeAttachmentName(file.name),
    mime: file.type,
    size: file.size,
  });

  const addFiles = (incoming: readonly File[]): void => {
    if (incoming.length === 0 || busy) return;
    const next = [...pendingFiles, ...incoming];
    const error = selectionValidationError(next.map(attachmentMetadata));
    if (error !== null) {
      setSelectionError(error);
      return;
    }
    setSelectionError(null);
    setPendingFiles(next);
  };

  const removeFile = (index: number): void => {
    if (busy) return;
    setPendingFiles((current) => current.filter((_file, currentIndex) => currentIndex !== index));
    setSelectionError(null);
  };

  const clearFiles = (): void => {
    setPendingFiles([]);
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  };

  const runPrompt = async (attempt: PromptAttempt): Promise<void> => {
    if (session === null || busy) return;
    const sessionID = session.id;
    const files = attempt.files;
    const turnID = attempt.turnID;
    // Ordinal нужен только для сопоставления локальных image preview с
    // canonical attachment; identity turn — turnID.
    const userOrdinal = messages.reduce(
      (count, message) => count + (message.role === "user" ? 1 : 0),
      0,
    );
    const generation = beginOperation();
    const controller = new AbortController();
    promptAbortRef.current = controller;
    setPromptPending(true);
    setPanelError(null);
    setSelectionError(null);
    setTurn({
      generation,
      sessionID,
      turnID,
      admittedTurnID: null,
      phase: "connecting",
      reason: null,
      errorText: null,
      retryable: false,
      requestText: attempt.text,
      displayText: attempt.displayText,
      files,
      optimisticAppended: attempt.optimisticAppended,
      checking: false,
      statusNote: null,
    });

    const currentGeneration = () => generation === generationRef.current;
    const stale = () => generation !== generationRef.current || controller.signal.aborted;
    const updateTurn = (update: (current: TurnState) => TurnState): void => {
      setTurn((current) =>
        current === null || current.generation !== generation ? current : update(current),
      );
    };
    const advanceTo = (phase: "running" | "finalizing"): void => {
      updateTurn((current) => {
        if (terminalPhase(current.phase)) return current;
        if (phase === "running" && current.phase !== "connecting") return current;
        return { ...current, phase };
      });
    };
    const settle = (
      phase: "done" | "cancelled" | "error",
      patch: Partial<TurnState> = {},
    ): void => {
      updateTurn((current) =>
        terminalPhase(current.phase) ? current : { ...current, phase, ...patch },
      );
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const finishTools = (kind: "done" | "cancelled" | "error", endedAt = Date.now()): void => {
      setMessages((current) =>
        currentGeneration() ? finishToolMessages(current, kind, endedAt) : current,
      );
    };
    const appendTool = (event: OpenCodeStreamEvent) => {
      setMessages((current) => {
        if (!currentGeneration()) return current;
        const eventID = event.id;
        const index =
          eventID === undefined ? -1 : current.findIndex((message) => message.id === eventID);
        const existing = index >= 0 ? current[index] : undefined;
        const previous =
          existing !== undefined && existing.role === "tool"
            ? (existing as OpenCodeToolMessage)
            : undefined;
        const next = mergeToolMessage(previous, event, `tool:optimistic:${Date.now()}`);
        if (index < 0) return [...current, next];
        return [...current.slice(0, index), next, ...current.slice(index + 1)];
      });
    };

    let terminal: "done" | "cancelled" | "error" | null = null;
    let terminalUnconfirmed = false;
    let sawFinalizing = false;
    let requestSent = false;
    try {
      let payloads: readonly OpenCodeAttachmentPayload[] = [];
      if (files.length > 0) {
        payloads = await Promise.all(
          files.map((file) => attachmentPayload(file, controller.signal)),
        );
      }
      // Подготовка вложений отменяема: после каждого await и перед fetch сверяем поколение.
      if (stale()) return;

      if (!attempt.optimisticAppended) {
        const nextLocalImages: LocalImageAttachment[] = [];
        payloads.forEach((payload, index) => {
          if (attachmentKind(payload.name, payload.mime) !== "image") return;
          const file = files[index];
          if (file === undefined) return;
          const url = createObjectUrl(file);
          if (url === null) return;
          nextLocalImages.push({
            sessionID,
            userOrdinal,
            attachmentIndex: index,
            name: payload.name,
            mime: payload.mime,
            size: file.size,
            file,
            url,
          });
        });

        const userMessage: OpenCodeChatMessage = {
          id: `user:optimistic:${Date.now()}`,
          role: "user",
          text: attempt.displayText,
          ...(payloads.length === 0
            ? {}
            : {
                attachments: payloads.map((payload, index) => ({
                  name: payload.name,
                  mime: payload.mime,
                  size: files[index]?.size ?? 0,
                })),
              }),
        };
        setInput("");
        if (nextLocalImages.length > 0) {
          setLocalImages((current) => [...current, ...nextLocalImages]);
        }
        setMessages((current) => (currentGeneration() ? [...current, userMessage] : current));
        updateTurn((current) => ({ ...current, optimisticAppended: true }));
      }

      if (stale()) return;
      requestSent = true;
      const response = await fetch(
        `/api/opencode/session/${encodeURIComponent(sessionID)}/prompt`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/x-ndjson",
            "x-kanbaner-client": "ui",
          },
          body: JSON.stringify({
            text: attempt.text,
            turnID,
            ...(payloads.length === 0 ? {} : { files: payloads }),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        // HTTP-ответ до NDJSON — явное server-confirmed non-admission.
        try {
          await envelope<never>(response);
        } catch (reason) {
          if (reason instanceof ApiError) throw reason;
          throw new ApiError("Запрос OpenCode отклонён", response.status, "INTERNAL_ERROR");
        }
      }
      if (response.body === null) throw new Error("EMPTY_OPENCODE_STREAM");

      const streamReader = response.body.getReader();
      reader = streamReader;
      const decoder = new TextDecoder();
      let buffer = "";
      const processLine = (line: string): void => {
        if (line.trim().length === 0 || !currentGeneration()) return;
        const event = JSON.parse(line) as OpenCodeStreamEvent;
        if (event.kind === "connected") {
          advanceTo("running");
        } else if (event.kind === "delta") {
          advanceTo("running");
          const streamID = `streaming:${event.id ?? "default"}`;
          setMessages((current) => {
            if (!currentGeneration()) return current;
            const index = current.findIndex((message) => message.id === streamID);
            if (index >= 0) {
              const previous = current[index];
              if (previous === undefined) return current;
              return [
                ...current.slice(0, index),
                { ...previous, text: `${previous.text}${event.text ?? ""}` },
                ...current.slice(index + 1),
              ];
            }
            return [...current, { id: streamID, role: "assistant", text: event.text ?? "" }];
          });
        } else if (event.kind === "text") {
          advanceTo("running");
          const streamID = `streaming:${event.id ?? "default"}`;
          const finalID = `assistant:${event.id ?? `optimistic:${Date.now()}`}`;
          setMessages((current) => {
            if (!currentGeneration()) return current;
            const index = current.findIndex(
              (message) => message.id === streamID || message.id === finalID,
            );
            const next: OpenCodeChatMessage = {
              id: finalID,
              role: "assistant",
              text: event.text ?? "",
            };
            if (index < 0) return [...current, next];
            return [...current.slice(0, index), next, ...current.slice(index + 1)];
          });
        } else if (event.kind === "tool") {
          advanceTo("running");
          appendTool(event);
        } else if (event.kind === "admitted") {
          // Фактическая identity от Service: дальнейшая ручная проверка идёт
          // по ней, а не по client turnID.
          updateTurn((current) => ({
            ...current,
            admittedTurnID: event.id ?? current.admittedTurnID,
          }));
        } else if (event.kind === "finalizing") {
          sawFinalizing = true;
          advanceTo("finalizing");
        } else if (event.kind === "error") {
          terminal = "error";
          terminalUnconfirmed = event.reason === "unconfirmed";
          if (!terminalUnconfirmed) finishTools("error");
          settle("error", {
            reason: terminalUnconfirmed ? "unconfirmed" : null,
            errorText: event.text ?? "Запрос OpenCode завершился с ошибкой",
            // Retry только для явного server-confirmed non-admission.
            retryable:
              !terminalUnconfirmed && event.nonAdmission === true && event.retryable === true,
            statusNote: null,
          });
        } else if (event.kind === "done" || event.kind === "cancelled") {
          terminal = event.kind;
          terminalUnconfirmed = false;
          finishTools(event.kind);
          settle(event.kind, {
            reason: null,
            errorText: null,
            retryable: false,
            statusNote: null,
          });
        }
      };

      for (;;) {
        const { done, value } = await streamReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer.length > 0) processLine(buffer);
      if (terminal === null) {
        if (!sawFinalizing) throw new Error("INCOMPLETE_OPENCODE_STREAM");
        // Поток оборвался после «Завершаем»: результат не подтверждён, streamed
        // текст сохраняется, автоматический canonical refresh запрещён.
        settle("error", {
          reason: "unconfirmed",
          errorText: "Не удалось подтвердить результат OpenCode",
          retryable: false,
          statusNote: null,
        });
        return;
      }
      if (currentGeneration()) {
        if (terminal === "done") {
          setAttachedRef(null);
          clearFiles();
          // Canonical replacement допустим только для подтверждённого done.
          refreshSession(sessionID, generation);
        }
      }
    } catch (reason) {
      const stoppedByUser = controller.signal.aborted;
      if (reader !== null) await reader.cancel().catch(() => undefined);
      if (!stoppedByUser) controller.abort();
      if (currentGeneration()) {
        if (stoppedByUser) {
          finishTools("cancelled");
          settle("cancelled", {
            reason: null,
            errorText: null,
            retryable: false,
            statusNote: null,
          });
        } else if (reason instanceof ApiError) {
          // HTTP-ответ до NDJSON — единственное явное server-confirmed
          // non-admission. Повтор разрешён только для 408/429/5xx.
          settle("error", {
            reason: null,
            errorText: reason.message,
            retryable: retryableResponseStatus(reason.status),
            statusNote: null,
          });
        } else if (!requestSent) {
          // Запрос даже не отправлен: безопасно повторить.
          settle("error", {
            reason: null,
            errorText: publicError(reason, "Запрос OpenCode завершился с ошибкой"),
            retryable: true,
            statusNote: null,
          });
        } else {
          // fetch() rejected, пустой body или сбой после отправки: браузер не
          // доказывает non-admission, сервер мог принять prompt. Retry запрещён.
          settle("error", {
            reason: "unconfirmed",
            errorText: "Не удалось подтвердить результат OpenCode",
            retryable: false,
            statusNote: null,
          });
        }
      }
    } finally {
      if (reader !== null) {
        try {
          reader.releaseLock();
        } catch {
          // Lock уже освобождён отменой или закрытием потока.
        }
      }
      if (promptAbortRef.current === controller) promptAbortRef.current = null;
      if (currentGeneration()) setPromptPending(false);
    }
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text.length === 0 || session === null || busy) return;
    const context = attachedRef === currentRef ? attachedRef : null;
    await runPrompt({
      text: context === null ? text : `Контекст: ${context}\n\n${text}`,
      displayText: text,
      files: pendingFiles,
      turnID: createTurnID(),
      optimisticAppended: false,
    });
  };

  const retryTurn = (): void => {
    if (turn === null || busy || turn.generation !== generationRef.current || !turn.retryable) {
      return;
    }
    void runPrompt({
      text: turn.requestText,
      displayText: turn.displayText,
      files: turn.files,
      // Повтор — это тот же turn: сохраняем identity, чтобы canonical lookup
      // нашёл именно его.
      turnID: turn.turnID,
      optimisticAppended: turn.optimisticAppended,
    });
  };

  const checkTurnStatus = async (): Promise<void> => {
    if (turn === null || busy || turn.checking || turn.generation !== generationRef.current) return;
    const generation = turn.generation;
    const sessionID = turn.sessionID;
    const turnID = turn.admittedTurnID ?? turn.turnID;
    const controller = new AbortController();
    refreshControllersRef.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    setTurn((current) =>
      current !== null && current.generation === generation
        ? { ...current, checking: true, statusNote: null }
        : current,
    );
    try {
      const status = await request<OpenCodeTurnStatus>(
        `/api/opencode/session/${encodeURIComponent(sessionID)}?turnID=${encodeURIComponent(turnID)}`,
        { signal: controller.signal },
      );
      if (generation !== generationRef.current) return;
      if (status.outcome === "pending" || status.outcome === "missing") {
        // Canonical outcome ещё не терминален: streamed-сообщения не трогаем.
        setTurn((current) =>
          current !== null && current.generation === generation
            ? {
                ...current,
                checking: false,
                statusNote:
                  status.outcome === "missing"
                    ? "Ход не найден в истории OpenCode. Результат не подтверждён."
                    : "Результат пока не подтверждён. Проверьте ещё раз позже.",
              }
            : current,
        );
        return;
      }
      if (status.outcome === "done") {
        // Полный terminal ответ: только здесь допустима canonical замена.
        applySession(status.session, generation);
      } else {
        // Canonical cancelled/error подтверждён сервером: завершаем running
        // tools, чтобы таймер не продолжал расти после terminal.
        setMessages((current) =>
          generation === generationRef.current
            ? finishToolMessages(
                current,
                status.outcome === "cancelled" ? "cancelled" : "error",
                Date.now(),
              )
            : current,
        );
      }
      setTurn((current) =>
        current !== null && current.generation === generation
          ? {
              ...current,
              checking: false,
              phase:
                status.outcome === "done"
                  ? "done"
                  : status.outcome === "cancelled"
                    ? "cancelled"
                    : "error",
              reason: null,
              errorText: status.outcome === "error" ? "OpenCode сообщил об ошибке" : null,
              retryable: false,
              statusNote: null,
            }
          : current,
      );
    } catch (reason) {
      if (generation !== generationRef.current) return;
      setTurn((current) =>
        current !== null && current.generation === generation
          ? {
              ...current,
              checking: false,
              statusNote: `Не удалось проверить статус: ${publicError(
                reason,
                "OpenCode недоступен",
              )}`,
            }
          : current,
      );
    } finally {
      window.clearTimeout(timeout);
      refreshControllersRef.current.delete(controller);
    }
  };

  const newChat = async () => {
    if (catalog === null || busy) return;
    const generation = beginOperation();
    const controller = new AbortController();
    initializeAbortRef.current = controller;
    setCreating(true);
    setAttachedRef(null);
    clearFiles();
    setPanelError(null);
    try {
      await createSession(selectedModel ?? undefined, generation, controller.signal);
    } catch (reason) {
      if (
        generation === generationRef.current &&
        !(reason instanceof Error && reason.name === "AbortError")
      ) {
        setPanelError(publicError(reason, "Не удалось создать сессию"));
      }
    } finally {
      if (initializeAbortRef.current === controller) initializeAbortRef.current = null;
      if (generation === generationRef.current) setCreating(false);
    }
  };

  const visibleTurn =
    turn !== null && turn.generation === generationRef.current && turn.sessionID === session?.id
      ? turn
      : null;

  return (
    <section
      aria-label="Чат с OpenCode"
      data-testid="opencode-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bot aria-hidden="true" className="size-4 shrink-0" />
          <h2 className="truncate text-sm font-semibold">OpenCode</h2>
        </div>
        <button
          type="button"
          aria-label="Новая сессия OpenCode"
          title="Новая сессия"
          onClick={() => void newChat()}
          disabled={busy || catalog === null}
          className={buttonClass}
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </header>

      {catalog !== null ? <ToolCatalog tools={catalog.tools} /> : null}

      <details className="border-b px-3 py-2 text-xs">
        <summary className="flex min-w-0 cursor-pointer select-none items-center gap-1.5 font-medium">
          <Bot aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="shrink-0">Модель</span>
          <span
            className="min-w-0 flex-1 truncate font-normal text-muted-foreground"
            title={selectedModelLabel}
          >
            {selectedModelLabel}
          </span>
        </summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            Модель
            <select
              aria-label="Модель OpenCode"
              title={selectedModelName}
              className={`${inputClass} w-full min-w-0`}
              value={selectedModel?.id ?? ""}
              disabled={models.length === 0 || busy}
              onChange={(event) => {
                const next = models.find((model) => model.id === event.target.value);
                if (next !== undefined) void switchModel(selection(next, selectedModel));
              }}
            >
              {models.length === 0 ? <option value="">Нет моделей</option> : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex min-w-0 items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Провайдер
              <select
                aria-label="Провайдер OpenCode"
                className={`${inputClass} w-full min-w-0`}
                value={selectedModel?.providerID ?? ""}
                disabled={catalog === null || busy}
                onChange={(event) => {
                  const next = catalog?.models.find(
                    (model) => model.providerID === event.target.value,
                  );
                  if (next !== undefined) void switchModel(selection(next, selectedModel));
                }}
              >
                {catalog === null || catalog.providers.length === 0 ? (
                  <option value="">Нет провайдеров</option>
                ) : null}
                {catalog?.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            {variants.length > 0 ? (
              <label
                className="flex shrink-0 flex-col gap-1 text-xs text-muted-foreground"
                style={{ width: "6.5rem" }}
              >
                Вариант
                <select
                  aria-label="Вариант модели OpenCode"
                  className={`${inputClass} w-full min-w-0`}
                  value={selectedModel?.variant ?? variants[0]}
                  disabled={busy}
                  onChange={(event) => {
                    if (selectedModel !== null) {
                      void switchModel({ ...selectedModel, variant: event.target.value });
                    }
                  }}
                >
                  {variants.map((variant) => (
                    <option key={variant} value={variant}>
                      {variant}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>
      </details>

      <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {loading ? <p className="text-sm text-muted-foreground">Подключаем OpenCode…</p> : null}
        {!loading && creating ? (
          <p className="text-sm text-muted-foreground">Создаём сессию…</p>
        ) : null}
        {panelError !== null ? (
          <div
            role="alert"
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <div className="flex items-center justify-between gap-2">
              <span>{panelError}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void initialize()}
                className={buttonClass}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" /> Повторить
              </button>
            </div>
          </div>
        ) : null}
        {!loading && !creating && messages.length === 0 && panelError === null ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <Sparkles aria-hidden="true" className="size-6" />
            <p>Спросите о задачах, заметках или попросите изменить их.</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-3">
          {messages.map((message, index) => {
            const canonicalID = canonicalUserMessageID(message);
            const toolMessage = message.role === "tool" ? message : null;
            return (
              <article
                key={messageKey(message, index)}
                className={
                  toolMessage !== null
                    ? "min-w-0"
                    : `rounded-lg px-3 py-2 text-sm ${message.role === "user" ? "ml-6 bg-primary text-primary-foreground" : "mr-4 bg-muted/60"}`
                }
              >
                {toolMessage !== null ? <ToolCallMessage message={toolMessage} /> : null}
                {message.role === "user" &&
                message.attachments !== undefined &&
                message.attachments.length > 0 ? (
                  <ul aria-label="Вложения сообщения" className="mb-1 flex flex-wrap gap-1">
                    {message.attachments.map((attachment, attachmentIndex) => {
                      const local =
                        attachmentKind(attachment.name, attachment.mime) === "image"
                          ? localImageMatch(
                              localImages,
                              session?.id ?? null,
                              userOrdinals[index] ?? -1,
                              attachmentIndex,
                              attachment,
                            )
                          : null;
                      return (
                        <li
                          key={`${attachment.name}-${attachmentIndex}`}
                          className="min-w-0 max-w-full"
                        >
                          <MessageAttachmentItem
                            attachment={attachment}
                            url={local?.url ?? null}
                            sessionID={canonicalID === null ? null : (session?.id ?? null)}
                            messageID={canonicalID}
                            attachmentIndex={attachmentIndex}
                          />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {message.role === "assistant" || message.role === "system" ? (
                  <MarkdownMessage source={message.text} />
                ) : message.role === "user" ? (
                  <div className="whitespace-pre-wrap break-words">{message.text}</div>
                ) : null}
              </article>
            );
          })}
        </div>
        <div ref={messagesEndRef} />
      </div>

      {visibleTurn !== null ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="opencode-turn-status"
          className="border-t p-2 text-sm"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span
              className={
                visibleTurn.phase === "error"
                  ? "min-w-0 break-words text-destructive"
                  : "min-w-0 break-words text-muted-foreground"
              }
            >
              {visibleTurn.phase === "error" && visibleTurn.errorText !== null
                ? `${turnPhaseLabel(visibleTurn)}: ${visibleTurn.errorText}`
                : turnPhaseLabel(visibleTurn)}
            </span>
            {visibleTurn.retryable || visibleTurn.reason === "unconfirmed" ? (
              <div className="flex shrink-0 items-center gap-1">
                {visibleTurn.retryable ? (
                  <button type="button" disabled={busy} onClick={retryTurn} className={buttonClass}>
                    <RefreshCw aria-hidden="true" className="size-3.5" /> Повторить запрос
                  </button>
                ) : null}
                {visibleTurn.reason === "unconfirmed" ? (
                  <button
                    type="button"
                    disabled={busy || visibleTurn.checking}
                    onClick={() => void checkTurnStatus()}
                    className={buttonClass}
                  >
                    {visibleTurn.checking ? (
                      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw aria-hidden="true" className="size-3.5" />
                    )}
                    Проверить статус
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {visibleTurn.statusNote !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">{visibleTurn.statusNote}</p>
          ) : null}
        </div>
      ) : null}

      {currentRef !== null ? (
        <div className="border-t p-2">
          <button
            type="button"
            aria-pressed={attachedRef === currentRef}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setAttachedRef((current) => (current === currentRef ? null : currentRef));
            }}
            className={`${buttonClass} w-full justify-start`}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {attachedRef === currentRef ? "Убрать контекст" : "Прикрепить контекст"}
          </button>
        </div>
      ) : null}

      <div className="border-t p-2">
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {selectionError !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {selectionError}
            </p>
          ) : null}
          {pendingFiles.length > 0 ? (
            <ul aria-label="Выбранные файлы" className="flex max-w-full flex-wrap gap-1">
              {pendingFiles.map((file, index) => (
                <PendingAttachmentChip
                  key={`${sanitizeAttachmentName(file.name)}-${index}`}
                  file={file}
                  busy={busy}
                  onRemove={() => removeFile(index)}
                />
              ))}
            </ul>
          ) : null}
          <textarea
            aria-label="Сообщение OpenCode"
            rows={3}
            value={input}
            disabled={session === null || busy}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Напишите запрос…"
            style={{ minHeight: "104px", maxHeight: "256px", resize: "vertical" }}
            className={`${inputClass} block w-full min-w-0 leading-relaxed disabled:opacity-50`}
          />
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                aria-label="Прикрепить файлы"
                title="Файлы передаются только выбранной модели; поддержка изображений и PDF зависит от модели"
                disabled={session === null || busy}
                onClick={() => fileInputRef.current?.click()}
                className={iconButtonClass}
              >
                <Paperclip aria-hidden="true" className="size-4" />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {promptPending ? (
                <button
                  type="button"
                  aria-label="Остановить OpenCode"
                  onClick={() => promptAbortRef.current?.abort()}
                  className={iconButtonClass}
                >
                  <Square aria-hidden="true" className="size-4" />
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label="Отправить"
                  disabled={session === null || busy || input.trim().length === 0}
                  className={iconButtonClass}
                >
                  {creating || modelPending ? (
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  ) : (
                    <Send aria-hidden="true" className="size-4" />
                  )}
                </button>
              )}
            </div>
          </div>
        </form>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          aria-label="Файлы для OpenCode"
          data-testid="opencode-file-input"
          disabled={session === null || busy}
          className="sr-only"
          onChange={(event) => {
            const incoming = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            addFiles(incoming);
          }}
        />
      </div>
    </section>
  );
}

const assistantContribution = opencodeUiContributions.find(
  (contribution) => contribution.id === "kanbaner.opencode.assistant",
);
if (assistantContribution === undefined) {
  throw new Error("OpenCode assistant contribution is missing");
}

export const opencodeUiPlugin = {
  id: OPENCODE_PLUGIN_ID,
  contract: OPENCODE_UI_CONTRACT,
  contributions: [
    {
      metadata: assistantContribution,
      render: (props: OpenCodePanelProps) => <OpenCodePanel {...props} />,
    },
  ],
} as const;
