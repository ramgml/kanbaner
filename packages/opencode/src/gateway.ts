import { randomUUID } from "node:crypto";
import path from "node:path";

import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import { Service } from "@opencode/client/service";

import { ATTACHMENT_LIMITS } from "./attachments.ts";
import { OPENCODE_AGENT_ID } from "./metadata.ts";
import { OPENCODE_CATALOG_TOOLS } from "./tool-metadata.ts";
import {
  isOpenCodeAdmittedTurnID,
  isRecord,
  isOpenCodeTurnID,
  OpenCodeGatewayError,
  stringField,
  truncated,
  type OpenCodeAttachmentPreview,
  type OpenCodeChatMessage,
  type OpenCodeGateway,
  type OpenCodeModelRefView,
  type OpenCodeSessionView,
} from "./types.ts";

function defaultProjectDirectory(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === "web" && path.basename(path.dirname(cwd)) === "apps"
    ? path.resolve(cwd, "../..")
    : cwd;
}

const PROJECT_DIRECTORY = process.env.KANBANER_PROJECT_DIR
  ? path.resolve(process.env.KANBANER_PROJECT_DIR)
  : defaultProjectDirectory();
const LOCATION = { directory: PROJECT_DIRECTORY } as const;
const TERMINAL_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);
const UNCONFIRMED_TEXT = "Не удалось подтвердить результат OpenCode";
const UNCONFIRMED_FIELD = "kanbanerUnconfirmed";
const FINALIZING_TYPE = "session.execution.finalizing";
const ADMITTED_TYPE = "kanbaner.turn.admitted";
const CANONICAL_ATTEMPTS = 3;
const CANONICAL_DELAY_MS = 50;
const CANONICAL_DEADLINE_MS = 600;

function dataField(data: unknown, key: string): unknown {
  return isRecord(data) && key in data ? data[key] : undefined;
}

function modelRef(value: unknown): OpenCodeModelRefView | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.modelID) ?? stringField(value.id);
  const providerID = stringField(value.providerID);
  if (id === undefined || providerID === undefined) return null;
  const variant = stringField(value.variant);
  return { id, providerID, ...(variant === undefined ? {} : { variant }) };
}

function eventSessionID(event: OpenCodeEvent): string | undefined {
  return stringField(dataField(event.data, "sessionID"));
}

function serialized(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : truncated(text);
}

/**
 * Tool timestamps приходят как epoch milliseconds. Поддерживается и ISO-строка
 * для старых payloads; невалидное значение отбрасывается, чтобы UI не
 * показывал фиктивную длительность.
 */
function timestampField(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function stateTime(state: Record<string, unknown>): Record<string, unknown> {
  return isRecord(state.time) ? state.time : {};
}

/**
 * Canonical timestamps новой history: `ran ?? created` и `completed`.
 * Fallback v1: `state.time.start/end`. Значения не синтезируются.
 */
function toolTiming(part: Record<string, unknown>): {
  startedAt?: number;
  endedAt?: number;
} {
  const time = isRecord(part.time) ? part.time : {};
  const state = isRecord(part.state) ? part.state : {};
  const fallback = stateTime(state);
  const startedAt =
    timestampField(time.ran) ?? timestampField(time.created) ?? timestampField(fallback.start);
  const endedAt = timestampField(time.completed) ?? timestampField(fallback.end);
  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined || (startedAt !== undefined && endedAt < startedAt)
      ? {}
      : { endedAt }),
  };
}

/** Canonical tool error с машинным `type=aborted` — это отмена, а не ошибка. */
function toolErrorAborted(state: Record<string, unknown>): boolean {
  return isRecord(state.error) && stringField(state.error.type) === "aborted";
}

function toolStatus(
  state: Record<string, unknown>,
): "running" | "completed" | "error" | "cancelled" {
  if (state.status === "completed") return "completed";
  if (state.status === "cancelled") return "cancelled";
  if (state.status === "error") {
    return toolErrorAborted(state) ? "cancelled" : "error";
  }
  return "running";
}

/** Input инструмента: допускается уже сериализованная строка или JSON value. */
function toolInput(state: Record<string, unknown>): string | undefined {
  const input = state.input;
  if (typeof input === "string") return input.length === 0 ? undefined : truncated(input);
  if (input === undefined) return undefined;
  return serialized(input);
}

/** Вывод инструмента: content, v1 `state.output` или generic error без upstream-текста. */
function toolOutput(state: Record<string, unknown>): string | undefined {
  if (Array.isArray(state.content) && state.content.length > 0) {
    const text = state.content
      .map((item) => {
        if (!isRecord(item)) return "";
        if (typeof item.text === "string") return item.text;
        if (typeof item.name === "string") return item.name;
        return JSON.stringify(item);
      })
      .filter((item) => item.length > 0)
      .join("\n");
    return text.length === 0 ? undefined : truncated(text);
  }
  if (typeof state.output === "string" && state.output.length > 0) {
    return truncated(state.output);
  }
  if (state.output !== undefined) return serialized(state.output);
  // Aborted tool не должен получать противоречащую generic error-подпись.
  if (toolErrorAborted(state)) return undefined;
  // v2 error — record, v1 error — строка; upstream-текст наружу не попадает.
  if (isRecord(state.error) || stringField(state.error) !== undefined) {
    return "Инструмент завершился с ошибкой";
  }
  return undefined;
}

function toolText(state: unknown): string {
  if (!isRecord(state)) return "";
  if (Array.isArray(state.content) && state.content.length > 0) {
    return truncated(
      state.content
        .map((item) => {
          if (!isRecord(item)) return "";
          if (typeof item.text === "string") return item.text;
          if (typeof item.name === "string") return item.name;
          return JSON.stringify(item);
        })
        .filter((text) => text.length > 0)
        .join("\n"),
    );
  }
  if (toolErrorAborted(state)) return "";
  if (isRecord(state.error) || stringField(state.error) !== undefined) {
    return "Инструмент завершился с ошибкой";
  }
  if (state.input !== undefined) return serialized(state.input);
  return "";
}

function messageViews(
  message: unknown,
  errorAssistantID?: string,
  idleErrorID?: string,
): OpenCodeChatMessage[] {
  if (!isRecord(message) || typeof message.id !== "string") return [];
  if (message.type === "user") {
    const files = Array.isArray(message.files) ? message.files : [];
    const attachments = files.flatMap((file, index) => {
      if (!isRecord(file)) return [];
      return [
        {
          name: stringField(file.name) ?? `Вложение ${index + 1}`,
          mime: stringField(file.mime) ?? "application/octet-stream",
        },
      ];
    });
    return [
      {
        id: `user:${message.id}`,
        role: "user",
        text: typeof message.text === "string" ? truncated(message.text) : "",
        ...(attachments.length === 0 ? {} : { attachments }),
      },
    ];
  }
  if (message.type === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    const views = content.flatMap((part, index): OpenCodeChatMessage[] => {
      if (!isRecord(part) || typeof part.type !== "string") return [];
      if (part.type === "text" && typeof part.text === "string") {
        const partID = stringField(part.id) ?? String(index);
        return [
          {
            id: `assistant:${message.id}:${partID}`,
            role: "assistant",
            text: truncated(part.text),
          },
        ];
      }
      if (part.type === "tool") {
        const state = isRecord(part.state) ? part.state : {};
        const input = toolInput(state);
        const output = toolOutput(state);
        const timing = toolTiming(part);
        // v1 ToolPart содержит и PartID `id`, и tool call identity `callID`;
        // публичный ID строится из callID. v2 callID не отдаёт, поэтому его
        // поведение остаётся прежним (`id`, затем index). Text part выше
        // по-прежнему использует PartID.
        const partID = stringField(part.callID) ?? stringField(part.id) ?? String(index);
        return [
          {
            id: `tool:${message.id}:${partID}`,
            role: "tool",
            name: stringField(part.name) ?? stringField(part.tool) ?? "tool",
            status: toolStatus(state),
            text: toolText(state),
            ...timing,
            ...(input === undefined ? {} : { input }),
            ...(output === undefined ? {} : { output }),
          },
        ];
      }
      return [];
    });
    if (message.id === errorAssistantID) {
      views.push({
        id: `error:${message.id}`,
        role: "system",
        text: "Ответ OpenCode завершился с ошибкой",
      });
    }
    return views;
  }
  if (message.type === "system" || message.type === "synthetic" || message.type === "compaction") {
    const text = [message.text, message.summary, message.message].find(
      (candidate): candidate is string => typeof candidate === "string",
    );
    const fallback = message.type === "compaction" ? "Контекст OpenCode был сжат" : "";
    return [
      {
        id: `system:${message.id}`,
        role: "system",
        text: truncated(text ?? fallback),
      },
    ];
  }
  if (message.type === "idle" && message.id === idleErrorID) {
    return [
      {
        id: `error:${message.id}`,
        role: "system",
        text: "Сессия OpenCode завершилась с ошибкой",
      },
    ];
  }
  return [];
}

function lastUserIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.type === "user") return index;
  }
  return -1;
}

/**
 * System error исторического assistant показывается только для последнего
 * assistant последнего user-turn. Позиция считается по raw messages, не по
 * тексту: ошибка прошлого turn не воскресает после нового успешного ответа.
 */
function currentErrorAssistantID(messages: readonly unknown[]): string | undefined {
  const boundary = lastUserIndex(messages);
  for (let index = messages.length - 1; index > boundary; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.type !== "assistant") continue;
    return typeof message.id === "string" && isRecord(message.error) ? message.id : undefined;
  }
  return undefined;
}

/**
 * Idle-ошибка показывается только внутри последнего turn и только если после
 * неё нет более позднего assistant. Так старый idle не воскресает ни после
 * нового user-message, ни после нового успешного ответа.
 */
function currentIdleErrorID(messages: readonly unknown[]): string | undefined {
  const boundary = lastUserIndex(messages);
  for (let index = messages.length - 1; index > boundary; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message.type === "assistant") return undefined;
    if (message.type === "idle" && isRecord(message.error) && typeof message.id === "string") {
      return message.id;
    }
  }
  return undefined;
}

function messagesView(messages: readonly unknown[]): OpenCodeChatMessage[] {
  const errorAssistantID = currentErrorAssistantID(messages);
  const idleErrorID = currentIdleErrorID(messages);
  return messages.flatMap((message) => messageViews(message, errorAssistantID, idleErrorID));
}

function sessionView(info: unknown, messages: readonly unknown[]): OpenCodeSessionView {
  if (!isRecord(info) || typeof info.id !== "string") {
    throw new OpenCodeGatewayError("DEPENDENCY_UNAVAILABLE", "OpenCode вернул некорректную сессию");
  }
  return {
    id: info.id,
    title: stringField(info.title) ?? null,
    agent: stringField(info.agent) ?? null,
    model: modelRef(info.model),
    messages: messagesView(messages),
  };
}

function eventToolID(data: Record<string, unknown>): string | undefined {
  const id = stringField(dataField(data, "id"));
  if (id === undefined) return undefined;
  return `${stringField(dataField(data, "assistantMessageID")) ?? "session"}:${id}`;
}

/** Stream tool error: `type=aborted` — машинный признак отмены. */
function eventToolErrorAborted(data: Record<string, unknown>): boolean {
  const error = dataField(data, "error");
  return isRecord(error) && stringField(error.type) === "aborted";
}

function eventTextID(data: Record<string, unknown>): string | undefined {
  const messageID = stringField(dataField(data, "assistantMessageID"));
  if (messageID === undefined) return undefined;
  const ordinal = dataField(data, "ordinal");
  return `${messageID}:${typeof ordinal === "number" ? ordinal : 0}`;
}

export function streamEvent(event: OpenCodeEvent) {
  const data = isRecord(event.data) ? event.data : {};
  const createdAt = timestampField(dataField(event, "created"));
  const timingStart = createdAt === undefined ? {} : { startedAt: createdAt };
  const timingEnd = createdAt === undefined ? {} : { endedAt: createdAt };
  // Синтетическое событие gateway перед canonical lookup, не terminal.
  if ((event.type as string) === FINALIZING_TYPE) return { kind: "finalizing" as const };
  // Синтетическое событие только при подмене admitted ID Service-ом.
  if ((event.type as string) === ADMITTED_TYPE) {
    const id = stringField(dataField(data, "turnID"));
    return { kind: "admitted" as const, ...(id === undefined ? {} : { id }) };
  }
  switch (event.type) {
    case "server.connected":
      return { kind: "connected" as const };
    case "session.text.delta": {
      const id = eventTextID(data);
      return {
        kind: "delta" as const,
        ...(id === undefined ? {} : { id }),
        text: stringField(dataField(data, "delta")) ?? "",
      };
    }
    case "session.text.ended": {
      const id = eventTextID(data);
      return {
        kind: "text" as const,
        ...(id === undefined ? {} : { id }),
        text: stringField(dataField(data, "text")) ?? "",
      };
    }
    case "session.tool.input.started": {
      const id = eventToolID(data);
      return {
        kind: "tool" as const,
        ...(id === undefined ? {} : { id }),
        name: stringField(dataField(data, "name")) ?? "tool",
        status: "running" as const,
        text: "",
        ...timingStart,
      };
    }
    case "session.tool.called": {
      const id = eventToolID(data);
      const inputValue = dataField(data, "input");
      const input = inputValue === undefined ? undefined : serialized(inputValue);
      return {
        kind: "tool" as const,
        ...(id === undefined ? {} : { id }),
        status: "running" as const,
        text: input === undefined ? "" : input,
        ...timingStart,
        ...(input === undefined ? {} : { input }),
      };
    }
    case "session.tool.success": {
      const id = eventToolID(data);
      const output = toolOutput(data);
      return {
        kind: "tool" as const,
        ...(id === undefined ? {} : { id }),
        status: "completed" as const,
        text: toolText(data),
        ...timingEnd,
        ...(output === undefined ? {} : { output }),
      };
    }
    case "session.tool.failed": {
      const id = eventToolID(data);
      const inputValue = dataField(data, "input");
      const input = inputValue === undefined ? undefined : serialized(inputValue);
      const aborted = eventToolErrorAborted(data);
      // Streaming aborted нормализуется в cancelled, как canonical history;
      // generic error-подпись и output для отмены не выставляются.
      const output = aborted ? undefined : toolOutput(data);
      return {
        kind: "tool" as const,
        ...(id === undefined ? {} : { id }),
        status: aborted ? ("cancelled" as const) : ("error" as const),
        text: aborted ? "" : toolText(data),
        ...timingEnd,
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
      };
    }
    case "session.execution.succeeded":
      return { kind: "done" as const };
    case "session.execution.failed": {
      const unconfirmed = dataField(data, UNCONFIRMED_FIELD) === true;
      return {
        kind: "error" as const,
        text: unconfirmed ? UNCONFIRMED_TEXT : "Запрос OpenCode завершился с ошибкой",
        ...(unconfirmed ? { reason: "unconfirmed" as const } : {}),
      };
    }
    case "session.execution.interrupted":
    case "session.inbox.cancelled":
      return { kind: "cancelled" as const, text: "Запрос остановлен" };
    default:
      return null;
  }
}

function gatewayError(error: unknown): OpenCodeGatewayError {
  if (error instanceof OpenCodeGatewayError) return error;
  if (isRecord(error)) {
    const status =
      typeof error.status === "number"
        ? error.status
        : typeof error.statusCode === "number"
          ? error.statusCode
          : undefined;
    const tag = stringField(error._tag) ?? stringField(error.code) ?? "";
    if (status === 404 || /not.?found/iu.test(tag)) {
      return new OpenCodeGatewayError("NOT_FOUND", "Сессия OpenCode не найдена");
    }
    if (
      status === 400 ||
      status === 413 ||
      status === 415 ||
      status === 422 ||
      /invalid.?request|validation/iu.test(tag)
    ) {
      return new OpenCodeGatewayError("VALIDATION_ERROR", "OpenCode отклонил аргументы запроса");
    }
  }
  return new OpenCodeGatewayError("DEPENDENCY_UNAVAILABLE", "OpenCode Service недоступен");
}

async function translated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw gatewayError(error);
  }
}

async function ownedSession(client: OpenCodeClient, sessionID: string): Promise<unknown> {
  const info = await translated(() => client.session.get({ sessionID }));
  if (
    !isRecord(info) ||
    !isRecord(info.metadata) ||
    info.metadata.source !== "kanbaner" ||
    info.agent !== OPENCODE_AGENT_ID
  ) {
    throw new OpenCodeGatewayError("NOT_FOUND", "Сессия OpenCode не найдена");
  }
  return info;
}

async function allMessages(
  client: OpenCodeClient,
  sessionID: string,
  signal?: AbortSignal,
): Promise<readonly unknown[]> {
  const messages: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    if (signal?.aborted === true) {
      throw new OpenCodeGatewayError("DEPENDENCY_UNAVAILABLE", "OpenCode Service недоступен");
    }
    const input =
      cursor === undefined
        ? { sessionID, order: "asc" as const, limit: 200 }
        : { sessionID, cursor, limit: 200 };
    const page = await translated(() =>
      signal === undefined ? client.message.list(input) : client.message.list(input, { signal }),
    );
    messages.push(...page.data);
    const next = stringField(page.cursor.next);
    if (next === undefined || cursors.has(next)) return messages;
    cursors.add(next);
    cursor = next;
  }
}

type CanonicalOutcome = "done" | "error" | "cancelled" | "pending" | "missing";

/** Активный/scheduled retry: canonical assistant ещё не терминален даже при error. */
function hasScheduledRetry(message: Record<string, unknown>): boolean {
  const retry = message.retry;
  return isRecord(retry) && (typeof retry.attempt === "number" || retry.at !== undefined);
}

function assistantOutcome(assistant: Record<string, unknown>): CanonicalOutcome {
  if (hasScheduledRetry(assistant)) return "pending";
  if (isRecord(assistant.error)) {
    return stringField(assistant.error.type) === "aborted" ? "cancelled" : "error";
  }
  const time = isRecord(assistant.time) ? assistant.time : {};
  const completed = typeof time.completed === "number" && Number.isFinite(time.completed);
  if (!completed) return "pending";
  const finish = stringField(assistant.finish);
  // tool-calls означает, что turn продолжится следующим assistant после tools.
  if (finish === "tool-calls") return "pending";
  if (finish === "error") return "error";
  return "done";
}

/**
 * Outcome текущего prompt по canonical history. Turn ограничен точным
 * `type=user && id===inboxID` и следующим user-message; upstream event data
 * (execution/inbox) не используется. `error.type` — машинный признак,
 * `error.message` наружу не попадает.
 */
function canonicalOutcome(messages: readonly unknown[], inboxID: string): CanonicalOutcome {
  let userIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isRecord(message) && message.type === "user" && message.id === inboxID) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return "missing";

  let lastAssistantIndex = -1;
  let lastAssistant: Record<string, unknown> | undefined;
  let lastIdleIndex = -1;
  let lastIdle: Record<string, unknown> | undefined;
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message.type === "user") break;
    if (message.type === "assistant") {
      lastAssistantIndex = index;
      lastAssistant = message;
    }
    if (message.type === "idle") {
      lastIdleIndex = index;
      lastIdle = message;
    }
  }

  // Idle после последнего assistant — более поздний terminal record и
  // перекрывает assistant (включая stale retry/completed). Idle до более
  // позднего assistant trailing не является.
  if (lastIdle !== undefined && lastIdleIndex > lastAssistantIndex) {
    const idleOutcome = stringField(lastIdle.outcome);
    const idleError = isRecord(lastIdle.error) ? lastIdle.error : undefined;
    if (idleOutcome === "interrupted") return "cancelled";
    if (idleOutcome === "failed" || idleError !== undefined) {
      return stringField(idleError?.type) === "aborted" ? "cancelled" : "error";
    }
    if (idleOutcome === "succeeded") {
      // Успешный idle подтверждает done только вместе с завершённым assistant.
      return lastAssistant !== undefined && assistantOutcome(lastAssistant) === "done"
        ? "done"
        : "pending";
    }
    return "pending";
  }

  if (lastAssistant === undefined) return "pending";
  return assistantOutcome(lastAssistant);
}

/**
 * Синтетическое событие «Завершаем»: выпускается ровно один раз перед
 * canonical lookup. Не terminal и не подтверждает результат.
 */
function finalizingEvent(sessionID: string): OpenCodeEvent {
  return {
    id: `kanbaner-${randomUUID()}`,
    created: Date.now(),
    type: FINALIZING_TYPE,
    data: { sessionID },
  } as unknown as OpenCodeEvent;
}

/**
 * Service мог вернуть собственный admitted inbox ID вместо client turn ID.
 * Событие сообщает UI фактическую identity, чтобы ручная проверка не искала
 * несуществующий turn.
 */
function admittedEvent(sessionID: string, turnID: string): OpenCodeEvent {
  return {
    id: `kanbaner-${randomUUID()}`,
    created: Date.now(),
    type: ADMITTED_TYPE,
    data: { sessionID, turnID },
  } as unknown as OpenCodeEvent;
}

/** Terminal событие для NDJSON-контракта: только sessionID, без upstream data. */
function terminalEvent(outcome: "done" | "error" | "cancelled", sessionID: string): OpenCodeEvent {
  return {
    id: `kanbaner-${randomUUID()}`,
    created: Date.now(),
    type:
      outcome === "done"
        ? "session.execution.succeeded"
        : outcome === "error"
          ? "session.execution.failed"
          : "session.execution.interrupted",
    data: { sessionID },
  } as unknown as OpenCodeEvent;
}

/** Безопасный terminal error, когда canonical outcome подтвердить не удалось. */
function unconfirmedEvent(sessionID: string): OpenCodeEvent {
  return {
    id: `kanbaner-${randomUUID()}`,
    created: Date.now(),
    type: "session.execution.failed",
    data: { sessionID, [UNCONFIRMED_FIELD]: true },
  } as unknown as OpenCodeEvent;
}

const PREVIEW_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Канонический Base64 без padding внутри и без переносов строк. */
function canonicalBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function hasBytes(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function imageSignatureMatches(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png")
    return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === "image/jpeg") return hasBytes(bytes, [0xff, 0xd8, 0xff]);
  if (mime === "image/gif") {
    const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (mime === "image/webp") {
    return (
      Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
    );
  }
  return false;
}

/**
 * Preview читается только из canonical inline user-message: raw Base64 в
 * `file.data`, MIME в `file.mime`, `file.source.type === "inline"`.
 * Media-ref, URL, server paths, несовпадающий MIME и невалидный Base64
 * трактуются как отсутствующее вложение, чтобы не раскрывать содержимое.
 */
function attachmentPreview(message: unknown, attachmentIndex: number): OpenCodeAttachmentPreview {
  const missing = new OpenCodeGatewayError("NOT_FOUND", "Вложение OpenCode не найдено");
  if (!isRecord(message) || message.type !== "user") throw missing;
  const files = Array.isArray(message.files) ? message.files : [];
  const file = files[attachmentIndex];
  if (!isRecord(file)) throw missing;

  const source = file.source;
  if (!isRecord(source) || source.type !== "inline") throw missing;
  const mime = stringField(file.mime)?.trim().toLowerCase();
  if (mime === undefined || !PREVIEW_IMAGE_MIMES.has(mime)) throw missing;
  const encoded = typeof file.data === "string" ? file.data : null;
  if (encoded === null) throw missing;

  const bytes = canonicalBase64(encoded);
  if (bytes === null || bytes.length > ATTACHMENT_LIMITS.maxMediaBytes) {
    throw missing;
  }
  if (!imageSignatureMatches(bytes, mime)) throw missing;

  return {
    name: stringField(file.name)?.trim() || `Вложение ${attachmentIndex + 1}`,
    mime,
    bytes,
  };
}

export function createOpenCodeGateway(client: OpenCodeClient): OpenCodeGateway {
  /**
   * Client turn ID → фактический admitted inbox ID. Нужен, если Service
   * заменил ID: ручная проверка не должна молча искать несуществующий turn.
   * Размер ограничен, чтобы карта не росла бесконечно.
   */
  const turnAliases = new Map<string, string>();
  const turnKey = (sessionID: string, turnID: string): string => `${sessionID}\u0000${turnID}`;
  const rememberTurnAlias = (sessionID: string, requested: string, admitted: string): void => {
    if (requested === admitted) return;
    turnAliases.set(turnKey(sessionID, requested), admitted);
    if (turnAliases.size > 256) {
      const oldest = turnAliases.keys().next().value;
      if (oldest !== undefined) turnAliases.delete(oldest);
    }
  };
  return {
    status: () =>
      translated(async () => {
        const info = await client.server.info();
        return { available: true as const, version: info.version };
      }),

    catalog: () =>
      translated(async () => {
        const [providers, models, agents, defaultModel] = await Promise.all([
          client.provider.list({ location: LOCATION }),
          client.model.list({ location: LOCATION, types: ["chat"] }),
          client.agent.list({ location: LOCATION }),
          client.model.default({ location: LOCATION }),
        ]);
        const activeModels = models.data
          .filter((model) => model.enabled && model.status === "active")
          .map((model) => ({
            id: model.modelID,
            providerID: model.providerID,
            name: model.name,
            type: model.type ?? "chat",
            variants: model.variants.map((variant) => variant.id),
          }));
        const providerIDs = new Set(activeModels.map((model) => model.providerID));

        return {
          providers: providers.data
            .filter((provider) => providerIDs.has(provider.id))
            .map((provider) => ({
              id: provider.id,
              name: provider.name,
              activation: provider.activation,
            })),
          models: activeModels,
          agents: agents.data
            .filter(
              (agent) =>
                agent.id === OPENCODE_AGENT_ID && !agent.hidden && agent.mode !== "subagent",
            )
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              description: agent.description ?? null,
            })),
          tools: OPENCODE_CATALOG_TOOLS,
          defaultModel: modelRef(defaultModel.data),
        };
      }),

    createSession: (input = {}) =>
      translated(async () => {
        if (input.agent !== undefined && input.agent !== OPENCODE_AGENT_ID) {
          throw new OpenCodeGatewayError("VALIDATION_ERROR", "Разрешён только агент kanbaner");
        }
        const created = await client.session.create({
          title: "Kanbaner chat",
          agent: OPENCODE_AGENT_ID,
          location: LOCATION,
          metadata: { source: "kanbaner" },
          ...(input.model === undefined ? {} : { model: input.model }),
        });
        return sessionView(created, []);
      }),

    getSession: (sessionID) =>
      translated(async () => {
        const info = await ownedSession(client, sessionID);
        return sessionView(info, await allMessages(client, sessionID));
      }),

    getTurnStatus: (sessionID, turnID) =>
      translated(async () => {
        if (!isOpenCodeAdmittedTurnID(turnID)) {
          throw new OpenCodeGatewayError("VALIDATION_ERROR", "Некорректный идентификатор хода");
        }
        const info = await ownedSession(client, sessionID);
        const messages = await allMessages(client, sessionID);
        const canonicalID = turnAliases.get(turnKey(sessionID, turnID)) ?? turnID;
        return {
          session: sessionView(info, messages),
          outcome: canonicalOutcome(messages, canonicalID),
        };
      }),

    getAttachmentPreview: (sessionID, messageID, attachmentIndex) =>
      translated(async () => {
        if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0) {
          throw new OpenCodeGatewayError("VALIDATION_ERROR", "Некорректный индекс вложения");
        }
        await ownedSession(client, sessionID);
        const messages = await allMessages(client, sessionID);
        const message = messages.find(
          (candidate) => isRecord(candidate) && candidate.id === messageID,
        );
        return attachmentPreview(message, attachmentIndex);
      }),

    switchModel: (sessionID, model) =>
      translated(async () => {
        await ownedSession(client, sessionID);
        await client.session.switchModel({ sessionID, model });
      }),

    async *prompt(sessionID, text, signal, attachments = [], requestedTurnID) {
      if (requestedTurnID !== undefined && !isOpenCodeTurnID(requestedTurnID)) {
        throw new OpenCodeGatewayError("VALIDATION_ERROR", "Некорректный идентификатор хода");
      }
      await ownedSession(client, sessionID);
      if (signal.aborted) return;

      const subscription = client.event.subscribe();
      const iterator = subscription[Symbol.asyncIterator]();
      const aborted = Symbol("aborted");
      let markAborted: (value: typeof aborted) => void = () => undefined;
      const abortNotification = new Promise<typeof aborted>((resolve) => {
        markAborted = resolve;
      });
      let promptStarted = false;
      let promptAttempted = false;
      let finalizingEmitted = false;
      let inboxID = requestedTurnID ?? `msg_${randomUUID()}`;
      const clientTurnID = inboxID;
      let cancellation: Promise<void> | undefined;
      let subscriptionClosed = false;
      const closeSubscription = async (): Promise<void> => {
        if (subscriptionClosed) return;
        subscriptionClosed = true;
        await iterator.return?.();
      };
      const cancelPrompt = (): Promise<void> => {
        cancellation ??= (async () => {
          await Promise.allSettled([
            client.session.inbox.cancel({ sessionID, inboxID }),
            client.session.interrupt({ sessionID }),
          ]);
        })();
        return cancellation;
      };
      const onAbort = (): void => markAborted(aborted);
      signal.addEventListener("abort", onAbort, { once: true });
      const pause = (lookupSignal: AbortSignal): Promise<void> =>
        new Promise((resolve) => {
          if (lookupSignal.aborted) {
            resolve();
            return;
          }
          const timer = setTimeout(finish, CANONICAL_DELAY_MS);
          function finish(): void {
            clearTimeout(timer);
            lookupSignal.removeEventListener("abort", finish);
            resolve();
          }
          lookupSignal.addEventListener("abort", finish, { once: true });
        });
      /**
       * Canonical-проверка с общим конечным deadline на все страницы, retry и
       * sleeps. Caller abort отменяет fetch; timeout даёт безопасный pending.
       */
      const currentTurnOutcome = async (): Promise<CanonicalOutcome> => {
        let outcome: CanonicalOutcome = "missing";
        const controller = new AbortController();
        let markDeadline: () => void = () => undefined;
        const deadline = new Promise<void>((resolve) => {
          markDeadline = resolve;
        });
        const finishLookup = (): void => {
          controller.abort();
          markDeadline();
        };
        const timer = setTimeout(finishLookup, CANONICAL_DEADLINE_MS);
        signal.addEventListener("abort", finishLookup, { once: true });
        if (signal.aborted) finishLookup();
        try {
          for (let attempt = 0; attempt < CANONICAL_ATTEMPTS; attempt += 1) {
            if (controller.signal.aborted) return outcome;
            if (attempt > 0) {
              await pause(controller.signal);
              if (controller.signal.aborted) return outcome;
            }
            const lookup = allMessages(client, sessionID, controller.signal).catch(() => undefined);
            const messages = await Promise.race([lookup, deadline]);
            if (messages === undefined) {
              // Deadline уже истёк — безопасный pending. Иначе повторяем
              // ограниченную попытку, не превращая временный сбой в unconfirmed.
              if (controller.signal.aborted) return "pending";
              continue;
            }
            outcome = canonicalOutcome(messages, inboxID);
            if (outcome === "done" || outcome === "error" || outcome === "cancelled") {
              return outcome;
            }
          }
          return outcome;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", finishLookup);
        }
      };
      const next = () => Promise.race([iterator.next(), abortNotification]);
      let nextEvent = next();

      try {
        if (signal.aborted) return;
        for (;;) {
          const ready = await nextEvent;
          if (ready === aborted) return;
          if (ready.done === true) {
            throw new OpenCodeGatewayError(
              "DEPENDENCY_UNAVAILABLE",
              "Подписка OpenCode завершилась до подключения",
            );
          }
          if (ready.value.type === "server.connected") break;
          nextEvent = next();
        }

        if (signal.aborted) return;
        promptStarted = true;
        promptAttempted = true;
        const admitted = await client.session.prompt({
          sessionID,
          id: clientTurnID,
          text,
          ...(attachments.length === 0
            ? {}
            : {
                files: attachments.map((attachment) => ({
                  uri: attachment.dataUri,
                  source: { type: "inline" as const },
                  name: attachment.name,
                })),
              }),
          delivery: "queue",
          metadata: { source: "kanbaner" },
        });
        inboxID = stringField(admitted.id) ?? clientTurnID;
        rememberTurnAlias(sessionID, clientTurnID, inboxID);
        if (signal.aborted) return;
        if (requestedTurnID !== undefined && inboxID !== requestedTurnID) {
          // Явная identity, если Service подменил ID: ordinal или client ID
          // больше не должны использоваться для поиска canonical turn.
          yield admittedEvent(sessionID, inboxID);
        }

        let delivered = false;
        for (;;) {
          const result = await nextEvent;
          if (result === aborted) return;
          if (result.done === true) {
            throw new OpenCodeGatewayError(
              "DEPENDENCY_UNAVAILABLE",
              "Подписка OpenCode завершилась до результата",
            );
          }
          const event = result.value;
          const eventSession = eventSessionID(event);
          if (eventSession !== undefined && eventSession !== sessionID) {
            nextEvent = next();
            continue;
          }
          const eventInboxID = stringField(dataField(event.data, "inboxID"));
          if (
            eventSession === sessionID &&
            event.type === "session.inbox.delivered" &&
            eventInboxID === inboxID
          ) {
            delivered = true;
            nextEvent = next();
            continue;
          }
          if (eventSession === sessionID && event.type === "session.inbox.cancelled") {
            // Отмена чужого inbox не относится к текущему prompt даже после delivered.
            if (eventInboxID !== inboxID) {
              nextEvent = next();
              continue;
            }
            yield event;
            return;
          }
          if (event.type === "server.connected") {
            yield event;
            nextEvent = next();
            continue;
          }
          if (!delivered || eventSession === undefined) {
            nextEvent = next();
            continue;
          }
          if (eventSession === sessionID && TERMINAL_EVENTS.has(event.type)) {
            // Terminal event несёт только sessionID, поэтому исход проверяется
            // по canonical history именно этого prompt, а не по типу события.
            if (!finalizingEmitted) {
              finalizingEmitted = true;
              yield finalizingEvent(sessionID);
            }
            const outcome = await currentTurnOutcome();
            if (signal.aborted) return;
            if (outcome === "done" || outcome === "error" || outcome === "cancelled") {
              yield terminalEvent(outcome, sessionID);
            } else {
              yield unconfirmedEvent(sessionID);
            }
            return;
          }
          yield event;
          nextEvent = next();
        }
      } catch (error) {
        if (signal.aborted) return;
        if (promptAttempted) {
          // Вызов уже начался: rejected Promise не доказывает, что Service не
          // принял prompt (соединение могло оборваться после admission).
          // Безопасно проверяем canonical history по stable client turn ID и
          // повтор не предлагаем. SSE/iterator не прерываем.
          if (!finalizingEmitted) {
            finalizingEmitted = true;
            yield finalizingEvent(sessionID);
            if (signal.aborted) return;
          }
          const outcome = await currentTurnOutcome();
          if (signal.aborted) return;
          if (outcome === "done" || outcome === "error" || outcome === "cancelled") {
            yield terminalEvent(outcome, sessionID);
          } else {
            yield unconfirmedEvent(sessionID);
          }
          return;
        }
        throw gatewayError(error);
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted && promptStarted) await cancelPrompt();
        await closeSubscription();
      }
    },
  };
}

/**
 * `@opencode/client` закреплён на 2.2.5, но Service обновляется независимо.
 * Принимаем только strict SemVer major 2.x (`2.minor.patch` с optional
 * prerelease/build, numeric identifiers без leading zero) и не пропускаем
 * несовместимые 1.x/3.x, `2.`, `2.foo` или malformed-версии.
 */
const SERVICE_VERSION =
  /^2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function compatibleServiceVersion(version: string): boolean {
  // `$` допускает завершающий line terminator, поэтому сверяем весь match.
  const match = SERVICE_VERSION.exec(version);
  return match !== null && match[0] === version;
}

export async function ensureOpenCodeGateway(): Promise<OpenCodeGateway> {
  const endpoint = await Service.ensure({
    version: compatibleServiceVersion,
  });
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  return createOpenCodeGateway(client);
}
