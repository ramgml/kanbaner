import {
  createPluginError,
  toErrorResult,
  toSuccessResult,
  type PluginErrorCode,
} from "@kanbaner/plugin-sdk";
import {
  ATTACHMENT_LIMITS,
  ensureOpenCodeGateway,
  isRecord,
  OpenCodeGatewayError,
  OPENCODE_AGENT_ID,
  streamEvent,
  type OpenCodeGateway,
  type OpenCodeModelRefView,
  type OpenCodePromptAttachment,
} from "@kanbaner/opencode";

import { parsePromptAttachments } from "./opencode-attachments.ts";

let gatewayPromise: Promise<OpenCodeGateway> | undefined;

export function getOpenCodeGateway(): Promise<OpenCodeGateway> {
  const current = gatewayPromise;
  if (current !== undefined) return current;

  const promise = ensureOpenCodeGateway();
  gatewayPromise = promise;
  promise.catch(() => {
    if (gatewayPromise === promise) gatewayPromise = undefined;
  });
  return promise;
}

class PublicHttpError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PublicHttpError";
  }
}

function httpStatus(code: PluginErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "PERMISSION_DENIED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VERSION_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "CANCELLED":
    case "TIMEOUT":
      return 408;
    case "DEPENDENCY_UNAVAILABLE":
    case "PLUGIN_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function failure(code: PluginErrorCode, message: string): Response {
  return Response.json(toErrorResult(createPluginError(code, message)), {
    status: httpStatus(code),
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function internalError(error: unknown): Response {
  if (error instanceof PublicHttpError) return failure(error.code, error.message);
  if (error instanceof OpenCodeGatewayError) {
    if (error.code === "DEPENDENCY_UNAVAILABLE") gatewayPromise = undefined;
    return failure(error.code, error.message);
  }
  gatewayPromise = undefined;
  return failure("DEPENDENCY_UNAVAILABLE", "OpenCode Service недоступен");
}

function uiGuard(request: Request): Response | null {
  const client = request.headers.get("x-kanbaner-client");
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const expectedOrigin = host === null ? url.origin : new URL(`${url.protocol}//${host}`).origin;

  if (
    client !== "ui" ||
    (fetchSite !== null && fetchSite !== "same-origin") ||
    (origin !== null && origin !== expectedOrigin)
  ) {
    return failure("PERMISSION_DENIED", "Запрос разрешён только из интерфейса Kanbaner");
  }
  return null;
}

function success(data: unknown): Response {
  return Response.json(toSuccessResult(data), {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function attachmentIndex(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d{0,8})$/u.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) return undefined;
  return parsed;
}

export async function handleOpenCodeStatus(request: Request): Promise<Response> {
  const denied = uiGuard(request);
  if (denied !== null) return denied;
  try {
    const gateway = await getOpenCodeGateway();
    return success(await gateway.status());
  } catch (error) {
    return internalError(error);
  }
}

export async function handleOpenCodeCatalog(request: Request): Promise<Response> {
  const denied = uiGuard(request);
  if (denied !== null) return denied;
  try {
    const gateway = await getOpenCodeGateway();
    return success(await gateway.catalog());
  } catch (error) {
    return internalError(error);
  }
}

function modelInput(value: unknown): OpenCodeModelRefView | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : "";
  const variant = typeof value.variant === "string" ? value.variant.trim() : value.variant;
  if (id.length === 0 || providerID.length === 0) return undefined;
  if (variant !== undefined && (typeof variant !== "string" || variant.length === 0)) {
    return undefined;
  }
  return {
    id,
    providerID,
    ...(typeof variant === "string" ? { variant } : {}),
  };
}

async function jsonBody(request: Request, maxBytes = 120_000): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PublicHttpError("VALIDATION_ERROR", "Тело запроса слишком большое");
  }
  const text = await request.text();
  if (text.trim().length === 0) return {};
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new PublicHttpError("VALIDATION_ERROR", "Тело запроса слишком большое");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new PublicHttpError("VALIDATION_ERROR", "Ожидается Content-Type application/json");
  }
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) {
      throw new PublicHttpError("VALIDATION_ERROR", "Тело запроса должно быть JSON-объектом");
    }
    return body;
  } catch (error) {
    if (error instanceof PublicHttpError) throw error;
    throw new PublicHttpError("VALIDATION_ERROR", "Тело запроса должно содержать корректный JSON");
  }
}

export async function handleOpenCodeSessionCreate(request: Request): Promise<Response> {
  const denied = uiGuard(request);
  if (denied !== null) return denied;
  try {
    const input = await jsonBody(request);
    if (
      input.agent !== undefined &&
      (typeof input.agent !== "string" || input.agent !== OPENCODE_AGENT_ID)
    ) {
      throw new PublicHttpError("VALIDATION_ERROR", "Разрешён только агент kanbaner");
    }
    if ("model" in input && modelInput(input.model) === undefined) {
      throw new PublicHttpError("VALIDATION_ERROR", "Некорректная модель");
    }
    const model = modelInput(input.model);
    const gateway = await getOpenCodeGateway();
    const session = await gateway.createSession({
      agent: OPENCODE_AGENT_ID,
      ...(model === undefined ? {} : { model }),
    });
    return success(session);
  } catch (error) {
    return internalError(error);
  }
}

export async function handleOpenCodeSessionGet(
  sessionID: string,
  request: Request,
): Promise<Response> {
  const denied = uiGuard(request);
  if (denied !== null) return denied;
  try {
    const gateway = await getOpenCodeGateway();
    return success(await gateway.getSession(sessionID));
  } catch (error) {
    return internalError(error);
  }
}

/**
 * UI-only binary preview вложения canonical history. Ответ не является JSON
 * envelope и не содержит Base64: только image bytes с явным Content-Type.
 */
export async function handleOpenCodeAttachmentPreview(
  sessionID: string,
  messageID: string,
  rawAttachmentIndex: string,
  request: Request,
): Promise<Response> {
  const denied = uiGuard(request);
  if (denied !== null) return denied;
  const index = attachmentIndex(rawAttachmentIndex);
  if (index === undefined) {
    return failure("VALIDATION_ERROR", "Некорректный индекс вложения");
  }
  try {
    const gateway = await getOpenCodeGateway();
    const preview = await gateway.getAttachmentPreview(sessionID, messageID, index);
    const bytes = new Uint8Array(preview.bytes.byteLength);
    bytes.set(preview.bytes);
    return new Response(bytes, {
      headers: {
        "cache-control": "no-store",
        "content-type": preview.mime,
        "content-length": String(bytes.byteLength),
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return internalError(error);
  }
}

export async function handleOpenCodeModelSwitch(
  sessionID: string,
  request: Request,
): Promise<Response> {
  const denied = uiGuard(request);
  if (denied !== null) return denied;
  try {
    const body = await jsonBody(request);
    const model = modelInput(body.model);
    if (model === undefined) {
      throw new PublicHttpError("VALIDATION_ERROR", "Требуется корректная модель");
    }
    const gateway = await getOpenCodeGateway();
    await gateway.switchModel(sessionID, model);
    return success({ switched: true });
  } catch (error) {
    return internalError(error);
  }
}

function ndjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export async function handleOpenCodePrompt(sessionID: string, request: Request): Promise<Response> {
  const denied = uiGuard(request);
  if (denied !== null) return denied;
  let gateway: OpenCodeGateway;
  let text: string;
  let attachments: readonly OpenCodePromptAttachment[] = [];
  const abortController = new AbortController();
  const signal = abortController.signal;
  const onAbort = (): void => abortController.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) abortController.abort();

  try {
    const body = await jsonBody(request, ATTACHMENT_LIMITS.maxRequestBytes);
    text = typeof body.text === "string" ? body.text.trim() : "";
    attachments = parsePromptAttachments(body.files);
    if (text.length === 0) {
      throw new PublicHttpError("VALIDATION_ERROR", "Текст запроса не должен быть пустым");
    }
    if (text.length > 100_000) {
      throw new PublicHttpError("VALIDATION_ERROR", "Текст запроса слишком большой");
    }
    if (signal.aborted) throw new PublicHttpError("CANCELLED", "Запрос OpenCode отменён");
    gateway = await getOpenCodeGateway();
    if (signal.aborted) throw new PublicHttpError("CANCELLED", "Запрос OpenCode отменён");
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    if (
      signal.aborted &&
      !(error instanceof PublicHttpError && error.code === "VALIDATION_ERROR")
    ) {
      return failure("CANCELLED", "Запрос OpenCode отменён");
    }
    return internalError(error);
  }
  let closed = false;
  let terminal = false;
  const close = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Поток мог быть уже закрыт отменой.
    }
  };
  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    value: unknown,
  ): boolean => {
    if (closed) return false;
    try {
      controller.enqueue(ndjson(value));
      return true;
    } catch {
      closed = true;
      abortController.abort();
      return false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of gateway.prompt(sessionID, text, signal, attachments)) {
          if (closed) return;
          const mapped = streamEvent(event);
          if (mapped === null) continue;
          if (mapped.kind === "done" || mapped.kind === "cancelled" || mapped.kind === "error") {
            terminal = true;
          }
          if (!emit(controller, mapped)) return;
        }
        if (!terminal && !signal.aborted) {
          emit(controller, { kind: "error", text: "OpenCode завершил поток без результата" });
        }
        close(controller);
      } catch {
        if (!closed && !signal.aborted) {
          emit(controller, { kind: "error", text: "Запрос OpenCode завершился с ошибкой" });
        }
        close(controller);
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    },
    cancel() {
      closed = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

export function setOpenCodeGatewayForTests(gateway: OpenCodeGateway | undefined): void {
  gatewayPromise = gateway === undefined ? undefined : Promise.resolve(gateway);
}

export function resetOpenCodeGatewayForTests(): void {
  gatewayPromise = undefined;
}
