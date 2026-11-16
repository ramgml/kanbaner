import type { JsonObject, JsonValue, OperationResult } from "@kanbaner/plugin-sdk";

import type { UiOperationResult } from "../ui/operation-types";

function jsonData(value: unknown): JsonValue | null {
  if (value === undefined) {
    return null;
  }

  // Данные операции уже сериализуемы по контракту; structuredClone защищает
  // от передачи ссылок на внутренние объекты в клиентский компонент.
  return structuredClone(value) as JsonValue;
}

/** Оставляет только безопасную доменную причину отказа. */
function safeErrorDetails(details: JsonObject | undefined): JsonObject | undefined {
  const reason = details?.reason;
  return typeof reason === "string" && reason.length > 0 ? { reason } : undefined;
}

/**
 * Преобразует конверт OperationBus в результат UI-вызова.
 *
 * Наружу отдаётся только `reason`: issues, версии и служебные идентификаторы
 * не нужны UI и не должны расширять transport. Отдельный модуль без
 * `"use server"` позволяет покрыть преобразование unit-тестами.
 */
export function toUiOperationResult(result: OperationResult<unknown>): UiOperationResult {
  if (result.ok) {
    return { ok: true, data: jsonData(result.data) };
  }

  const details = safeErrorDetails(result.error.details);

  return {
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
      ...(details === undefined ? {} : { details }),
    },
  };
}
