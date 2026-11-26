import type { JsonObject, JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

export interface SearchUiOperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export type SearchUiOperationResult =
  | { readonly ok: true; readonly data: JsonValue | null }
  | { readonly ok: false; readonly error: SearchUiOperationError };

export type SearchUiOperationInvoker = (
  operationId: string,
  input: JsonValue,
  options?: { readonly idempotencyKey?: string },
) => Promise<SearchUiOperationResult>;

/**
 * Безопасный результат открытия ресурса.
 *
 * Тип структурный: shell возвращает расширенный результат с href и
 * contributionId, но поиску достаточно признака успеха и сообщения ошибки.
 */
export type SearchUiOpenResourceResult =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

export interface SearchUiRendererProps {
  readonly invoke: SearchUiOperationInvoker;
  readonly pathname?: string | undefined;
  readonly search?: string | undefined;
  readonly context?: JsonObject | undefined;
  readonly replaceSearch?: ((search: string) => void) | undefined;
  readonly openResource?: ((ref: ResourceRef) => SearchUiOpenResourceResult) | undefined;
  readonly renderSlot?: ((slot: string, context?: JsonObject) => unknown) | undefined;
}

export class SearchUiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: JsonObject,
  ) {
    super(message);
  }
}

export async function invokeSearch<T>(
  invoke: SearchUiOperationInvoker,
  operationId: string,
  input: JsonValue,
): Promise<T> {
  const result = await invoke(operationId, input);

  if (!result.ok) {
    throw new SearchUiError(
      result.error.code,
      result.error.message,
      result.error.retryable,
      result.error.details,
    );
  }

  return result.data as T;
}
