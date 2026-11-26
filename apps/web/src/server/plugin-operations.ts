"use server";

import type { JsonValue, OperationResult } from "@kanbaner/plugin-sdk";

import {
  sanitizeUiOperationOptions,
  type UiOperationInvokeOptions,
  type UiOperationResult,
} from "../ui/operation-types";
import { toUiOperationResult } from "./plugin-operation-result";
import { executeUiPluginOperation } from "./plugin-service";

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

  return toUiOperationResult(result);
}
