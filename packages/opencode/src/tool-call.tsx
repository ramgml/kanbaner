"use client";

import { Ban, ChevronRight, CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { OpenCodeChatMessage, OpenCodeStreamEvent } from "./types.ts";

export type OpenCodeToolMessage = Extract<OpenCodeChatMessage, { readonly role: "tool" }>;
export type OpenCodeToolStatus = OpenCodeToolMessage["status"];

const STATUS_LABELS: Record<OpenCodeToolStatus, string> = {
  running: "выполняется",
  completed: "готово",
  error: "ошибка",
  cancelled: "отменено",
};

function validTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Детерминированная длительность без locale-зависимых разделителей. */
export function formatToolDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const rounded = Math.round(durationMs);
  if (rounded < 1000) return `${rounded} мс`;
  const seconds = Math.floor(rounded / 1000);
  if (seconds < 60) return `${seconds} с`;
  return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
}

function durationBetween(
  startedAt: number | undefined,
  endedAt: number | undefined,
): number | null {
  const start = validTimestamp(startedAt);
  const end = validTimestamp(endedAt);
  if (start === undefined || end === undefined || end < start) return null;
  return end - start;
}

/**
 * Running duration тикает раз в секунду; terminal duration фиксируется по
 * endedAt. Отсутствующие, невалидные и обратные timestamps не дают фиктивную
 * длительность. Cleanup интервала безопасен в StrictMode.
 */
export function useToolDuration(
  startedAt: number | undefined,
  endedAt: number | undefined,
  running: boolean,
): string | null {
  const start = validTimestamp(startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || start === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, start]);
  const duration = running ? durationBetween(start, now) : durationBetween(start, endedAt);
  return duration === null ? null : formatToolDuration(duration);
}

function earliest(first: number | undefined, second: number | undefined): number | undefined {
  const a = validTimestamp(first);
  const b = validTimestamp(second);
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Upsert одного tool call по `assistantMessageID + tool call ID`.
 * Ранний startedAt и первый endedAt сохраняются, пустые значения не затирают
 * уже полученные input/output/text, позднее running не понижает terminal
 * status. Generation guard остаётся у вызывающего кода.
 */
export function mergeToolMessage(
  existing: OpenCodeToolMessage | undefined,
  event: OpenCodeStreamEvent,
  fallbackID: string,
): OpenCodeToolMessage {
  const existingStatus = existing?.status;
  const existingTerminal =
    existingStatus === "completed" || existingStatus === "error" || existingStatus === "cancelled";
  const incoming = event.status;
  const status =
    existingTerminal && incoming === "running"
      ? existingStatus
      : (incoming ?? existingStatus ?? "running");
  const startedAt = earliest(existing?.startedAt, event.startedAt);
  const endedAt = existing?.endedAt ?? event.endedAt;
  const input = nonEmpty(event.input) ?? existing?.input;
  const output = nonEmpty(event.output) ?? existing?.output;
  return {
    id: existing?.id ?? event.id ?? fallbackID,
    role: "tool",
    name: nonEmpty(event.name) ?? existing?.name ?? "tool",
    status,
    text: nonEmpty(event.text) ?? existing?.text ?? "",
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

/**
 * Confirmed terminal turn завершает оставшиеся running tools ТОЛЬКО этого хода,
 * чтобы таймер не рос после terminal события и не затрагивался unconfirmed tool
 * предыдущего turn. `toolIDs` — набор identity, собранный appendTool текущего
 * generation; пустой набор ничего не меняет. Для unconfirmed helper не
 * вызывается.
 */
export function finishToolMessages(
  messages: readonly OpenCodeChatMessage[],
  toolIDs: ReadonlySet<string>,
  kind: "done" | "cancelled" | "error",
  endedAt: number,
): readonly OpenCodeChatMessage[] {
  if (toolIDs.size === 0) return messages;
  let changed = false;
  const next = messages.map((message): OpenCodeChatMessage => {
    if (message.role !== "tool" || message.status !== "running" || !toolIDs.has(message.id)) {
      return message;
    }
    changed = true;
    return {
      ...message,
      status: kind === "done" ? "completed" : kind,
      ...(message.endedAt === undefined ? { endedAt } : {}),
    };
  });
  return changed ? next : messages;
}

function StatusIcon({ status }: { readonly status: OpenCodeToolStatus }) {
  if (status === "running") {
    return (
      <Loader2
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
      />
    );
  }
  if (status === "completed") {
    return <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-emerald-600" />;
  }
  if (status === "cancelled") {
    return <Ban aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />;
}

function ToolSection({
  label,
  text,
  testId,
}: {
  readonly label: string;
  readonly text: string;
  readonly testId: string;
}) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </h4>
      <pre
        data-testid={testId}
        className="max-h-48 min-w-0 max-w-full overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-xs [overflow-wrap:anywhere]"
      >
        {text}
      </pre>
    </section>
  );
}

/**
 * Компактный disclosure tool call: summary всегда показывает status, имя,
 * состояние и длительность; input/output раскрываются явным действием.
 * Native `<details>` даёт pointer/touch, а Enter/Space обрабатываются явно,
 * чтобы поведение не зависело от браузера.
 */
export function ToolCallMessage({ message }: { readonly message: OpenCodeToolMessage }) {
  const summaryRef = useRef<HTMLElement>(null);
  const duration = useToolDuration(
    message.startedAt,
    message.endedAt,
    message.status === "running",
  );
  const input = nonEmpty(message.input);
  const output = nonEmpty(message.output);
  const legacy = input === undefined && output === undefined ? nonEmpty(message.text) : undefined;

  return (
    <details
      data-testid="opencode-tool-call"
      className="group min-w-0 rounded-md border bg-muted/30"
    >
      <summary
        ref={summaryRef}
        data-testid="opencode-tool-call-summary"
        title={message.name}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          const details = summaryRef.current?.parentElement;
          if (details instanceof HTMLDetailsElement) details.open = !details.open;
        }}
        className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <StatusIcon status={message.status} />
        <code className="min-w-0 flex-1 truncate font-medium">{message.name}</code>
        <span className="shrink-0 text-muted-foreground">{STATUS_LABELS[message.status]}</span>
        {duration !== null ? (
          <span
            data-testid="opencode-tool-call-duration"
            role="timer"
            aria-live="off"
            className="shrink-0 tabular-nums text-muted-foreground"
          >
            {duration}
          </span>
        ) : null}
      </summary>
      <div className="flex min-w-0 flex-col gap-2 border-t px-2 py-2">
        {input !== undefined ? (
          <ToolSection label="Вход" text={input} testId="opencode-tool-call-input" />
        ) : null}
        {output !== undefined ? (
          <ToolSection label="Вывод" text={output} testId="opencode-tool-call-output" />
        ) : null}
        {legacy !== undefined ? (
          <ToolSection label="Вывод" text={legacy} testId="opencode-tool-call-output" />
        ) : null}
        {input === undefined && output === undefined && legacy === undefined ? (
          <p className="text-xs text-muted-foreground">Технические детали не переданы.</p>
        ) : null}
      </div>
    </details>
  );
}
