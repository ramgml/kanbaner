import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, PLUGIN_CONTRACT_VERSION_NUMBER } from "./contract.ts";
import { OperationSourceSchema } from "./context.ts";
import { JsonObjectSchema, JsonValueSchema } from "./json.ts";
import { ContractIdSchema, OperationIdSchema } from "./plugin-id.ts";

export const EXPOSURE_CHANNELS = ["ui", "http", "mcp"] as const;

export type ExposureChannel = (typeof EXPOSURE_CHANNELS)[number];

/**
 * Явные каналы публикации операции.
 *
 * Все каналы по умолчанию выключены. Отсутствие поля или канала означает
 * `false`, поэтому неэкспортированная операция недоступна снаружи.
 */
export const ExposureSchema = Type.Object({
  ui: Type.Optional(Type.Boolean({ default: false })),
  http: Type.Optional(Type.Boolean({ default: false })),
  mcp: Type.Optional(Type.Boolean({ default: false })),
});

export type ExposureMetadata = Static<typeof ExposureSchema>;

export interface ResolvedExposure {
  readonly ui: boolean;
  readonly http: boolean;
  readonly mcp: boolean;
}

export const DEFAULT_EXPOSURE: ResolvedExposure = Object.freeze({
  ui: false,
  http: false,
  mcp: false,
});

/** Приводит частично заданный exposure к безопасному значению по умолчанию. */
export function resolveExposure(exposure?: ExposureMetadata): ResolvedExposure {
  return {
    ui: exposure?.ui === true,
    http: exposure?.http === true,
    mcp: exposure?.mcp === true,
  };
}

export const COMMAND_RISK_LEVELS = ["read", "write", "destructive"] as const;

export type CommandRiskLevel = (typeof COMMAND_RISK_LEVELS)[number];

export const CommandRiskLevelSchema = Type.Union(
  COMMAND_RISK_LEVELS.map((level) => Type.Literal(level)),
);

export const IDEMPOTENCY_MODES = ["none", "supported"] as const;

export type IdempotencyMode = (typeof IDEMPOTENCY_MODES)[number];

export const IdempotencyModeSchema = Type.Union(
  IDEMPOTENCY_MODES.map((mode) => Type.Literal(mode)),
);

/** JSON Schema аргументов или результата операции. */
export const OperationJsonSchemaSchema = JsonObjectSchema;

/**
 * Метаданные команды — операции, которая может изменить состояние.
 */
export const CommandMetadataSchema = Type.Object(
  {
    id: OperationIdSchema,
    contract: ContractIdSchema,
    version: Type.Integer({ minimum: 1 }),
    kind: Type.Literal("mutation"),
    risk: CommandRiskLevelSchema,
    idempotency: IdempotencyModeSchema,
    exposure: Type.Optional(ExposureSchema),
    inputSchema: OperationJsonSchemaSchema,
    outputSchema: OperationJsonSchemaSchema,
    description: Type.Optional(Type.String()),
  },
  DRAFT_2020_12,
);

export type CommandMetadata = Static<typeof CommandMetadataSchema>;

/**
 * Метаданные запроса — операции, которая не изменяет сохраняемое состояние.
 *
 * У запроса нет `idempotency` и допустим только `risk = read`, чтобы
 * mutation и query не размывались.
 */
export const QueryMetadataSchema = Type.Object(
  {
    id: OperationIdSchema,
    contract: ContractIdSchema,
    version: Type.Integer({ minimum: 1 }),
    kind: Type.Literal("query"),
    risk: Type.Literal("read"),
    exposure: Type.Optional(ExposureSchema),
    inputSchema: OperationJsonSchemaSchema,
    outputSchema: OperationJsonSchemaSchema,
    description: Type.Optional(Type.String()),
  },
  DRAFT_2020_12,
);

export type QueryMetadata = Static<typeof QueryMetadataSchema>;

export const OperationMetadataSchema = Type.Union(
  [CommandMetadataSchema, QueryMetadataSchema],
  DRAFT_2020_12,
);

export type OperationMetadata = Static<typeof OperationMetadataSchema>;

/** Логический конверт вызова команды или запроса. */
export const OperationEnvelopeSchema = Type.Object(
  {
    contractVersion: Type.Literal(PLUGIN_CONTRACT_VERSION_NUMBER),
    requestId: Type.String({ minLength: 1 }),
    operationId: OperationIdSchema,
    operationVersion: Type.Integer({ minimum: 1 }),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
    source: OperationSourceSchema,
    payload: JsonValueSchema,
  },
  DRAFT_2020_12,
);

export type OperationEnvelope = Static<typeof OperationEnvelopeSchema>;
