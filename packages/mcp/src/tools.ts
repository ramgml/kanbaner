import { createSchemaValidator } from "@kanbaner/plugin-sdk";

import type { DiscoveryOperation } from "./discovery.ts";
import type { JsonObjectSchema } from "./json.ts";

export const MAX_TOOL_NAME_LENGTH = 128;

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** Готовая операция каталога, которую видит MCP-клиент. */
export interface UniversalTool {
  readonly name: string;
  readonly operation: DiscoveryOperation;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly outputSchema?: JsonObjectSchema;
  readonly requiresExpectedVersion: boolean;
}

export interface BuildCatalogOptions {
  readonly allowDestructive: boolean;
  readonly onDiagnostic?: (message: string) => void;
}

type SchemaParameter = Parameters<typeof createSchemaValidator>[0];

function schemaCompiles(schema: JsonObjectSchema): boolean {
  try {
    createSchemaValidator(schema as unknown as SchemaParameter);
    return true;
  } catch {
    return false;
  }
}

/**
 * Стабильное имя MCP tool из operation ID.
 *
 * Имя приводится к lowercase, недопустимые символы заменяются на `_`.
 * Пустое или слишком длинное имя не публикуется (`null`).
 */
export function toolNameForOperation(operationId: string): string | null {
  const normalized = operationId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");

  if (normalized.length === 0 || normalized.length > MAX_TOOL_NAME_LENGTH) {
    return null;
  }

  return normalized;
}

export function requiresExpectedVersion(inputSchema: JsonObjectSchema): boolean {
  const required = inputSchema["required"];

  return Array.isArray(required) && required.includes("expectedVersion");
}

export function describeOperation(operation: DiscoveryOperation): string {
  const base =
    operation.description === undefined || operation.description.trim().length === 0
      ? operation.id
      : operation.description.trim();
  const lines = [base, "", `Operation: ${operation.id}`, `Risk: ${operation.risk}`];

  if (requiresExpectedVersion(operation.inputSchema)) {
    lines.push("Requires expectedVersion.");
  }

  const description = lines.join("\n");

  return operation.risk === "destructive" ? `DESTRUCTIVE. ${description}` : description;
}

export function annotationsFor(operation: DiscoveryOperation): ToolAnnotations {
  return {
    readOnlyHint: operation.kind === "query",
    destructiveHint: operation.risk === "destructive",
    idempotentHint: operation.kind === "query",
    openWorldHint: false,
  };
}

function isEligible(operation: DiscoveryOperation, allowDestructive: boolean): boolean {
  if (operation.exposure.http !== true || operation.exposure.mcp !== true) {
    return false;
  }

  if (operation.risk === "destructive" && !allowDestructive) {
    return false;
  }

  return true;
}

/**
 * Строит отсортированный каталог tools из актуального discovery.
 *
 * Не публикуются: операции без `http && mcp`, destructive без явного
 * разрешения, schemas, которые не компилируются, и любые коллизии имён
 * (исключаются все участники коллизии).
 */
export function buildToolCatalog(
  operations: readonly DiscoveryOperation[],
  options: BuildCatalogOptions,
): readonly UniversalTool[] {
  const diagnostics = options.onDiagnostic ?? (() => undefined);
  const byName = new Map<string, UniversalTool[]>();

  for (const operation of operations) {
    if (!isEligible(operation, options.allowDestructive)) {
      continue;
    }

    const name = toolNameForOperation(operation.id);

    if (name === null) {
      diagnostics(
        `MCP: операция ${operation.id} пропущена: имя tool пустое или длиннее ${MAX_TOOL_NAME_LENGTH} символов`,
      );
      continue;
    }

    if (!schemaCompiles(operation.inputSchema)) {
      diagnostics(`MCP: операция ${operation.id} пропущена: inputSchema не компилируется`);
      continue;
    }

    const outputSchema = operation.outputSchema;

    if (outputSchema !== undefined && !schemaCompiles(outputSchema)) {
      diagnostics(`MCP: операция ${operation.id} пропущена: outputSchema не компилируется`);
      continue;
    }

    const tool: UniversalTool = {
      name,
      operation,
      description: describeOperation(operation),
      annotations: annotationsFor(operation),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      requiresExpectedVersion: requiresExpectedVersion(operation.inputSchema),
    };
    const bucket = byName.get(name);

    if (bucket === undefined) {
      byName.set(name, [tool]);
    } else {
      bucket.push(tool);
    }
  }

  const tools: UniversalTool[] = [];

  for (const [name, bucket] of byName) {
    if (bucket.length > 1) {
      diagnostics(
        `MCP: имя tool ${name} неоднозначно (${bucket
          .map((tool) => tool.operation.id)
          .join(", ")}); инструменты не опубликованы`,
      );
      continue;
    }

    const only = bucket[0];

    if (only !== undefined) {
      tools.push(only);
    }
  }

  return tools.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

/** Пригоден ли output для `structuredContent` по требованиям MCP. */
export function supportsStructuredOutput(tool: UniversalTool): boolean {
  return tool.outputSchema !== undefined && tool.outputSchema.type === "object";
}
