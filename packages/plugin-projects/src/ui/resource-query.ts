import { tryParseTasksResourceRef } from "@kanbaner/plugin-tasks/contract";

/**
 * Результат разбора query-параметра `resource`.
 *
 * Поддерживаются только ресурсы домена задач: чужая или повреждённая ссылка
 * игнорируется, а не ломает доску.
 */
export interface WorkspaceResourceTarget {
  readonly taskId?: string;
  readonly projectId?: string;
}

/**
 * Переводит `resource=<ResourceRef>` в старые ключи выбора задач.
 *
 * `task` открывает существующий Trello-модал, `project` — выбор проекта.
 * Остальные типы ресурсов игнорируются.
 */
export function parseWorkspaceResource(value: string | null | undefined): WorkspaceResourceTarget {
  if (value === null || value === undefined || value.trim().length === 0) {
    return {};
  }

  const parsed = tryParseTasksResourceRef(value.trim());

  if (parsed === null) {
    return {};
  }

  if (parsed.kind === "task") {
    return { taskId: parsed.id };
  }

  if (parsed.kind === "project") {
    return { projectId: parsed.id };
  }

  return {};
}
