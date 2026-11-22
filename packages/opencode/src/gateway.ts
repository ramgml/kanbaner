import { randomUUID } from "node:crypto";
import path from "node:path";

import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import { Service } from "@opencode/client/service";

import { ATTACHMENT_LIMITS } from "./attachments.ts";
import { OPENCODE_AGENT_ID } from "./metadata.ts";
import { OPENCODE_CATALOG_TOOLS } from "./tool-metadata.ts";
import {
  isRecord,
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
  if (isRecord(state.error)) return "Инструмент завершился с ошибкой";
  if (state.input !== undefined) return serialized(state.input);
  return "";
}

function messageViews(message: unknown): OpenCodeChatMessage[] {
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
      const partID = stringField(part.id) ?? String(index);
      if (part.type === "text" && typeof part.text === "string") {
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
        const status =
          state.status === "error"
            ? "error"
            : state.status === "completed"
              ? "completed"
              : "running";
        return [
          {
            id: `tool:${message.id}:${partID}`,
            role: "tool",
            name: stringField(part.name) ?? "tool",
            status,
            text: toolText(state),
          },
        ];
      }
      return [];
    });
    if (isRecord(message.error)) {
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
  if (message.type === "idle" && isRecord(message.error)) {
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

function messagesView(messages: readonly unknown[]): OpenCodeChatMessage[] {
  return messages.flatMap(messageViews);
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

function eventTextID(data: Record<string, unknown>): string | undefined {
  const messageID = stringField(dataField(data, "assistantMessageID"));
  if (messageID === undefined) return undefined;
  const ordinal = dataField(data, "ordinal");
  return `${messageID}:${typeof ordinal === "number" ? ordinal : 0}`;
}

export function streamEvent(event: OpenCodeEvent) {
  const data = isRecord(event.data) ? event.data : {};
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
      };
    }
    case "session.tool.called": {
      const id = eventToolID(data);
      return {
        kind: "tool" as const,
        ...(id === undefined ? {} : { id }),
        status: "running" as const,
        text: serialized(dataField(data, "input")),
      };
    }
    case "session.tool.success": {
      const id = eventToolID(data);
      return {
        kind: "tool" as const,
        ...(id === undefined ? {} : { id }),
        status: "completed" as const,
        text: toolText(data),
      };
    }
    case "session.tool.failed": {
      const id = eventToolID(data);
      return {
        kind: "tool" as const,
        ...(id === undefined ? {} : { id }),
        status: "error" as const,
        text: toolText(data),
      };
    }
    case "session.execution.succeeded":
      return { kind: "done" as const };
    case "session.execution.failed":
      return { kind: "error" as const, text: "Запрос OpenCode завершился с ошибкой" };
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

async function allMessages(client: OpenCodeClient, sessionID: string): Promise<readonly unknown[]> {
  const messages: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await translated(() =>
      client.message.list(
        cursor === undefined
          ? { sessionID, order: "asc", limit: 200 }
          : { sessionID, cursor, limit: 200 },
      ),
    );
    messages.push(...page.data);
    const next = stringField(page.cursor.next);
    if (next === undefined || cursors.has(next)) return messages;
    cursors.add(next);
    cursor = next;
  }
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

    async *prompt(sessionID, text, signal, attachments = []) {
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
      let promptAdmitted = false;
      let inboxID = `msg_${randomUUID()}`;
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
        const admitted = await client.session.prompt({
          sessionID,
          id: inboxID,
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
        inboxID = stringField(admitted.id) ?? inboxID;
        promptAdmitted = true;
        if (signal.aborted) return;

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
          if (
            eventSession === sessionID &&
            event.type === "session.inbox.cancelled" &&
            eventInboxID === inboxID
          ) {
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
          yield event;
          if (eventSession === sessionID && TERMINAL_EVENTS.has(event.type)) return;
          nextEvent = next();
        }
      } catch (error) {
        if (promptAdmitted) await cancelPrompt();
        if (signal.aborted) return;
        throw gatewayError(error);
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted && promptStarted) await cancelPrompt();
        await closeSubscription();
      }
    },
  };
}

export async function ensureOpenCodeGateway(): Promise<OpenCodeGateway> {
  const endpoint = await Service.ensure({
    version: (version) => version.startsWith("2.2."),
  });
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  return createOpenCodeGateway(client);
}
