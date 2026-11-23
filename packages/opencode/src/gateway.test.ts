// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";

import { createOpenCodeGateway, streamEvent } from "./gateway.ts";
import { ATTACHMENT_LIMITS } from "./attachments.ts";
import { OPENCODE_CATALOG_TOOLS } from "./tool-metadata.ts";
import { OpenCodeGatewayError } from "./types.ts";

function asClient(value: unknown): OpenCodeClient {
  return value as OpenCodeClient;
}

function event(type: string, data: Record<string, unknown> = {}): OpenCodeEvent {
  return { id: `event-${type}`, created: 1, type, data } as OpenCodeEvent;
}

function ownedInfo(id = "ses-1") {
  return {
    id,
    title: "Kanbaner chat",
    agent: "kanbaner",
    model: { id: "model-1", providerID: "provider-1", variant: "high" },
    metadata: { source: "kanbaner" },
  };
}

function subscription(events: readonly OpenCodeEvent[]) {
  let index = 0;
  const iterator = {
    next: vi.fn(async (): Promise<IteratorResult<OpenCodeEvent>> => {
      const value = events[index];
      index += 1;
      return value === undefined ? { done: true, value: undefined } : { done: false, value };
    }),
    return: vi.fn(async (): Promise<IteratorResult<OpenCodeEvent>> => ({
      done: true,
      value: undefined,
    })),
  };
  return {
    iterator,
    value: { [Symbol.asyncIterator]: () => iterator },
  };
}

function completedAssistant(id = "assistant-1") {
  return {
    id,
    type: "assistant",
    time: { created: 1, completed: 2 },
    finish: "stop",
    content: [{ id: "text-1", type: "text", text: "Ответ" }],
  };
}

function assistantMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "assistant",
    time: { created: 1, completed: 2 },
    finish: "stop",
    content: [],
    ...overrides,
  };
}

function failedAssistant(id = "assistant-1", error: unknown = { type: "unknown" }) {
  return {
    id,
    type: "assistant",
    time: { created: 1, completed: 2 },
    finish: "error",
    error,
    content: [],
  };
}

function canonicalTurn(inboxID: string, assistant?: unknown) {
  return {
    data: [
      { id: inboxID, type: "user", text: "Вопрос" },
      ...(assistant === undefined ? [] : [assistant]),
    ],
    cursor: { next: null },
  };
}

function canonicalHistory(inboxID: string, messages: readonly unknown[]) {
  return {
    data: [{ id: inboxID, type: "user", text: "Вопрос" }, ...messages],
    cursor: { next: null },
  };
}

function idleMessage(outcome: string, overrides: Record<string, unknown> = {}) {
  return { id: `idle-${outcome}`, type: "idle", outcome, ...overrides };
}

function promptClient(
  stream: { value: AsyncIterable<OpenCodeEvent> },
  list: unknown,
  session: Record<string, unknown> = {},
) {
  return asClient({
    session: {
      get: async () => ownedInfo(),
      prompt: vi.fn(async () => ({ id: "inbox-1", sessionID: "ses-1", delivery: "queue" })),
      ...session,
    },
    message: { list },
    event: { subscribe: () => stream.value },
  });
}

function rejectingSubscription(events: readonly OpenCodeEvent[], reason: Error) {
  let index = 0;
  const iterator = {
    next: vi.fn(async (): Promise<IteratorResult<OpenCodeEvent>> => {
      const value = events[index];
      index += 1;
      if (value === undefined) throw reason;
      return { done: false, value };
    }),
    return: vi.fn(async (): Promise<IteratorResult<OpenCodeEvent>> => ({
      done: true,
      value: undefined,
    })),
  };
  return {
    iterator,
    value: { [Symbol.asyncIterator]: () => iterator },
  };
}

async function collect(iterable: AsyncIterable<OpenCodeEvent>): Promise<OpenCodeEvent[]> {
  const events: OpenCodeEvent[] = [];
  for await (const item of iterable) events.push(item);
  return events;
}

function last(events: readonly OpenCodeEvent[]): OpenCodeEvent {
  const event = events[events.length - 1];
  if (event === undefined) throw new Error("Ожидалось хотя бы одно событие");
  return event;
}

function at(events: readonly OpenCodeEvent[], index: number): OpenCodeEvent {
  const event = events[index];
  if (event === undefined) throw new Error(`Ожидалось событие с индексом ${index}`);
  return event;
}

describe("OpenCode gateway", () => {
  it("возвращает whitelist catalog и один location без provider settings", async () => {
    const location = { directory: process.cwd() };
    const providerList = vi.fn(async () => ({
      data: [
        {
          id: "provider-1",
          name: "Provider One",
          activation: "enabled",
          settings: { apiKey: "secret" },
        },
        { id: "empty", name: "Empty", activation: "auto", headers: { authorization: "secret" } },
      ],
    }));
    const modelList = vi.fn(async () => ({
      data: [
        {
          modelID: "model-1",
          providerID: "provider-1",
          name: "Model One",
          type: "chat",
          enabled: true,
          status: "active",
          variants: [{ id: "low" }, { id: "high" }],
          settings: { apiKey: "secret" },
        },
        {
          modelID: "disabled",
          providerID: "provider-1",
          name: "Disabled",
          enabled: false,
          status: "active",
          variants: [],
        },
      ],
    }));
    const agentList = vi.fn(async () => ({
      data: [
        {
          id: "kanbaner",
          name: "Kanbaner",
          description: "Restricted",
          hidden: false,
          mode: "primary",
        },
        { id: "build", name: "Build", hidden: false, mode: "primary" },
      ],
    }));
    const modelDefault = vi.fn(async () => ({
      data: { id: "provider-1/model-1", modelID: "model-1", providerID: "provider-1" },
    }));
    const gateway = createOpenCodeGateway(
      asClient({
        provider: { list: providerList },
        model: { list: modelList, default: modelDefault },
        agent: { list: agentList },
      }),
    );

    const catalog = await gateway.catalog();

    expect(catalog).toEqual({
      providers: [{ id: "provider-1", name: "Provider One", activation: "enabled" }],
      models: [
        {
          id: "model-1",
          providerID: "provider-1",
          name: "Model One",
          type: "chat",
          variants: ["low", "high"],
        },
      ],
      agents: [{ id: "kanbaner", name: "Kanbaner", description: "Restricted" }],
      tools: OPENCODE_CATALOG_TOOLS,
      defaultModel: { id: "model-1", providerID: "provider-1" },
    });
    expect(JSON.stringify(catalog)).not.toContain("secret");
    for (const call of [providerList, modelList, agentList, modelDefault]) {
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ location }));
    }
    expect(modelList).toHaveBeenCalledWith({ location, types: ["chat"] });
  });

  it("создаёт только ограниченную сессию и скрывает чужие session ID", async () => {
    const create = vi.fn(async () => ownedInfo());
    const get = vi.fn(async () => ({ ...ownedInfo(), agent: "build" }));
    const list = vi.fn();
    const gateway = createOpenCodeGateway(
      asClient({ session: { create, get }, message: { list } }),
    );

    await expect(gateway.createSession({ agent: "build" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(create).not.toHaveBeenCalled();

    const created = await gateway.createSession({
      model: { id: "model-1", providerID: "provider-1" },
    });
    expect(created.id).toBe("ses-1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "kanbaner",
        metadata: { source: "kanbaner" },
        location: { directory: process.cwd() },
      }),
    );

    await expect(gateway.getSession("foreign")).rejects.toEqual(
      new OpenCodeGatewayError("NOT_FOUND", "Сессия OpenCode не найдена"),
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("загружает всю history с pagination и сохраняет статусы tools/compaction", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "user-1",
            type: "user",
            text: "Вопрос",
            files: [
              {
                name: "notes.txt",
                mime: "text/plain",
                data: "c2VjcmV0IGZpbGUgY29udGVudA==",
                source: { type: "inline" },
              },
            ],
          },
        ],
        cursor: { next: "cursor-2" },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "assistant-1",
            type: "assistant",
            content: [
              { id: "text-1", type: "text", text: "Ответ" },
              {
                id: "call-1",
                type: "tool",
                name: "task_update",
                state: { status: "running", input: { id: "task-1" } },
              },
            ],
          },
          { id: "compact-1", type: "compaction", status: "completed", summary: "Сводка" },
        ],
        cursor: { next: null },
      });
    const gateway = createOpenCodeGateway(
      asClient({ session: { get: async () => ownedInfo() }, message: { list } }),
    );

    const session = await gateway.getSession("ses-1");

    expect(list).toHaveBeenNthCalledWith(1, { sessionID: "ses-1", order: "asc", limit: 200 });
    expect(list).toHaveBeenNthCalledWith(2, {
      sessionID: "ses-1",
      limit: 200,
      cursor: "cursor-2",
    });
    expect(session.messages).toEqual([
      {
        id: "user:user-1",
        role: "user",
        text: "Вопрос",
        attachments: [{ name: "notes.txt", mime: "text/plain" }],
      },
      { id: "assistant:assistant-1:text-1", role: "assistant", text: "Ответ" },
      {
        id: "tool:assistant-1:call-1",
        role: "tool",
        name: "task_update",
        status: "running",
        text: '{"id":"task-1"}',
      },
      { id: "system:compact-1", role: "system", text: "Сводка" },
    ]);
    expect(JSON.stringify(session)).not.toContain("c2VjcmV0");
    expect(JSON.stringify(session)).not.toContain("base64");
  });

  it("не воскрешает старый system error после нового успешного turn", async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: "user-1", type: "user", text: "Старый вопрос" },
        failedAssistant("assistant-old", { type: "unknown", message: "secret upstream response" }),
        { id: "user-2", type: "user", text: "Новый вопрос" },
        completedAssistant("assistant-current"),
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(
      asClient({ session: { get: async () => ownedInfo() }, message: { list } }),
    );

    const session = await gateway.getSession("ses-1");

    expect(session.messages.some((message) => message.role === "system")).toBe(false);
    expect(session.messages.some((message) => message.id === "error:assistant-old")).toBe(false);
    expect(JSON.stringify(session)).not.toContain("secret");
  });

  it("сохраняет system error только для последнего assistant последнего turn", async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: "user-1", type: "user", text: "Первый" },
        failedAssistant("assistant-old", { type: "unknown" }),
        { id: "user-2", type: "user", text: "Второй" },
        failedAssistant("assistant-current", { type: "unknown" }),
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(
      asClient({ session: { get: async () => ownedInfo() }, message: { list } }),
    );

    const session = await gateway.getSession("ses-1");

    expect(session.messages.filter((message) => message.role === "system")).toEqual([
      {
        id: "error:assistant-current",
        role: "system",
        text: "Ответ OpenCode завершился с ошибкой",
      },
    ]);
  });

  it("не воскрешает старый idle error перед новым user и успешным turn", async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: "user-1", type: "user", text: "Старый вопрос" },
        failedAssistant("assistant-old", { type: "unknown" }),
        { id: "idle-old", type: "idle", error: { type: "provider", message: "secret" } },
        { id: "user-2", type: "user", text: "Новый вопрос" },
        completedAssistant("assistant-current"),
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(
      asClient({ session: { get: async () => ownedInfo() }, message: { list } }),
    );

    const session = await gateway.getSession("ses-1");

    expect(session.messages.some((message) => message.role === "system")).toBe(false);
    expect(session.messages.some((message) => message.id === "error:idle-old")).toBe(false);
    expect(JSON.stringify(session)).not.toContain("secret");
  });

  it("не воскрешает idle error, если позже был успешный assistant", async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: "user-1", type: "user", text: "Вопрос" },
        { id: "idle-old", type: "idle", error: { type: "provider" } },
        completedAssistant("assistant-current"),
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(
      asClient({ session: { get: async () => ownedInfo() }, message: { list } }),
    );

    const session = await gateway.getSession("ses-1");

    expect(session.messages.some((message) => message.role === "system")).toBe(false);
  });

  it("сохраняет idle error текущего turn", async () => {
    const list = vi.fn(async () => ({
      data: [
        { id: "user-1", type: "user", text: "Вопрос" },
        completedAssistant("assistant-current"),
        { id: "idle-current", type: "idle", error: { type: "provider" } },
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(
      asClient({ session: { get: async () => ownedInfo() }, message: { list } }),
    );

    const session = await gateway.getSession("ses-1");

    expect(session.messages.filter((message) => message.role === "system")).toEqual([
      {
        id: "error:idle-current",
        role: "system",
        text: "Сессия OpenCode завершилась с ошибкой",
      },
    ]);
  });

  it("отдаёт binary preview только из exact inline image canonical message", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const encoded = png.toString("base64");
    const get = vi.fn(async () => ownedInfo());
    const list = vi.fn(async () => ({
      data: [
        {
          id: "user-1",
          type: "user",
          text: "Картинка",
          files: [
            {
              name: "pixel.png",
              mime: "image/png",
              data: encoded,
              source: { type: "inline" },
            },
            {
              name: "notes.txt",
              mime: "text/plain",
              data: "aGVsbG8=",
              source: { type: "inline" },
            },
          ],
        },
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(asClient({ session: { get }, message: { list } }));

    const preview = await gateway.getAttachmentPreview("ses-1", "user-1", 0);

    expect(preview.mime).toBe("image/png");
    expect(preview.name).toBe("pixel.png");
    expect(Buffer.from(preview.bytes).equals(png)).toBe(true);
    expect(get).toHaveBeenCalledWith({ sessionID: "ses-1" });
    expect(list).toHaveBeenCalledWith({ sessionID: "ses-1", order: "asc", limit: 200 });

    const history = await gateway.getSession("ses-1");
    expect(history.messages[0]).toEqual({
      id: "user:user-1",
      role: "user",
      text: "Картинка",
      attachments: [
        { name: "pixel.png", mime: "image/png" },
        { name: "notes.txt", mime: "text/plain" },
      ],
    });
    expect(JSON.stringify(history)).not.toContain(encoded);
    expect(JSON.stringify(history)).not.toContain("data:image");
  });

  it("скрывает missing, media-ref, non-image, invalid inline Base64 и подмену data URI", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const encoded = png.toString("base64");
    const files: readonly unknown[] = [
      { name: "pixel.png", mime: "image/png", data: encoded, source: { type: "inline" } },
      {
        name: "notes.txt",
        mime: "text/plain",
        data: "aGVsbG8=",
        source: { type: "inline" },
      },
      {
        name: "media.png",
        mime: "image/png",
        data: encoded,
        source: { type: "uri", uri: "media:0123456789abcdef" },
      },
      {
        name: "file.png",
        mime: "image/png",
        data: encoded,
        source: { type: "uri", uri: "file:///etc/passwd" },
      },
      {
        name: "remote.png",
        mime: "image/png",
        data: encoded,
        source: { type: "uri", uri: `https://attacker.invalid/${encoded}` },
      },
      { name: "broken.png", mime: "image/png", data: "not-base64", source: { type: "inline" } },
      { name: "fake.png", mime: "image/png", data: "aGVsbG8=", source: { type: "inline" } },
      { name: "mime.png", mime: "image/jpeg", data: encoded, source: { type: "inline" } },
      {
        name: "data-uri.png",
        mime: "image/png",
        data: `data:image/png;base64,${encoded}`,
        source: { type: "inline" },
      },
      {
        name: "newline.png",
        mime: "image/png",
        data: `${encoded}\n`,
        source: { type: "inline" },
      },
      {
        name: "data-uri-newline.png",
        mime: "image/png",
        data: `data:image/png;base64,${encoded}\n`,
        source: { type: "inline" },
      },
      { name: "no-source.png", mime: "image/png", data: encoded },
      {
        name: "legacy-uri.png",
        mime: "image/png",
        uri: `data:image/png;base64,${encoded}`,
        source: { type: "inline" },
      },
    ];
    const get = vi.fn(async () => ownedInfo());
    const list = vi.fn(async () => ({
      data: [{ id: "user-1", type: "user", files }],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(asClient({ session: { get }, message: { list } }));

    for (const [messageID, index] of [
      ["missing", 0],
      ["user-1", 1],
      ["user-1", 2],
      ["user-1", 3],
      ["user-1", 4],
      ["user-1", 5],
      ["user-1", 6],
      ["user-1", 7],
      ["user-1", 8],
      ["user-1", 9],
      ["user-1", 10],
      ["user-1", 11],
      ["user-1", 12],
    ] as const) {
      await expect(gateway.getAttachmentPreview("ses-1", messageID, index)).rejects.toEqual(
        new OpenCodeGatewayError("NOT_FOUND", "Вложение OpenCode не найдено"),
      );
    }

    await expect(gateway.getAttachmentPreview("ses-1", "user-1", -1)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(gateway.getAttachmentPreview("ses-1", "user-1", 1.5)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(list).toHaveBeenCalled();
  });

  it("не читает сообщения и preview для чужой session", async () => {
    const get = vi.fn(async () => ({ ...ownedInfo(), agent: "build" }));
    const list = vi.fn();
    const gateway = createOpenCodeGateway(asClient({ session: { get }, message: { list } }));

    await expect(gateway.getAttachmentPreview("foreign", "user-1", 0)).rejects.toEqual(
      new OpenCodeGatewayError("NOT_FOUND", "Сессия OpenCode не найдена"),
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("отклоняет preview больше maxMediaBytes", async () => {
    const oversized = Buffer.alloc(ATTACHMENT_LIMITS.maxMediaBytes + 1, 0x89);
    const encoded = oversized.toString("base64");
    const get = vi.fn(async () => ownedInfo());
    const list = vi.fn(async () => ({
      data: [
        {
          id: "user-1",
          type: "user",
          files: [
            {
              name: "huge.png",
              mime: "image/png",
              data: encoded,
              source: { type: "inline" },
            },
          ],
        },
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(asClient({ session: { get }, message: { list } }));

    await expect(gateway.getAttachmentPreview("ses-1", "user-1", 0)).rejects.toEqual(
      new OpenCodeGatewayError("NOT_FOUND", "Вложение OpenCode не найдено"),
    );
  });

  it("маппит tool identity и не раскрывает upstream execution error", () => {
    const started = streamEvent(
      event("session.tool.input.started", {
        sessionID: "ses-1",
        assistantMessageID: "message-1",
        id: "call-1",
        name: "task_update",
      }),
    );
    const called = streamEvent(
      event("session.tool.called", {
        sessionID: "ses-1",
        assistantMessageID: "message-1",
        id: "call-1",
        input: { id: "task-1", expectedVersion: 2 },
      }),
    );
    const success = streamEvent(
      event("session.tool.success", {
        sessionID: "ses-1",
        assistantMessageID: "message-1",
        id: "call-1",
        content: [{ type: "text", text: "Готово" }],
      }),
    );
    const failed = streamEvent(
      event("session.execution.failed", {
        sessionID: "ses-1",
        error: { message: "secret upstream response" },
      }),
    );

    expect(started).toMatchObject({
      id: "message-1:call-1",
      name: "task_update",
      status: "running",
    });
    expect(called).toMatchObject({
      id: "message-1:call-1",
      text: '{"id":"task-1","expectedVersion":2}',
    });
    expect(success).toMatchObject({ id: "message-1:call-1", status: "completed", text: "Готово" });
    expect(failed).toEqual({ kind: "error", text: "Запрос OpenCode завершился с ошибкой" });
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(streamEvent(event("session.execution.interrupted", { sessionID: "ses-1" }))).toEqual({
      kind: "cancelled",
      text: "Запрос остановлен",
    });
  });

  it("ждёт server.connected, фильтрует сессии и завершается на terminal event", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
      event("session.text.delta", { sessionID: "other", delta: "Чужое" }),
      event("session.text.delta", { sessionID: "ses-1", delta: "Предыдущее" }),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.text.delta", {
        sessionID: "ses-1",
        assistantMessageID: "message-1",
        ordinal: 0,
        delta: "Ответ",
      }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
      event("session.text.delta", { sessionID: "ses-1", delta: "Позднее" }),
    ]);
    const prompt = vi.fn(async () => {
      expect(stream.iterator.next).toHaveBeenCalledTimes(1);
      return { id: "inbox-1", sessionID: "ses-1", delivery: "queue" };
    });
    const list = vi.fn(async () => canonicalTurn("inbox-1", completedAssistant()));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt },
        message: { list },
        event: { subscribe: () => stream.value },
      }),
    );

    const received: OpenCodeEvent[] = [];
    for await (const item of gateway.prompt("ses-1", "Вопрос", new AbortController().signal)) {
      received.push(item);
    }

    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.text.delta",
      "session.execution.finalizing",
      "session.execution.succeeded",
    ]);
    expect(streamEvent(at(received, 2))).toEqual({ kind: "finalizing" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses-1",
        id: expect.stringMatching(/^msg_/u),
        text: "Вопрос",
        delivery: "queue",
        metadata: { source: "kanbaner" },
      }),
    );
    const promptInput = (prompt.mock.calls as unknown as [[Record<string, unknown>]])[0]?.[0];
    expect(promptInput).not.toHaveProperty("files");
    expect(stream.iterator.return).toHaveBeenCalledTimes(1);
  });

  it("выпускает finalizing ровно один раз и только один terminal", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
      event("session.execution.failed", { sessionID: "ses-1" }),
    ]);
    const list = vi.fn(async () => canonicalTurn("inbox-1", completedAssistant()));
    const gateway = createOpenCodeGateway(promptClient(stream, list));

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(
      received.filter((item) => (item.type as string) === "session.execution.finalizing"),
    ).toHaveLength(1);
    expect(
      received.filter((item) => (item.type as string) === "session.execution.failed"),
    ).toHaveLength(0);
    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.execution.finalizing",
      "session.execution.succeeded",
    ]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("повторяет canonical lookup после временного сбоя", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient lookup failure"))
      .mockResolvedValueOnce(canonicalTurn("inbox-1", completedAssistant()));
    const gateway = createOpenCodeGateway(promptClient(stream, list));

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.execution.finalizing",
      "session.execution.succeeded",
    ]);
    expect(streamEvent(last(received))).toEqual({ kind: "done" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("передаёт только inline data URL в prompt выбранной модели", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const prompt = vi.fn(async () => ({
      id: "inbox-1",
      sessionID: "ses-1",
      delivery: "queue",
    }));
    const list = vi.fn(async () => canonicalTurn("inbox-1", completedAssistant()));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt },
        message: { list },
        event: { subscribe: () => stream.value },
      }),
    );

    const received: OpenCodeEvent[] = [];
    for await (const item of gateway.prompt("ses-1", "Что в файле?", new AbortController().signal, [
      { name: "notes.txt", dataUri: "data:text/plain;base64,aGVsbG8=" },
      { name: "screen.png", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
    ])) {
      received.push(item);
    }

    expect(received.map((item) => item.type)).toContain("session.execution.succeeded");
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Что в файле?",
        files: [
          {
            uri: "data:text/plain;base64,aGVsbG8=",
            source: { type: "inline" },
            name: "notes.txt",
          },
          {
            uri: "data:image/png;base64,iVBORw0KGgo=",
            source: { type: "inline" },
            name: "screen.png",
          },
        ],
      }),
    );
  });

  it("использует client turnID и не выпускает admitted, если Service сохранил ID", async () => {
    const turnID = "msg_client0001";
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: turnID }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const prompt = vi.fn(async () => ({ id: turnID, sessionID: "ses-1", delivery: "queue" }));
    const list = vi.fn(async () => canonicalTurn(turnID, completedAssistant()));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt },
        message: { list },
        event: { subscribe: () => stream.value },
      }),
    );

    const received = await collect(
      gateway.prompt("ses-1", "Вопрос", new AbortController().signal, [], turnID),
    );

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ id: turnID }));
    expect(received.map((item) => item.type)).not.toContain("kanbaner.turn.admitted");
    expect(streamEvent(last(received))).toEqual({ kind: "done" });
  });

  it("явно связывает admitted ID, если Service подменил client turnID", async () => {
    const turnID = "msg_client0002";
    const admittedID = "msg_server0002";
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: admittedID }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const prompt = vi.fn(async () => ({
      id: admittedID,
      sessionID: "ses-1",
      delivery: "queue",
    }));
    const list = vi.fn(async () => canonicalTurn(admittedID, completedAssistant()));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt },
        message: { list },
        event: { subscribe: () => stream.value },
      }),
    );

    const received = await collect(
      gateway.prompt("ses-1", "Вопрос", new AbortController().signal, [], turnID),
    );
    const admitted = received.find((item) => (item.type as string) === "kanbaner.turn.admitted");

    expect(admitted).toBeDefined();
    expect(streamEvent(admitted as OpenCodeEvent)).toEqual({ kind: "admitted", id: admittedID });
    const status = await gateway.getTurnStatus("ses-1", turnID);
    expect(status.outcome).toBe("done");
  });

  it("getTurnStatus принимает admitted ID вне client pattern напрямую и через alias", async () => {
    const turnID = "msg_client0004";
    const admittedID = "inbox-admitted";
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: admittedID }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const prompt = vi.fn(async () => ({
      id: admittedID,
      sessionID: "ses-1",
      delivery: "queue",
    }));
    const list = vi.fn(async () => canonicalTurn(admittedID, completedAssistant()));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt },
        message: { list },
        event: { subscribe: () => stream.value },
      }),
    );

    const received = await collect(
      gateway.prompt("ses-1", "Вопрос", new AbortController().signal, [], turnID),
    );
    expect(received.map((item) => streamEvent(item))).toContainEqual({
      kind: "admitted",
      id: admittedID,
    });

    expect((await gateway.getTurnStatus("ses-1", turnID)).outcome).toBe("done");
    expect((await gateway.getTurnStatus("ses-1", admittedID)).outcome).toBe("done");

    // Прямой admitted ID не зависит от alias-map: новый gateway после
    // restart/eviction тоже находит точный turn.
    const restarted = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt: vi.fn() },
        message: { list },
        event: { subscribe: () => subscription([]).value },
      }),
    );
    expect((await restarted.getTurnStatus("ses-1", admittedID)).outcome).toBe("done");
    await expect(gateway.getTurnStatus("ses-1", "bad id")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("getTurnStatus вычисляет outcome ровно по переданному turn ID", async () => {
    const doneID = "msg_done000001";
    const errorID = "msg_error00001";
    const list = vi.fn(async () => ({
      data: [
        { id: doneID, type: "user", text: "Вопрос" },
        completedAssistant("assistant-done"),
        { id: errorID, type: "user", text: "Второй" },
        failedAssistant("assistant-error"),
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt: vi.fn() },
        message: { list },
        event: { subscribe: () => subscription([]).value },
      }),
    );

    expect((await gateway.getTurnStatus("ses-1", doneID)).outcome).toBe("done");
    expect((await gateway.getTurnStatus("ses-1", errorID)).outcome).toBe("error");
    expect((await gateway.getTurnStatus("ses-1", "msg_missing0001")).outcome).toBe("missing");
    await expect(gateway.getTurnStatus("ses-1", "bad id")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("rejected session.prompt после начала вызова даёт unconfirmed без non-admission", async () => {
    const turnID = "msg_client0003";
    const stream = subscription([event("server.connected")]);
    const prompt = vi.fn(async () => {
      throw new OpenCodeGatewayError(
        "DEPENDENCY_UNAVAILABLE",
        "secret prompt failure after possible admission",
      );
    });
    const list = vi.fn(async () => canonicalTurn(turnID));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const cancel = vi.fn(async () => undefined);
    const gateway = createOpenCodeGateway(
      promptClient(stream, list, { prompt, interrupt, inbox: { cancel } }),
    );

    const received = await collect(
      gateway.prompt("ses-1", "Вопрос", new AbortController().signal, [], turnID),
    );
    const events = received.map((item) => streamEvent(item));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ id: turnID }));
    expect(events).toContainEqual({ kind: "finalizing" });
    expect(last(received)).toEqual(
      expect.objectContaining({
        type: "session.execution.failed",
        data: expect.objectContaining({ kanbanerUnconfirmed: true }),
      }),
    );
    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Не удалось подтвердить результат OpenCode",
      reason: "unconfirmed",
    });
    expect(JSON.stringify(received)).not.toContain("secret");
    expect(interrupt).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejected session.prompt подтверждает только exact canonical outcome", async () => {
    const cases = [
      ["done", completedAssistant(), { kind: "done" }],
      [
        "error",
        failedAssistant("assistant-failed"),
        { kind: "error", text: "Запрос OpenCode завершился с ошибкой" },
      ],
    ] as const;

    for (const [name, assistant, expected] of cases) {
      const turnID = `msg_client${name}0001`;
      const stream = subscription([event("server.connected")]);
      const prompt = vi.fn(async () => {
        throw new Error("connection reset after possible admission");
      });
      const list = vi.fn(async () => canonicalTurn(turnID, assistant));
      const gateway = createOpenCodeGateway(promptClient(stream, list, { prompt }));

      const received = await collect(
        gateway.prompt("ses-1", "Вопрос", new AbortController().signal, [], turnID),
      );

      expect(prompt).toHaveBeenCalledTimes(1);
      expect(streamEvent(last(received))).toEqual(expected);
      expect(JSON.stringify(received)).not.toContain("connection reset");
    }
  });

  it("находит второй prompt по stable ID, если первый отсутствует в canonical history", async () => {
    const firstID = "msg_first000001";
    const secondID = "msg_second00001";
    const list = vi.fn(async () => ({
      data: [
        { id: secondID, type: "user", text: "Второй вопрос" },
        completedAssistant("assistant-second"),
      ],
      cursor: { next: null },
    }));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt: vi.fn() },
        message: { list },
        event: { subscribe: () => subscription([]).value },
      }),
    );

    expect((await gateway.getTurnStatus("ses-1", firstID)).outcome).toBe("missing");
    expect((await gateway.getTurnStatus("ses-1", secondID)).outcome).toBe("done");
  });

  it("принимает stale failed/interrupted как done, если canonical assistant завершён", async () => {
    for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
      const stream = subscription([
        event("server.connected"),
        event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        event(type, { sessionID: "ses-1" }),
      ]);
      const list = vi.fn(async () => canonicalTurn("inbox-1", completedAssistant()));
      const gateway = createOpenCodeGateway(
        asClient({
          session: {
            get: async () => ownedInfo(),
            prompt: vi.fn(async () => ({ id: "inbox-1", sessionID: "ses-1", delivery: "queue" })),
          },
          message: { list },
          event: { subscribe: () => stream.value },
        }),
      );

      const received = await collect(
        gateway.prompt("ses-1", "Вопрос", new AbortController().signal),
      );

      expect(received.map((item) => item.type)).toEqual([
        "server.connected",
        "session.execution.finalizing",
        "session.execution.succeeded",
      ]);
      expect(streamEvent(last(received))).toEqual({ kind: "done" });
    }
  });

  it("trailing idle перекрывает completed assistant в stream", async () => {
    const cases = [
      ["failed", {}, { kind: "error", text: "Запрос OpenCode завершился с ошибкой" }],
      [
        "failed",
        { error: { type: "aborted", message: "secret upstream response" } },
        { kind: "cancelled", text: "Запрос остановлен" },
      ],
      ["interrupted", {}, { kind: "cancelled", text: "Запрос остановлен" }],
    ] as const;

    for (const [outcome, overrides, expected] of cases) {
      const stream = subscription([
        event("server.connected"),
        event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        event("session.execution.succeeded", { sessionID: "ses-1" }),
      ]);
      const list = vi.fn(async () =>
        canonicalHistory("inbox-1", [completedAssistant(), idleMessage(outcome, overrides)]),
      );
      const gateway = createOpenCodeGateway(promptClient(stream, list));

      const received = await collect(
        gateway.prompt("ses-1", "Вопрос", new AbortController().signal),
      );

      expect(streamEvent(last(received))).toEqual(expected);
      expect(JSON.stringify(received)).not.toContain("secret");
    }
  });

  it("trailing idle перекрывает completed assistant после transport error", async () => {
    const cases = [
      ["failed", { kind: "error", text: "Запрос OpenCode завершился с ошибкой" }],
      ["interrupted", { kind: "cancelled", text: "Запрос остановлен" }],
    ] as const;

    for (const [outcome, expected] of cases) {
      const stream = rejectingSubscription(
        [
          event("server.connected"),
          event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        ],
        new Error("transport failed: secret upstream response"),
      );
      const list = vi.fn(async () =>
        canonicalHistory("inbox-1", [completedAssistant(), idleMessage(outcome)]),
      );
      const interrupt = vi.fn(async () => ({ interrupted: true }));
      const cancel = vi.fn(async () => undefined);
      const gateway = createOpenCodeGateway(
        promptClient(stream, list, { interrupt, inbox: { cancel } }),
      );

      const received = await collect(
        gateway.prompt("ses-1", "Вопрос", new AbortController().signal),
      );

      expect(streamEvent(last(received))).toEqual(expected);
      expect(interrupt).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(JSON.stringify(received)).not.toContain("secret");
    }
  });

  it("trailing idle succeeded не подтверждает done без завершённого assistant", async () => {
    const histories = [
      [idleMessage("succeeded")],
      [
        completedAssistant("assistant-1"),
        assistantMessage("assistant-2", { finish: "tool-calls" }),
        idleMessage("succeeded"),
      ],
    ];

    for (const history of histories) {
      const stream = subscription([
        event("server.connected"),
        event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        event("session.execution.succeeded", { sessionID: "ses-1" }),
      ]);
      const list = vi.fn(async () => canonicalHistory("inbox-1", history));
      const gateway = createOpenCodeGateway(promptClient(stream, list));

      const received = await collect(
        gateway.prompt("ses-1", "Вопрос", new AbortController().signal),
      );

      expect(streamEvent(last(received))).toEqual({
        kind: "error",
        text: "Не удалось подтвердить результат OpenCode",
        reason: "unconfirmed",
      });
      expect(list).toHaveBeenCalledTimes(3);
    }
  });

  it("trailing idle succeeded без assistant остаётся pending после transport error", async () => {
    const stream = rejectingSubscription(
      [
        event("server.connected"),
        event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      ],
      new Error("transport failed: secret upstream response"),
    );
    const list = vi.fn(async () => canonicalHistory("inbox-1", [idleMessage("succeeded")]));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const gateway = createOpenCodeGateway(
      promptClient(stream, list, { interrupt, inbox: { cancel: vi.fn(async () => undefined) } }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Не удалось подтвердить результат OpenCode",
      reason: "unconfirmed",
    });
    expect(interrupt).not.toHaveBeenCalled();
    expect(JSON.stringify(received)).not.toContain("secret");
  });

  it("stale idle до нового assistant не перекрывает его done", async () => {
    for (const outcome of ["failed", "interrupted", "succeeded"] as const) {
      const stream = subscription([
        event("server.connected"),
        event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        event("session.execution.succeeded", { sessionID: "ses-1" }),
      ]);
      const list = vi.fn(async () =>
        canonicalHistory("inbox-1", [
          completedAssistant("assistant-1"),
          idleMessage(outcome),
          completedAssistant("assistant-2"),
        ]),
      );
      const gateway = createOpenCodeGateway(promptClient(stream, list));

      const received = await collect(
        gateway.prompt("ses-1", "Вопрос", new AbortController().signal),
      );

      expect(streamEvent(last(received))).toEqual({ kind: "done" });
    }
  });

  it("idle failed/interrupted без assistant даёт error/cancelled после transport error", async () => {
    const cases = [
      ["failed", { kind: "error", text: "Запрос OpenCode завершился с ошибкой" }],
      ["interrupted", { kind: "cancelled", text: "Запрос остановлен" }],
    ] as const;

    for (const [outcome, expected] of cases) {
      const stream = rejectingSubscription(
        [
          event("server.connected"),
          event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        ],
        new Error("transport failed: secret upstream response"),
      );
      const list = vi.fn(async () => canonicalHistory("inbox-1", [idleMessage(outcome)]));
      const interrupt = vi.fn(async () => ({ interrupted: true }));
      const cancel = vi.fn(async () => undefined);
      const gateway = createOpenCodeGateway(
        promptClient(stream, list, { interrupt, inbox: { cancel } }),
      );

      const received = await collect(
        gateway.prompt("ses-1", "Вопрос", new AbortController().signal),
      );

      expect(streamEvent(last(received))).toEqual(expected);
      expect(interrupt).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(JSON.stringify(received)).not.toContain("secret");
    }
  });

  it("оставляет canonical error текущего prompt при stale succeeded", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const list = vi.fn(async () =>
      canonicalTurn(
        "inbox-1",
        failedAssistant("assistant-1", { type: "provider", message: "secret upstream response" }),
      ),
    );
    const gateway = createOpenCodeGateway(
      asClient({
        session: {
          get: async () => ownedInfo(),
          prompt: vi.fn(async () => ({ id: "inbox-1", sessionID: "ses-1", delivery: "queue" })),
        },
        message: { list },
        event: { subscribe: () => stream.value },
      }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.execution.finalizing",
      "session.execution.failed",
    ]);
    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Запрос OpenCode завершился с ошибкой",
    });
    expect(JSON.stringify(received)).not.toContain("secret");
  });

  it("после transport error не прерывает execution и возвращает canonical done", async () => {
    const iterator = {
      next: vi
        .fn<() => Promise<IteratorResult<OpenCodeEvent>>>()
        .mockResolvedValueOnce({ done: false, value: event("server.connected") })
        .mockResolvedValueOnce({
          done: false,
          value: event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        })
        .mockRejectedValue(new Error("transport failed: secret upstream response")),
      return: vi.fn(async (): Promise<IteratorResult<OpenCodeEvent>> => ({
        done: true,
        value: undefined,
      })),
    };
    const list = vi.fn(async () => canonicalTurn("inbox-1", completedAssistant()));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const cancel = vi.fn(async () => undefined);
    const gateway = createOpenCodeGateway(
      asClient({
        session: {
          get: async () => ownedInfo(),
          prompt: vi.fn(async () => ({ id: "inbox-1", sessionID: "ses-1", delivery: "queue" })),
          interrupt,
          inbox: { cancel },
        },
        message: { list },
        event: { subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }) },
      }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.execution.finalizing",
      "session.execution.succeeded",
    ]);
    expect(streamEvent(last(received))).toEqual({ kind: "done" });
    expect(interrupt).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(received)).not.toContain("secret");
  });

  it("не выдаёт терминал и не висит, если canonical outcome ещё pending", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const list = vi.fn(async () => canonicalTurn("inbox-1"));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const gateway = createOpenCodeGateway(
      asClient({
        session: {
          get: async () => ownedInfo(),
          prompt: vi.fn(async () => ({ id: "inbox-1", sessionID: "ses-1", delivery: "queue" })),
          interrupt,
          inbox: { cancel: vi.fn(async () => undefined) },
        },
        message: { list },
        event: { subscribe: () => stream.value },
      }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.execution.finalizing",
      "session.execution.failed",
    ]);
    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Не удалось подтвердить результат OpenCode",
      reason: "unconfirmed",
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("не подтверждает done, если следующий assistant ещё tool-calls", async () => {
    const stream = rejectingSubscription(
      [
        event("server.connected"),
        event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      ],
      new Error("transport failed: secret upstream response"),
    );
    const list = vi.fn(async () => ({
      data: [
        { id: "inbox-1", type: "user", text: "Вопрос" },
        completedAssistant("assistant-1"),
        assistantMessage("assistant-2", { finish: "tool-calls" }),
      ],
      cursor: { next: null },
    }));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const gateway = createOpenCodeGateway(
      promptClient(stream, list, { interrupt, inbox: { cancel: vi.fn(async () => undefined) } }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.execution.finalizing",
      "session.execution.failed",
    ]);
    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Не удалось подтвердить результат OpenCode",
      reason: "unconfirmed",
    });
    expect(interrupt).not.toHaveBeenCalled();
    expect(JSON.stringify(received)).not.toContain("secret");
  });

  it("не подтверждает done по finish без numeric time.completed", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const list = vi.fn(async () => ({
      data: [
        { id: "inbox-1", type: "user", text: "Вопрос" },
        assistantMessage("assistant-1", { time: { created: 1 }, finish: "stop" }),
      ],
      cursor: { next: null },
    }));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const gateway = createOpenCodeGateway(
      promptClient(stream, list, { interrupt, inbox: { cancel: vi.fn(async () => undefined) } }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Не удалось подтвердить результат OpenCode",
      reason: "unconfirmed",
    });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("держит pending, если у failed assistant запланирован retry", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.failed", { sessionID: "ses-1" }),
    ]);
    const secret = "secret upstream response";
    const list = vi.fn(async () => ({
      data: [
        { id: "inbox-1", type: "user", text: "Вопрос" },
        assistantMessage("assistant-1", {
          finish: "error",
          error: { type: "provider", message: secret },
          retry: { attempt: 1, at: 3, error: { type: "provider", message: secret } },
        }),
      ],
      cursor: { next: null },
    }));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const gateway = createOpenCodeGateway(
      promptClient(stream, list, { interrupt, inbox: { cancel: vi.fn(async () => undefined) } }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Не удалось подтвердить результат OpenCode",
      reason: "unconfirmed",
    });
    expect(interrupt).not.toHaveBeenCalled();
    expect(JSON.stringify(received)).not.toContain("secret");
  });

  it("оставляет error для finish=error без error", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const list = vi.fn(async () => ({
      data: [
        { id: "inbox-1", type: "user", text: "Вопрос" },
        assistantMessage("assistant-1", { finish: "error" }),
      ],
      cursor: { next: null },
    }));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const gateway = createOpenCodeGateway(
      promptClient(stream, list, { interrupt, inbox: { cancel: vi.fn(async () => undefined) } }),
    );

    const received = await collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(received.map((item) => item.type)).toEqual([
      "server.connected",
      "session.execution.finalizing",
      "session.execution.failed",
    ]);
    expect(streamEvent(last(received))).toEqual({
      kind: "error",
      text: "Запрос OpenCode завершился с ошибкой",
    });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("прекращает canonical lookup по общему deadline и не прерывает execution", async () => {
    vi.useFakeTimers();
    try {
      const stream = subscription([
        event("server.connected"),
        event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
        event("session.execution.succeeded", { sessionID: "ses-1" }),
      ]);
      let lookupSignal: AbortSignal | undefined;
      const list = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
        lookupSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      });
      const interrupt = vi.fn(async () => ({ interrupted: true }));
      const gateway = createOpenCodeGateway(
        promptClient(stream, list, { interrupt, inbox: { cancel: vi.fn(async () => undefined) } }),
      );

      const consuming = collect(gateway.prompt("ses-1", "Вопрос", new AbortController().signal));
      await vi.advanceTimersByTimeAsync(10_000);
      const received = await consuming;

      expect(streamEvent(last(received))).toEqual({
        kind: "error",
        text: "Не удалось подтвердить результат OpenCode",
        reason: "unconfirmed",
      });
      expect(lookupSignal?.aborted).toBe(true);
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort во время canonical lookup отменяет fetch и вызывает prompt cancel", async () => {
    const stream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    let lookupSignal: AbortSignal | undefined;
    let startedLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      startedLookup = resolve;
    });
    const list = vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
      lookupSignal = options?.signal;
      startedLookup();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const cancel = vi.fn(async () => undefined);
    const gateway = createOpenCodeGateway(
      promptClient(stream, list, { interrupt, inbox: { cancel } }),
    );
    const controller = new AbortController();

    const consuming = collect(gateway.prompt("ses-1", "Вопрос", controller.signal));
    await lookupStarted;
    controller.abort();
    await consuming;

    expect(lookupSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith({ sessionID: "ses-1", inboxID: "inbox-1" });
    expect(interrupt).toHaveBeenCalledWith({ sessionID: "ses-1" });
  });

  it("игнорирует чужой inbox.cancelled после delivered и сохраняет свою отмену", async () => {
    const foreignStream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.inbox.cancelled", { sessionID: "ses-1", inboxID: "inbox-other" }),
      event("session.text.delta", {
        sessionID: "ses-1",
        assistantMessageID: "message-1",
        ordinal: 0,
        delta: "Ответ",
      }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const foreignList = vi.fn(async () => canonicalTurn("inbox-1", completedAssistant()));
    const foreign = createOpenCodeGateway(
      asClient({
        session: {
          get: async () => ownedInfo(),
          prompt: vi.fn(async () => ({ id: "inbox-1", sessionID: "ses-1", delivery: "queue" })),
        },
        message: { list: foreignList },
        event: { subscribe: () => foreignStream.value },
      }),
    );

    const foreignReceived = await collect(
      foreign.prompt("ses-1", "Вопрос", new AbortController().signal),
    );

    expect(foreignReceived.map((item) => item.type)).toEqual([
      "server.connected",
      "session.text.delta",
      "session.execution.finalizing",
      "session.execution.succeeded",
    ]);

    const ownStream = subscription([
      event("server.connected"),
      event("session.inbox.delivered", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.inbox.cancelled", { sessionID: "ses-1", inboxID: "inbox-1" }),
      event("session.execution.succeeded", { sessionID: "ses-1" }),
    ]);
    const ownList = vi.fn(async () => canonicalTurn("inbox-1", completedAssistant()));
    const own = createOpenCodeGateway(
      asClient({
        session: {
          get: async () => ownedInfo(),
          prompt: vi.fn(async () => ({ id: "inbox-1", sessionID: "ses-1", delivery: "queue" })),
        },
        message: { list: ownList },
        event: { subscribe: () => ownStream.value },
      }),
    );

    const ownReceived = await collect(own.prompt("ses-1", "Вопрос", new AbortController().signal));

    expect(ownReceived.map((item) => item.type)).toEqual([
      "server.connected",
      "session.inbox.cancelled",
    ]);
    expect(streamEvent(last(ownReceived))).toEqual({
      kind: "cancelled",
      text: "Запрос остановлен",
    });
    expect(ownList).not.toHaveBeenCalled();
  });

  it("маппит 413 и 415 upstream в публичную validation error", async () => {
    for (const status of [413, 415]) {
      const gateway = createOpenCodeGateway(
        asClient({
          server: {
            info: vi.fn(async () => {
              throw { status };
            }),
          },
        }),
      );
      await expect(gateway.status()).rejects.toEqual(
        new OpenCodeGatewayError("VALIDATION_ERROR", "OpenCode отклонил аргументы запроса"),
      );
    }
  });

  it("abort прерывает ожидание события и вызывает session.interrupt", async () => {
    const pending = new Promise<IteratorResult<OpenCodeEvent>>(() => undefined);
    const iterator = {
      next: vi
        .fn<() => Promise<IteratorResult<OpenCodeEvent>>>()
        .mockResolvedValueOnce({ done: false, value: event("server.connected") })
        .mockReturnValue(pending),
      return: vi.fn(async (): Promise<IteratorResult<OpenCodeEvent>> => ({
        done: true,
        value: undefined,
      })),
    };
    const prompt = vi.fn(async () => ({
      id: "inbox-1",
      sessionID: "ses-1",
      delivery: "queue",
    }));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const cancel = vi.fn(async () => undefined);
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt, interrupt, inbox: { cancel } },
        event: { subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }) },
      }),
    );
    const controller = new AbortController();

    const consuming = (async () => {
      for await (const item of gateway.prompt("ses-1", "Вопрос", controller.signal)) {
        void item;
        // Ждём abort после server.connected.
      }
    })();
    await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledTimes(2));
    controller.abort();
    await consuming;

    expect(cancel).toHaveBeenCalledWith({ sessionID: "ses-1", inboxID: "inbox-1" });
    expect(interrupt).toHaveBeenCalledWith({ sessionID: "ses-1" });
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });

  it("abort во время admission ждёт inbox ID и только затем отменяет input", async () => {
    const stream = subscription([event("server.connected")]);
    let admit!: (value: { id: string }) => void;
    const admission = new Promise<{ id: string }>((resolve) => {
      admit = resolve;
    });
    const prompt = vi.fn(() => admission);
    const cancel = vi.fn(async () => undefined);
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt, interrupt, inbox: { cancel } },
        event: { subscribe: () => stream.value },
      }),
    );
    const controller = new AbortController();

    const consuming = (async () => {
      for await (const item of gateway.prompt("ses-1", "Вопрос", controller.signal)) {
        void item;
        // Admission ещё не завершён.
      }
    })();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    controller.abort();
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();

    admit({ id: "inbox-admitted" });
    await consuming;

    expect(cancel).toHaveBeenCalledWith({ sessionID: "ses-1", inboxID: "inbox-admitted" });
    expect(interrupt).toHaveBeenCalledWith({ sessionID: "ses-1" });
    expect(stream.iterator.return).toHaveBeenCalledTimes(1);
  });
});
