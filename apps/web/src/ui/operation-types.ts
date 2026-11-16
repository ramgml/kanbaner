import type { JsonObject, JsonValue } from "@kanbaner/plugin-sdk";

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
  /** Whitelisted безопасные детали; сейчас только доменный `reason`. */
  readonly details?: JsonObject;
}

export type UiOperationResult =
  | { readonly ok: true; readonly data: JsonValue | null }
  | { readonly ok: false; readonly error: UiOperationError };

/**
 * Необязательные параметры UI-вызова.
 *
 * `idempotencyKey` относится только к командам: повтор с тем же ключом и
 * payload возвращает исходный результат. Запрос ключ не получает.
 */
export interface UiOperationInvokeOptions {
  readonly idempotencyKey?: string;
}

export type UiOperationInvoker = (
  operationId: string,
  input: JsonValue,
  options?: UiOperationInvokeOptions,
) => Promise<UiOperationResult>;

/**
 * Приводит недоверенные опции UI-вызова к контракту.
 *
 * Пустой или нестроковый ключ считается отсутствующим: OperationBus отклоняет
 * пустые `idempotencyKey`, поэтому transport не должен превращать мусор в
 * `VALIDATION_ERROR`.
 */
export function sanitizeUiOperationOptions(options: unknown): UiOperationInvokeOptions | undefined {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return undefined;
  }

  const key: unknown = (options as { readonly idempotencyKey?: unknown }).idempotencyKey;

  return typeof key === "string" && key.length > 0 ? { idempotencyKey: key } : undefined;
}
