"use server";

import type { JsonValue, OperationResult } from "@kanbaner/plugin-sdk";

import { sanitizeUiOperationOptions, type UiOperationInvokeOptions } from "../ui/operation-types";
import { executeUiPluginOperation } from "./plugin-service";

export interface UiOperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type UiOperationResult =
  | { readonly ok: true; readonly data: JsonValue | null }
  | { readonly ok: false; readonly error: UiOperationError };

function jsonData(value: unknown): JsonValue | null {
  if (value === undefined) {
    return null;
  }

  // Данные операции уже сериализуемы по контракту; structuredClone защищает
  // от передачи ссылок на внутренние объекты в клиентский компонент.
  return structuredClone(value) as JsonValue;
}

/**
 * Выполняет UI-операцию через общий composition root.
 *
 * Отдельной реализации для UI нет: composition проверяет `exposure.ui`,
 * а OperationBus выполняет те же команды и запросы, что HTTP и MCP.
 */
export async function executePluginOperation(
  operationId: string,
  input: JsonValue,
  options?: UiOperationInvokeOptions,
): Promise<UiOperationResult> {
  const result: OperationResult<unknown> = await executeUiPluginOperation(
    operationId,
    input,
    sanitizeUiOperationOptions(options),
  );

  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
      },
    };
  }

  return { ok: true, data: jsonData(result.data) };
}
