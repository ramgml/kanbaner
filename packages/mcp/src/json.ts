import type { JsonValue } from "@kanbaner/plugin-sdk";

/** Plain JSON object без прототипа приложения. */
export type JsonRecord = Readonly<Record<string, unknown>>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Схема операции, пригодная для MCP tool.
 *
 * MCP требует, чтобы `inputSchema` и объявленный `outputSchema` были
 * объектными JSON Schema. Некорректная схема не публикуется.
 */
export interface JsonObjectSchema extends JsonRecord {
  readonly type: "object";
}

export function isObjectSchema(value: unknown): value is JsonObjectSchema {
  return isPlainObject(value) && value["type"] === "object";
}

/** Детерминированная сериализация для хеша идентичности вызова. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function asJsonValue(value: Record<string, unknown>): JsonValue {
  return value as unknown as JsonValue;
}
