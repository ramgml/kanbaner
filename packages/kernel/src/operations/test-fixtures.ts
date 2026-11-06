import type { CommandMetadata, QueryMetadata } from "@kanbaner/plugin-sdk";

/** Схема входа с обязательным непустым title. */
export const titleInputSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

/** Свободная схема выхода для тестов контекста и вложенных вызовов. */
export const looseObjectSchema = {
  type: "object",
} as const;

/** Схема выхода, требующая строковый id. */
export const identifierOutputSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

export function commandMetadata(overrides: Record<string, unknown> = {}): CommandMetadata {
  return {
    id: "test.tasks.create",
    contract: "test.tasks.commands.v1",
    version: 1,
    kind: "mutation",
    risk: "write",
    idempotency: "supported",
    inputSchema: titleInputSchema,
    outputSchema: looseObjectSchema,
    exposure: { ui: true, mcp: false },
    ...overrides,
  } as unknown as CommandMetadata;
}

export function queryMetadata(overrides: Record<string, unknown> = {}): QueryMetadata {
  return {
    id: "test.tasks.list",
    contract: "test.tasks.queries.v1",
    version: 1,
    kind: "query",
    risk: "read",
    inputSchema: titleInputSchema,
    outputSchema: looseObjectSchema,
    exposure: { ui: true },
    ...overrides,
  } as unknown as QueryMetadata;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
