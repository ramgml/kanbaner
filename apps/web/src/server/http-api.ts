import { createHash, timingSafeEqual } from "node:crypto";

import { KERNEL_API_VERSION, type OperationDescriptor, type OperationKind } from "@kanbaner/kernel";
import {
  createPluginError,
  isResourceRef,
  PLUGIN_CONTRACT_VERSION_NUMBER,
  toErrorResult,
  toSuccessResult,
  type JsonValue,
  type OperationResult,
  type PluginErrorCode,
  type ResourceDescriptor,
  type ResourceRef,
} from "@kanbaner/plugin-sdk";

import type { PluginManagerState } from "../lib/plugin-manager-types.ts";
import type { HttpOperationInvokeOptions } from "./application-composition.ts";
import { getPluginService } from "./plugin-service.ts";

/** Минимальный backend HTTP transport; тесты могут подменить singleton приложения. */
export interface HttpApiBackend {
  getState(): Promise<PluginManagerState>;
  listHttpOperations(): Promise<readonly OperationDescriptor[]>;
  executeHttpOperation(
    operationId: string,
    input: JsonValue,
    options: HttpOperationInvokeOptions,
  ): Promise<OperationResult<unknown>>;
  resolveHttpResource(ref: ResourceRef): Promise<OperationResult<ResourceDescriptor>>;
}

export interface HttpApiOptions {
  /** Источник серверного токена; значение никогда не попадает в ответ. */
  readonly getToken?: () => string | undefined;
}

const ERROR_HTTP_STATUS: Readonly<Record<PluginErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PERMISSION_DENIED: 403,
  DEPENDENCY_UNAVAILABLE: 503,
  PLUGIN_UNAVAILABLE: 503,
  CANCELLED: 400,
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
});

function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();

  if (
    supplied !== undefined &&
    supplied.length > 0 &&
    supplied.length <= 200 &&
    /^[\x21-\x7E]+$/u.test(supplied)
  ) {
    return supplied;
  }

  return globalThis.crypto.randomUUID();
}

function jsonResponse(
  result: OperationResult<unknown>,
  id: string,
  status?: number,
  headers?: Readonly<Record<string, string>>,
): Response {
  return Response.json(result, {
    status: status ?? (result.ok ? 200 : ERROR_HTTP_STATUS[result.error.code]),
    headers: {
      "cache-control": "no-store",
      "x-request-id": id,
      ...headers,
    },
  });
}

function failure(
  code: PluginErrorCode,
  message: string,
  id: string,
  status?: number,
  headers?: Readonly<Record<string, string>>,
): Response {
  return jsonResponse(toErrorResult(createPluginError(code, message)), id, status, headers);
}

function tokensEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();

  return timingSafeEqual(leftDigest, rightDigest);
}

function authorize(request: Request, id: string, token: string | undefined): Response | null {
  if (token === undefined || token.length === 0) {
    return failure("DEPENDENCY_UNAVAILABLE", "HTTP API token не настроен на сервере", id, 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const scheme = authorization.slice(0, 7);
  const supplied = authorization.slice(7);

  if (
    scheme.toLowerCase() !== "bearer " ||
    supplied.length === 0 ||
    !tokensEqual(supplied, token)
  ) {
    return failure("PERMISSION_DENIED", "Требуется действительный Bearer token", id, 401, {
      "www-authenticate": "Bearer",
    });
  }

  return null;
}

function internalFailure(id: string): Response {
  return failure("INTERNAL_ERROR", "Не удалось обработать HTTP API запрос", id, 500);
}

async function inputFrom(request: Request): Promise<JsonValue> {
  const body = await request.text();

  if (body.trim().length === 0) {
    return {};
  }

  return JSON.parse(body) as JsonValue;
}

function discoveryData(operations: readonly OperationDescriptor[]) {
  return {
    apiVersion: KERNEL_API_VERSION,
    contractVersion: PLUGIN_CONTRACT_VERSION_NUMBER,
    operations: operations.map((descriptor) => ({
      id: descriptor.id,
      kind: descriptor.kind,
      pluginId: descriptor.pluginId,
      contract: descriptor.metadata.contract,
      version: descriptor.metadata.version,
      risk: descriptor.metadata.risk,
      ...(descriptor.metadata.kind === "mutation"
        ? { idempotency: descriptor.metadata.idempotency }
        : {}),
      inputSchema: descriptor.metadata.inputSchema,
      outputSchema: descriptor.metadata.outputSchema,
      ...(descriptor.metadata.description === undefined
        ? {}
        : { description: descriptor.metadata.description }),
    })),
  };
}

/**
 * Создаёт framework-independent обработчики Route Handler-ов.
 *
 * Все методы используют Web Request/Response API. Маршруты Next.js только
 * извлекают path parameters и делегируют сюда, поэтому транспорт можно
 * проверять integration-тестами без запуска браузера.
 */
export function createHttpApi(backend: HttpApiBackend, options: HttpApiOptions = {}) {
  const getToken = options.getToken ?? (() => process.env.KANBANER_API_TOKEN);

  async function health(request: Request): Promise<Response> {
    const id = requestId(request);

    try {
      const state = await backend.getState();
      const status = state.started ? "ok" : "degraded";

      return jsonResponse(
        toSuccessResult({ status, safeMode: state.safeMode, started: state.started }),
        id,
        state.started ? 200 : 503,
      );
    } catch {
      return failure("DEPENDENCY_UNAVAILABLE", "Приложение не готово", id, 503);
    }
  }

  async function discovery(request: Request): Promise<Response> {
    const id = requestId(request);
    const denied = authorize(request, id, getToken());

    if (denied !== null) {
      return denied;
    }

    try {
      return jsonResponse(toSuccessResult(discoveryData(await backend.listHttpOperations())), id);
    } catch {
      return internalFailure(id);
    }
  }

  async function operation(
    request: Request,
    operationId: string,
    expectedKind: OperationKind,
  ): Promise<Response> {
    const id = requestId(request);
    const denied = authorize(request, id, getToken());

    if (denied !== null) {
      return denied;
    }

    let input: JsonValue;

    try {
      input = await inputFrom(request);
    } catch {
      return failure("VALIDATION_ERROR", "Тело запроса должно содержать корректный JSON", id, 400);
    }

    try {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      const result = await backend.executeHttpOperation(operationId, input, {
        expectedKind,
        requestId: id,
        signal: request.signal,
        ...(idempotencyKey === undefined || idempotencyKey.length === 0 ? {} : { idempotencyKey }),
      });

      return jsonResponse(result, id);
    } catch {
      return internalFailure(id);
    }
  }

  function command(request: Request, operationId: string): Promise<Response> {
    return operation(request, operationId, "mutation");
  }

  function query(request: Request, operationId: string): Promise<Response> {
    return operation(request, operationId, "query");
  }

  async function resource(request: Request, ref: string): Promise<Response> {
    const id = requestId(request);
    const denied = authorize(request, id, getToken());

    if (denied !== null) {
      return denied;
    }

    if (!isResourceRef(ref)) {
      return failure("VALIDATION_ERROR", "Некорректная ссылка на ресурс", id, 400);
    }

    try {
      return jsonResponse(await backend.resolveHttpResource(ref), id);
    } catch {
      return internalFailure(id);
    }
  }

  return Object.freeze({
    health,
    discovery,
    command,
    query,
    resource,
  });
}

let defaultApi: ReturnType<typeof createHttpApi> | undefined;

function api(): ReturnType<typeof createHttpApi> {
  defaultApi ??= createHttpApi(getPluginService());

  return defaultApi;
}

export function handleHealthRequest(request: Request): Promise<Response> {
  return api().health(request);
}

export function handleDiscoveryRequest(request: Request): Promise<Response> {
  return api().discovery(request);
}

export function handleCommandRequest(request: Request, commandId: string): Promise<Response> {
  return api().command(request, commandId);
}

export function handleQueryRequest(request: Request, queryId: string): Promise<Response> {
  return api().query(request, queryId);
}

export function handleResourceRequest(request: Request, ref: string): Promise<Response> {
  return api().resource(request, ref);
}
