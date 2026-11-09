import { formatDueAt } from "@kanbaner/task-ui";

/**
 * Семантический срок карточки.
 *
 * Дата в домене хранится в UTC, поэтому сравнение идёт по UTC-дню: SSR,
 * браузер и тесты видят одинаковый результат независимо от часового пояса.
 */
export type DueTone = "overdue" | "today" | "tomorrow" | "later" | "none";

export interface DueDisplay {
  /** Короткий текст для бейджа. */
  readonly label: string;
  /** Цветовой тон; текст всегда дублирует смысл, цвет не единственный сигнал. */
  readonly tone: DueTone;
  /** Доступное описание с полной датой. */
  readonly ariaLabel: string;
  /** Подсказка при наведении. */
  readonly title: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function describeDue(dueAt: string | null, now: Date = new Date()): DueDisplay {
  if (dueAt === null || dueAt.trim().length === 0) {
    return {
      label: "Без срока",
      tone: "none",
      ariaLabel: "Срок не задан",
      title: "Срок не задан",
    };
  }

  const parsed = new Date(dueAt);

  if (Number.isNaN(parsed.getTime())) {
    return {
      label: dueAt,
      tone: "later",
      ariaLabel: `Срок: ${dueAt}`,
      title: dueAt,
    };
  }

  const fullDate = formatDueAt(dueAt);
  const difference = Math.round((utcDay(parsed) - utcDay(now)) / DAY_MS);

  if (difference < 0) {
    return {
      label: "Просрочено",
      tone: "overdue",
      ariaLabel: `Просрочено, срок ${fullDate}`,
      title: `Просрочено: ${fullDate}`,
    };
  }

  if (difference === 0) {
    return {
      label: "Сегодня",
      tone: "today",
      ariaLabel: "Срок сегодня",
      title: `Срок сегодня: ${fullDate}`,
    };
  }

  if (difference === 1) {
    return {
      label: "Завтра",
      tone: "tomorrow",
      ariaLabel: "Срок завтра",
      title: `Срок завтра: ${fullDate}`,
    };
  }

  return {
    label: fullDate,
    tone: "later",
    ariaLabel: `Срок ${fullDate}`,
    title: `Срок: ${fullDate}`,
  };
}
