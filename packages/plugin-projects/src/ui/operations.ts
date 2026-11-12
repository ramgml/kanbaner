import type { JsonValue } from "@kanbaner/plugin-sdk";
import { TASKS_COMMAND_IDS } from "@kanbaner/plugin-tasks/contract";
import type { UiOperationError, UiOperationInvoker } from "@kanbaner/task-ui";

/**
 * Массовые команды KAN-028 появятся в контракте домена после merge.
 *
 * Сначала читается `TASKS_COMMAND_IDS`, поэтому после слияния используется
 * фактический ID контракта. Fallback нужен только для isolated-сборки UI до
 * merge.
 */
export const BULK_TASK_COMMAND_IDS = {
  taskMoveMany:
    (TASKS_COMMAND_IDS as Readonly<Record<string, string | undefined>>).taskMoveMany ??
    "kanbaner.tasks.task.moveMany",
  taskDeleteMany:
    (TASKS_COMMAND_IDS as Readonly<Record<string, string | undefined>>).taskDeleteMany ??
    "kanbaner.tasks.task.deleteMany",
} as const;

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

export const BULK_VERSION_CONFLICT_MESSAGE =
  "Выбранные задачи уже изменены в другом месте. Доска перечитана — проверьте выбор и повторите действие.";

export const PROJECT_VERSION_CONFLICT_MESSAGE =
  "Проект уже изменён в другом месте. Версия проекта обновлена — проверьте название и повторите действие.";

export const PROJECT_VERSION_REFRESH_FAILED_MESSAGE =
  "Не удалось обновить версию проекта. Проверьте соединение и повторите действие.";

export function isVersionConflict(error: unknown): boolean {
  return error instanceof KanbanOperationError && error.code === "VERSION_CONFLICT";
}
