import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";
import type { PluginEventPublisher } from "./activation.ts";
import type { OperationId } from "./plugin-id.ts";
import type { ResourceService } from "./resources.ts";
import type { OperationResult } from "./results.ts";
import type { PluginSearchService } from "./search.ts";
import type { PluginStorage } from "./storage/plugin-storage.ts";

/** Канал, из которого пришёл вызов операции. */
export const OPERATION_SOURCE_TYPES = ["ui", "http", "mcp", "plugin", "system"] as const;

export type OperationSourceType = (typeof OPERATION_SOURCE_TYPES)[number];

export const OperationSourceSchema = Type.Object(
  {
    type: Type.Union(OPERATION_SOURCE_TYPES.map((type) => Type.Literal(type))),
    id: Type.Optional(Type.String({ minLength: 1 })),
  },
  DRAFT_2020_12,
);

export type OperationSource = Static<typeof OperationSourceSchema>;

/** Дополнительные параметры вложенного вызова операции. */
export interface InvocationOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: Date;
  readonly idempotencyKey?: string;
}

/** Вызов публичной команды другого плагина. */
export interface CommandInvoker {
  execute<TInput = unknown, TOutput = unknown>(
    commandId: OperationId,
    input: TInput,
    options?: InvocationOptions,
  ): Promise<OperationResult<TOutput>>;
}

/** Вызов публичного запроса другого плагина. */
export interface QueryInvoker {
  execute<TInput = unknown, TOutput = unknown>(
    queryId: OperationId,
    input: TInput,
    options?: InvocationOptions,
  ): Promise<OperationResult<TOutput>>;
}

/** Поля структурированного журнала. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Минимальный структурный логгер.
 *
 * SDK не зависит от Pino: ядро передаёт реализацию, совместимую с этим
 * интерфейсом. Содержимое заметок и секреты не должны попадать в поля.
 */
export interface PluginLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child?(fields: LogFields): PluginLogger;
}

/**
 * Контекст выполнения операции, создаваемый ядром.
 *
 * `TStorage` по умолчанию — bound `PluginStorage`; generic сохранён для
 * специализированных контекстов и тестов, но raw provider сюда не попадает.
 */
export interface ExecutionContext<TStorage = PluginStorage> {
  readonly requestId: string;
  readonly traceId: string;
  readonly source: OperationSource;
  readonly signal: AbortSignal;
  readonly deadline?: Date;
  readonly idempotencyKey?: string;
  readonly logger: PluginLogger;
  readonly commands: CommandInvoker;
  readonly queries: QueryInvoker;
  readonly resources: ResourceService;
  readonly events: PluginEventPublisher;
  readonly search: PluginSearchService;
  readonly storage: TStorage;
}
