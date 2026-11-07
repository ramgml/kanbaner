import type { TaskPriority, TaskStatus } from "@kanbaner/plugin-tasks/contract";

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = Object.freeze({
  backlog: "Бэклог",
  todo: "К выполнению",
  in_progress: "В работе",
  done: "Готово",
});

export const TASK_PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = Object.freeze({
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
});

const statusOrder: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "done"];

const priorityOrder: readonly TaskPriority[] = ["low", "medium", "high"];

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status];
}

export function taskPriorityLabel(priority: TaskPriority): string {
  return TASK_PRIORITY_LABELS[priority];
}

/** Порядок статусов для select/форм; контракт задаёт только сам набор. */
export function taskStatuses(): readonly TaskStatus[] {
  return statusOrder;
}

export function taskPriorities(): readonly TaskPriority[] {
  return priorityOrder;
}

/** Форматирует срок в UTC, чтобы SSR и тесты не зависели от часового пояса. */
export function formatDueAt(value: string | null): string {
  if (value === null || value.length === 0) {
    return "Без срока";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

/** Переводит `YYYY-MM-DD` из date input в канонический UTC timestamp. */
export function dateInputToDueAt(value: string, boundary: "start" | "end"): string | null {
  if (value.trim().length === 0) {
    return null;
  }

  const suffix = boundary === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
  const parsed = new Date(`${value.trim()}${suffix}`);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Переводит timestamp задачи в значение date input. */
export function dueAtToDateInput(value: string | null): string {
  return value === null ? "" : value.slice(0, 10);
}

/** Разбирает строку тегов формы в массив; пустые элементы отбрасываются. */
export function parseTagsInput(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function tagsToInput(tags: readonly string[]): string {
  return tags.join(", ");
}
