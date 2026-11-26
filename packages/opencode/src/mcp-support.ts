import { createHash } from "node:crypto";

export interface KanbanerApiConfig {
  readonly apiUrl: string;
  readonly apiToken: string | undefined;
  readonly instanceId?: string;
}

export function normalizeApiToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const prefix = "KANBANER_API_TOKEN=";
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
}

export interface KanbanerCallIdentity {
  readonly requestId: string | number;
  readonly sessionId?: string;
  readonly openCodeSessionId?: string;
  readonly instanceId?: string;
}

export type KanbanerOperationResult = {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: unknown;
  };
};

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

export function idempotencyKey(
  operationId: string,
  input: unknown,
  identity: KanbanerCallIdentity,
): string {
  const digest = createHash("sha256")
    .update(
      stableJson({
        operationId,
        input,
        requestId: identity.requestId,
        sessionId: identity.sessionId ?? null,
        openCodeSessionId: identity.openCodeSessionId ?? null,
        instanceId: identity.instanceId ?? null,
      }),
    )
    .digest("hex");
  return `kanbaner-${digest}`;
}

export async function callKanbanerApi(
  config: KanbanerApiConfig,
  kind: "commands" | "queries",
  operationId: string,
  input: unknown,
  identity: KanbanerCallIdentity,
  signal: AbortSignal,
): Promise<KanbanerOperationResult> {
  const mutation = kind === "commands";
  try {
    const response = await fetch(
      `${config.apiUrl.replace(/\/+$/u, "")}/api/v1/${kind}/${encodeURIComponent(operationId)}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${config.apiToken ?? ""}`,
          ...(mutation
            ? {
                "idempotency-key": idempotencyKey(operationId, input, {
                  ...identity,
                  ...(config.instanceId === undefined ? {} : { instanceId: config.instanceId }),
                }),
              }
            : {}),
        },
        body: JSON.stringify(input),
        signal,
      },
    );
    return (await response.json()) as KanbanerOperationResult;
  } catch {
    return {
      ok: false,
      error: signal.aborted
        ? { code: "CANCELLED", message: "Вызов Kanbaner отменён", retryable: false }
        : { code: "DEPENDENCY_UNAVAILABLE", message: "Kanbaner API недоступен", retryable: true },
    };
  }
}

export function toolResult(value: KanbanerOperationResult) {
  return {
    ...(value.ok ? {} : { isError: true as const }),
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}
