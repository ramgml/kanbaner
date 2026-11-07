import type { JsonValue } from "@kanbaner/plugin-sdk";
import type { UiOperationError, UiOperationInvoker } from "@kanbaner/task-ui";

/** Ошибка публичной операции, которую можно показать пользователю. */
export class TaskListOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: UiOperationError) {
    super(error.message);
    this.name = "TaskListOperationError";
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
    throw new TaskListOperationError(result.error);
  }

  return result.data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof TaskListOperationError) {
    if (error.code === "VERSION_CONFLICT") {
      return "Задача уже изменена в другом месте. Данные перечитаны — проверьте их и повторите действие.";
    }

    return error.message;
  }

  return "Не удалось выполнить операцию. Повторите попытку.";
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof TaskListOperationError && error.code === "VERSION_CONFLICT";
}
