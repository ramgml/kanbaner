import { createHash } from "node:crypto";

import { createSchemaValidator } from "@kanbaner/plugin-sdk";

import type { UniversalMcpConfig } from "./config.ts";
import { createFailure, failureFromError, readUpstreamFailure, type McpFailure } from "./errors.ts";
import { requestJson, type FetchLike } from "./http.ts";
import { isPlainObject, stableJson } from "./json.ts";
import type { UniversalTool } from "./tools.ts";

type SchemaParameter = Parameters<typeof createSchemaValidator>[0];

export interface CallIdentity {
  readonly requestId: string | number;
  readonly sessionId?: string | undefined;
  /** Идентификатор процесса MCP-сервера, стабильный на всё время жизни. */
  readonly instanceId: string;
  readonly processId: string;
}

export type InvokeOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: McpFailure };

export interface OperationInvokerOptions {
  readonly config: UniversalMcpConfig;
  readonly fetchImpl?: FetchLike;
}

export interface OperationInvoker {
  invoke(
    tool: UniversalTool,
    input: unknown,
    identity: CallIdentity,
    signal?: AbortSignal | undefined,
  ): Promise<InvokeOutcome>;
}

/**
 * Ключ идемпотентности привязан к идентичности конкретного MCP-вызова:
 * операция + вход + request/session/process. Повтор с новым JSON-RPC id
 * намеренно не переиспользует ключ.
 */
export function idempotencyKeyFor(
  operationId: string,
  input: unknown,
  identity: CallIdentity,
): string {
  const digest = createHash("sha256")
    .update(
      stableJson({
        operationId,
        input,
        requestId: identity.requestId,
        sessionId: identity.sessionId ?? null,
        instanceId: identity.instanceId,
        processId: identity.processId,
      }),
    )
    .digest("hex");

  return `kanbaner-mcp-${digest}`;
}

function validateOutput(tool: UniversalTool, data: unknown): boolean {
  if (tool.outputSchema === undefined) {
    return true;
  }

  try {
    const validator = createSchemaValidator(tool.outputSchema as unknown as SchemaParameter);

    return validator.validate(data).ok;
  } catch {
    return false;
  }
}

function parsePayload(tool: UniversalTool, payload: unknown, secret: string): InvokeOutcome {
  const upstream = readUpstreamFailure(payload, secret);

  if (upstream !== null) {
    return { ok: false, error: upstream };
  }

  if (!isPlainObject(payload) || payload["ok"] !== true || !Object.hasOwn(payload, "data")) {
    return {
      ok: false,
      error: createFailure("INTERNAL_ERROR", "Kanbaner API вернул некорректный результат", {
        secret,
      }),
    };
  }

  const data = payload["data"];

  if (!validateOutput(tool, data)) {
    return {
      ok: false,
      error: createFailure("INTERNAL_ERROR", "Результат Kanbaner API не соответствует схеме", {
        secret,
      }),
    };
  }

  return { ok: true, data };
}

export function createOperationInvoker(options: OperationInvokerOptions): OperationInvoker {
  const { config } = options;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async invoke(tool, input, identity, signal) {
      const { operation } = tool;
      const mutation = operation.kind === "mutation";
      const idempotentMutation = mutation && operation.idempotency === "supported";

      try {
        const payload = await requestJson({
          config,
          fetchImpl,
          method: "POST",
          path: `/api/v1/${mutation ? "commands" : "queries"}/${encodeURIComponent(operation.id)}`,
          body: input,
          signal,
          ...(idempotentMutation
            ? { idempotencyKey: idempotencyKeyFor(operation.id, input, identity) }
            : {}),
          // Mutation без поддержки идемпотентности нельзя безопасно повторять
          // после таймаута: ключа, который защитил бы от дубля, нет.
          retryableOnTimeout: !mutation || idempotentMutation,
        });

        return parsePayload(tool, payload, config.apiToken);
      } catch (error) {
        return { ok: false, error: failureFromError(error, config.apiToken) };
      }
    },
  };
}
