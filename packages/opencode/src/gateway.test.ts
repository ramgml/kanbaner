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
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt },
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
      "session.execution.succeeded",
    ]);
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
    const gateway = createOpenCodeGateway(
      asClient({
        session: { get: async () => ownedInfo(), prompt },
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
