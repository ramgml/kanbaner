import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { UiOperationError, UiOperationInvoker } from "@kanbaner/task-ui";

/** Ошибка публичной операции, которую можно показать пользователю. */
export class KanbanOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: UiOperationError) {
    super(error.message);
    this.name = "KanbanOperationError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

/** Выполняет операцию и разворачивает единый конверт результата. */
export async function invokeJson<T>(
  invoke: UiOperationInvoker,
  operationId: string,
  input: JsonValue,
): Promise<T> {
  const result = await invoke(operationId, input);

  if (!result.ok) {
    throw new KanbanOperationError(result.error);
  }

  return result.data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof KanbanOperationError) {
    return error.message;
  }

  return "Не удалось выполнить операцию. Повторите попытку.";
}

export const VERSION_CONFLICT_MESSAGE =
  "Задача уже изменена в другом месте. Доска перечитана — проверьте её и повторите действие.";

export const PROJECT_VERSION_CONFLICT_MESSAGE =
  "Проект уже изменён в другом месте. Данные перечитаны — проверьте название и повторите действие.";

export function isVersionConflict(error: unknown): boolean {
  return error instanceof KanbanOperationError && error.code === "VERSION_CONFLICT";
}
