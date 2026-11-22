// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_LIMITS,
  OpenCodeGatewayError,
  OPENCODE_MCP_TOOLS,
  type OpenCodeCatalog,
  type OpenCodeEvent,
  type OpenCodeGateway,
  type OpenCodePromptAttachment,
  type OpenCodeSessionView,
} from "@kanbaner/opencode";

import { parsePromptAttachments } from "./opencode-attachments.ts";
import {
  handleOpenCodeAttachmentPreview,
  handleOpenCodeCatalog,
  handleOpenCodePrompt,
  handleOpenCodeSessionCreate,
  handleOpenCodeSessionGet,
  resetOpenCodeGatewayForTests,
  setOpenCodeGatewayForTests,
} from "./opencode-http.ts";

const session: OpenCodeSessionView = {
  id: "ses-1",
  title: "Kanbaner chat",
  agent: "kanbaner",
  model: { id: "model-1", providerID: "provider-1" },
  messages: [],
};

const catalog: OpenCodeCatalog = {
  providers: [{ id: "provider-1", name: "Provider", activation: "enabled" }],
  models: [{ id: "model-1", providerID: "provider-1", name: "Model", type: "chat", variants: [] }],
  agents: [{ id: "kanbaner", name: "Kanbaner", description: null }],
  tools: OPENCODE_MCP_TOOLS,
  defaultModel: { id: "model-1", providerID: "provider-1" },
};

function event(type: string, data: Record<string, unknown> = {}): OpenCodeEvent {
  return { id: type, created: 1, type, data } as OpenCodeEvent;
}

function gateway(overrides: Partial<OpenCodeGateway> = {}): OpenCodeGateway {
  return {
    status: vi.fn(async () => ({ available: true as const, version: "2.2.5" })),
    catalog: vi.fn(async () => catalog),
    createSession: vi.fn(async () => session),
    getSession: vi.fn(async () => session),
    getAttachmentPreview: vi.fn(async () => ({
      name: "pixel.png",
      mime: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })),
    switchModel: vi.fn(async () => undefined),
    prompt: vi.fn(async function* () {
      yield event("session.execution.succeeded", { sessionID: "ses-1" });
    }),
    ...overrides,
  };
}

function request(url: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      "x-kanbaner-client": "ui",
      "sec-fetch-site": "same-origin",
      origin: "http://localhost",
      ...init.headers,
    },
  });
}

async function body(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

afterEach(() => {
  resetOpenCodeGatewayForTests();
});

describe("OpenCode UI HTTP transport", () => {
  it("отклоняет не-UI и cross-origin запросы до обращения к Service", async () => {
    const mock = gateway();
    setOpenCodeGatewayForTests(mock);

    const missing = await handleOpenCodeCatalog(
      new Request("http://localhost/api/opencode/catalog"),
    );
    const crossOrigin = await handleOpenCodeCatalog(
      new Request("http://localhost/api/opencode/catalog", {
        headers: {
          "x-kanbaner-client": "ui",
          "sec-fetch-site": "cross-site",
          origin: "https://attacker.invalid",
        },
      }),
    );

    expect(missing.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(mock.catalog).not.toHaveBeenCalled();
  });

  it("сравнивает Origin с фактическим Host при внутреннем URL Next", async () => {
    const mock = gateway();
    setOpenCodeGatewayForTests(mock);

    const response = await handleOpenCodeSessionCreate(
      new Request("http://internal.invalid/api/opencode/session", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "x-kanbaner-client": "ui",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    expect(mock.createSession).toHaveBeenCalledOnce();
  });

  it("валидирует JSON, модель и фиксированного агента без запуска Service", async () => {
    const mock = gateway();
    setOpenCodeGatewayForTests(mock);
    const malformed = await handleOpenCodeSessionCreate(
      request("/api/opencode/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      }),
    );
    const wrongAgent = await handleOpenCodeSessionCreate(
      request("/api/opencode/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "build" }),
      }),
    );
    const wrongModel = await handleOpenCodeSessionCreate(
      request("/api/opencode/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { id: "", providerID: "provider-1" } }),
      }),
    );

    expect(malformed.status).toBe(400);
    expect(wrongAgent.status).toBe(400);
    expect(wrongModel.status).toBe(400);
    expect(mock.createSession).not.toHaveBeenCalled();
  });

  it("создаёт только сессию kanbaner и возвращает no-store envelope", async () => {
    const mock = gateway();
    setOpenCodeGatewayForTests(mock);

    const response = await handleOpenCodeSessionCreate(
      request("/api/opencode/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "kanbaner",
          model: { id: " model-1 ", providerID: " provider-1 " },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mock.createSession).toHaveBeenCalledWith({
      agent: "kanbaner",
      model: { id: "model-1", providerID: "provider-1" },
    });
    expect(await body(response)).toEqual({ ok: true, data: session });
  });

  it("маппит NOT_FOUND и скрывает произвольные upstream ошибки", async () => {
    const missing = gateway({
      getSession: vi.fn(async () => {
        throw new OpenCodeGatewayError("NOT_FOUND", "Сессия OpenCode не найдена");
      }),
    });
    setOpenCodeGatewayForTests(missing);
    const notFound = await handleOpenCodeSessionGet(
      "missing",
      request("/api/opencode/session/missing"),
    );
    expect(notFound.status).toBe(404);

    const failed = gateway({
      getSession: vi.fn(async () => {
        throw new Error("secret provider response and headers");
      }),
    });
    setOpenCodeGatewayForTests(failed);
    const unavailable = await handleOpenCodeSessionGet(
      "ses-1",
      request("/api/opencode/session/ses-1"),
    );
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await body(unavailable))).not.toContain("secret provider");
  });

  it("возвращает binary image preview без JSON envelope и Base64", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const preview = vi.fn(async () => ({ name: "pixel.png", mime: "image/png", bytes: png }));
    const mock = gateway({ getAttachmentPreview: preview });
    setOpenCodeGatewayForTests(mock);

    const response = await handleOpenCodeAttachmentPreview(
      "ses-1",
      "user-1",
      "0",
      request("/api/opencode/session/ses-1/messages/user-1/attachments/0"),
    );
    const received = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(received).toEqual(png);
    expect(new TextDecoder().decode(received).startsWith("{")).toBe(false);
    expect(preview).toHaveBeenCalledWith("ses-1", "user-1", 0);
  });

  it("требует uiGuard и валидный safe index до обращения к gateway", async () => {
    const preview = vi.fn();
    const mock = gateway({ getAttachmentPreview: preview });
    setOpenCodeGatewayForTests(mock);

    const missing = await handleOpenCodeAttachmentPreview(
      "ses-1",
      "user-1",
      "0",
      new Request("http://localhost/api/opencode/session/ses-1/messages/user-1/attachments/0"),
    );
    const crossOrigin = await handleOpenCodeAttachmentPreview(
      "ses-1",
      "user-1",
      "0",
      new Request("http://localhost/api/opencode/session/ses-1/messages/user-1/attachments/0", {
        headers: {
          "x-kanbaner-client": "ui",
          "sec-fetch-site": "cross-site",
          origin: "https://attacker.invalid",
        },
      }),
    );

    expect(missing.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    for (const index of ["-1", "1.5", "abc", "01", "1e2", "99999999999", "0\n"]) {
      const response = await handleOpenCodeAttachmentPreview(
        "ses-1",
        "user-1",
        index,
        request(
          `/api/opencode/session/ses-1/messages/user-1/attachments/${encodeURIComponent(index)}`,
        ),
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await body(response))).toContain("индекс вложения");
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it("не раскрывает preview bytes и upstream errors", async () => {
    const notFound = gateway({
      getAttachmentPreview: vi.fn(async () => {
        throw new OpenCodeGatewayError("NOT_FOUND", "Вложение OpenCode не найдено");
      }),
    });
    setOpenCodeGatewayForTests(notFound);
    const missing = await handleOpenCodeAttachmentPreview(
      "ses-1",
      "user-1",
      "0",
      request("/api/opencode/session/ses-1/messages/user-1/attachments/0"),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    const missingText = await missing.text();
    expect(missingText).not.toContain("iVBOR");
    expect(missingText).not.toContain("base64");

    const failed = gateway({
      getAttachmentPreview: vi.fn(async () => {
        throw new Error("secret upstream bytes");
      }),
    });
    setOpenCodeGatewayForTests(failed);
    const unavailable = await handleOpenCodeAttachmentPreview(
      "ses-1",
      "user-1",
      "0",
      request("/api/opencode/session/ses-1/messages/user-1/attachments/0"),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("secret upstream");
  });

  it("не запускает prompt, если request отменён до готовности gateway", async () => {
    const mock = gateway();
    setOpenCodeGatewayForTests(mock);
    const controller = new AbortController();
    const cancelled = request("/api/opencode/session/ses-1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Вопрос" }),
      signal: controller.signal,
    });
    controller.abort();

    const response = await handleOpenCodePrompt("ses-1", cancelled);

    expect(response.status).toBe(408);
    expect(mock.prompt).not.toHaveBeenCalled();
  });

  it("завершает NDJSON после terminal execution", async () => {
    const mock = gateway({
      prompt: vi.fn(async function* () {
        yield event("session.text.delta", {
          sessionID: "ses-1",
          assistantMessageID: "message-1",
          ordinal: 0,
          delta: "Ответ",
        });
        yield event("session.execution.succeeded", { sessionID: "ses-1" });
      }),
    });
    setOpenCodeGatewayForTests(mock);

    const response = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Вопрос" }),
      }),
    );
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string });

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(lines).toEqual([{ kind: "delta", id: "message-1:0", text: "Ответ" }, { kind: "done" }]);
  });

  it("cancel закрывает prompt signal без записи в закрытый stream", async () => {
    let promptSignal: AbortSignal | undefined;
    const mock = gateway({
      prompt: vi.fn(async function* (_sessionID: string, _text: string, signal: AbortSignal) {
        promptSignal = signal;
        yield event("server.connected");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    });
    setOpenCodeGatewayForTests(mock);

    const response = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Вопрос" }),
      }),
    );
    if (response.body === null) throw new Error("Stream body is missing");
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();

    expect(promptSignal?.aborted).toBe(true);
  });

  it("abort одновременно с gateway exception всё равно закрывает NDJSON", async () => {
    const mock = gateway({
      prompt: vi.fn(async function* (_sessionID: string, _text: string, signal: AbortSignal) {
        yield event("server.connected");
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("abort race")), { once: true });
        });
      }),
    });
    setOpenCodeGatewayForTests(mock);
    const controller = new AbortController();
    const response = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Вопрос" }),
        signal: controller.signal,
      }),
    );
    if (response.body === null) throw new Error("Stream body is missing");
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();

    const terminal = await reader.read();
    expect(terminal.done).toBe(true);
  });

  it("stream exception превращается в публичную ошибку без upstream message", async () => {
    const mock = gateway({
      prompt: vi.fn(async function* () {
        throw new Error("secret upstream stream");
      }),
    });
    setOpenCodeGatewayForTests(mock);

    const response = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Вопрос" }),
      }),
    );
    const text = await response.text();

    expect(text).toContain('"kind":"error"');
    expect(text).not.toContain("secret upstream");
  });

  it("принимает поддерживаемые image/PDF сигнатуры и нормализует data URL", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const gif = Buffer.from("GIF89a", "ascii");
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "ascii"),
    ]);
    const pdf = Buffer.from("%PDF-1.7\n", "ascii");
    const cases = [
      { name: "image.png", mime: "", bytes: png, expected: "image/png" },
      { name: "photo.jpg", mime: "", bytes: jpeg, expected: "image/jpeg" },
      { name: "anim.gif", mime: "", bytes: gif, expected: "image/gif" },
      { name: "picture.webp", mime: "", bytes: webp, expected: "image/webp" },
      {
        name: "document.pdf",
        mime: "application/octet-stream",
        bytes: pdf,
        expected: "application/pdf",
      },
    ];

    for (const testCase of cases) {
      const base64 = testCase.bytes.toString("base64");
      const attachments = parsePromptAttachments([
        { name: testCase.name, mime: testCase.mime, base64 },
      ]);
      expect(attachments).toEqual([
        { name: testCase.name, dataUri: `data:${testCase.expected};base64,${base64}` },
      ]);
    }
  });

  it("передаёт text-файл в gateway только как inline data URL", async () => {
    let received: readonly OpenCodePromptAttachment[] | undefined;
    const mock = gateway({
      prompt: vi.fn(async function* (
        _sessionID: string,
        _text: string,
        _signal: AbortSignal,
        attachments: readonly OpenCodePromptAttachment[] = [],
      ) {
        received = attachments;
        yield event("session.execution.succeeded", { sessionID: "ses-1" });
      }),
    });
    setOpenCodeGatewayForTests(mock);
    const base64 = Buffer.from("hello", "utf8").toString("base64");

    const response = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Что в файле?",
          files: [{ name: "notes.txt", mime: "text/plain", base64 }],
        }),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(received).toEqual([{ name: "notes.txt", dataUri: `data:text/plain;base64,${base64}` }]);
  });

  it("отклоняет неканонический Base64, пути, URI, non-UTF8 и неверные signatures", async () => {
    const mock = gateway();
    setOpenCodeGatewayForTests(mock);
    const textBytes = Buffer.from("hello", "utf8").toString("base64");
    const cases = [
      {
        files: [{ name: "a.txt", mime: "text/plain", base64: "not-base64" }],
        message: "Base64",
      },
      {
        files: [
          { name: "a.txt", mime: "text/plain", base64: textBytes, uri: "file:///etc/passwd" },
        ],
        message: "только name, mime и base64",
      },
      {
        files: [{ name: "../secret.txt", mime: "text/plain", base64: textBytes }],
        message: "не должно содержать путь",
      },
      {
        files: [
          {
            name: "bad.txt",
            mime: "text/plain",
            base64: Buffer.from([0xff, 0xfe]).toString("base64"),
          },
        ],
        message: "UTF-8",
      },
      {
        files: [
          {
            name: "fake.png",
            mime: "image/png",
            base64: Buffer.from("not a png").toString("base64"),
          },
        ],
        message: "не соответствует формату",
      },
      {
        files: [
          {
            name: "fake.pdf",
            mime: "application/pdf",
            base64: Buffer.from("hello").toString("base64"),
          },
        ],
        message: "PDF-сигнатуру",
      },
    ];

    for (const testCase of cases) {
      const response = await handleOpenCodePrompt(
        "ses-1",
        request("/api/opencode/session/ses-1/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Файл", files: testCase.files }),
        }),
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await body(response))).toContain(testCase.message);
    }
    expect(mock.prompt).not.toHaveBeenCalled();
  });

  it("ограничивает число файлов, размер файла и размер request body", async () => {
    const mock = gateway();
    setOpenCodeGatewayForTests(mock);
    const base64 = Buffer.from("hello", "utf8").toString("base64");
    const sixFiles = Array.from({ length: 6 }, (_value, index) => ({
      name: `file-${index}.txt`,
      mime: "text/plain",
      base64,
    }));
    const many = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Файлы", files: sixFiles }),
      }),
    );
    expect(many.status).toBe(400);
    expect(JSON.stringify(await body(many))).toContain("не больше 5 файлов");

    const oversized = Buffer.alloc(ATTACHMENT_LIMITS.maxTextBytes + 1, 0x61);
    const large = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Большой файл",
          files: [{ name: "large.txt", mime: "text/plain", base64: oversized.toString("base64") }],
        }),
      }),
    );
    expect(large.status).toBe(400);
    expect(JSON.stringify(await body(large))).toContain("1 MiB");

    const tooLarge = await handleOpenCodePrompt(
      "ses-1",
      request("/api/opencode/session/ses-1/prompt", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(ATTACHMENT_LIMITS.maxRequestBytes + 1),
        },
        body: "{}",
      }),
    );
    expect(tooLarge.status).toBe(400);
    expect(JSON.stringify(await body(tooLarge))).toContain("слишком большое");
    expect(mock.prompt).not.toHaveBeenCalled();
  });
});
