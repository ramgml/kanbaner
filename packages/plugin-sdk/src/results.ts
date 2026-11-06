import { Type, type Static, type TSchema } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";
import { createErrorResultSchema, type ErrorResult } from "./errors.ts";
import { createJsonValueSchema } from "./json.ts";

export const ResultMetaSchema = Type.Object({
  warnings: Type.Optional(Type.Array(Type.String())),
});

export type ResultMeta = Static<typeof ResultMetaSchema>;

/** Успешный результат операции с типизированными данными. */
export interface SuccessResult<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta?: ResultMeta;
}

/** Единый результат команды или запроса. */
export type OperationResult<T = unknown> = SuccessResult<T> | ErrorResult;

/** Схема успешного результата для конкретной схемы данных. */
export function createSuccessResultSchema<Data extends TSchema>(data: Data) {
  return Type.Object(
    {
      ok: Type.Literal(true),
      data,
      meta: Type.Optional(ResultMetaSchema),
    },
    DRAFT_2020_12,
  );
}

/** Схема единого результата операции для конкретной схемы данных. */
export function createResultSchema<Data extends TSchema>(data: Data) {
  return Type.Union([createSuccessResultSchema(data), createErrorResultSchema()], DRAFT_2020_12);
}

/** Схема результата с произвольными JSON-данными. */
export const OperationResultSchema = createResultSchema(createJsonValueSchema());

export function toSuccessResult<T>(data: T, meta?: ResultMeta): SuccessResult<T> {
  return meta === undefined ? { ok: true, data } : { ok: true, data, meta };
}

export function isSuccessResult<T>(result: OperationResult<T>): result is SuccessResult<T> {
  return result.ok;
}

export function isErrorResult<T>(result: OperationResult<T>): result is ErrorResult {
  return !result.ok;
}
