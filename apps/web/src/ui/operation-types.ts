import type { JsonValue } from "@kanbaner/plugin-sdk";

/**
 * Контракт вызова публичной операции из UI-вклада.
 *
 * Структурно совпадает с `UiOperationInvoker` из `@kanbaner/task-ui`; shell не
 * импортирует доменные UI-пакеты. Реализация — server action, которая
 * выполняет ту же команду или запрос через общий OperationBus.
 */
export interface UiOperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type UiOperationResult =
  | { readonly ok: true; readonly data: JsonValue | null }
  | { readonly ok: false; readonly error: UiOperationError };

export type UiOperationInvoker = (
  operationId: string,
  input: JsonValue,
) => Promise<UiOperationResult>;
