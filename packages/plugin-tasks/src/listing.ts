import type { UtcTimestamp } from "@kanbaner/plugin-sdk";

import type { Project, SortDirection, Task, TaskSort } from "./model.ts";

/**
 * Backend-neutral семантика списков.
 *
 * Функции чистые и не зависят от Storage Provider. Store обязан использовать
 * эти правила, чтобы in-memory и SQLite реализации давали одинаковый порядок.
 */

/**
 * Нормализует текст поиска: NFKC, затем `toLowerCase()` без locale.
 *
 * Так `text` в `task.list` сравнивается без учёта регистра и совместимых
 * форм Unicode.
 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** Проверяет вхождение `text` в заголовок или Markdown-описание задачи. */
export function matchesTaskText(
  task: Pick<Task, "title" | "descriptionMarkdown">,
  text: string,
): boolean {
  const needle = normalizeSearchText(text);

  return (
    normalizeSearchText(task.title).includes(needle) ||
    normalizeSearchText(task.descriptionMarkdown).includes(needle)
  );
}

/**
 * Сравнивает строки по code points Unicode.
 *
 * `localeCompare` запрещён: порядок не должен зависеть от локали, ICU и
 * платформы.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index] ?? 0;
    const rightPoint = rightPoints[index] ?? 0;

    if (leftPoint !== rightPoint) {
      return leftPoint - rightPoint;
    }
  }

  return leftPoints.length - rightPoints.length;
}

const UTC_TIMESTAMP_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u;

interface SplitUtcTimestamp {
  readonly seconds: string;
  readonly fraction: string;
}

/**
 * Разбирает канонический UTC timestamp из SDK без `Date.parse`.
 *
 * Секундная часть фиксированной ширины, дробная часть сохраняется целиком:
 * количество цифр не ограничивается тремя.
 */
function splitUtcTimestamp(value: UtcTimestamp): SplitUtcTimestamp {
  const match = UTC_TIMESTAMP_PARTS.exec(value);

  if (match === null) {
    throw new TypeError("UTC timestamp должен иметь формат YYYY-MM-DDTHH:mm:ss[.fraction]Z");
  }

  const [, year = "", month = "", day = "", hour = "", minute = "", second = "", fraction = ""] =
    match;

  return {
    seconds: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    fraction,
  };
}

/**
 * Сравнивает два UTC timestamp детерминированно.
 *
 * Сначала сравниваются секунды, затем дробные части с выравниванием справа
 * нулями. Поэтому `.1Z` равно `.100Z`, `Z` меньше `.100Z`, а точность больше
 * трёх знаков не теряется. `Date.parse` не используется.
 */
export function compareUtcTimestamps(left: UtcTimestamp, right: UtcTimestamp): number {
  const leftParts = splitUtcTimestamp(left);
  const rightParts = splitUtcTimestamp(right);

  if (leftParts.seconds !== rightParts.seconds) {
    return leftParts.seconds < rightParts.seconds ? -1 : 1;
  }

  const fractionLength = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(fractionLength, "0");
  const rightFraction = rightParts.fraction.padEnd(fractionLength, "0");

  if (leftFraction === rightFraction) {
    return 0;
  }

  return leftFraction < rightFraction ? -1 : 1;
}

/**
 * Сравнивает `dueAt` с `null`-политикой «null всегда последние».
 *
 * Направление влияет только на непустые значения. Это правило одинаково для
 * `asc` и `desc`.
 */
export function compareNullableDueAt(
  left: UtcTimestamp | null,
  right: UtcTimestamp | null,
  direction: SortDirection,
): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  const order = compareUtcTimestamps(left, right);

  if (order === 0) {
    return 0;
  }

  return direction === "asc" ? order : -order;
}

/**
 * Сравнивает задачи по контракту `task.list`.
 *
 * Выбранное поле сортируется в заданном направлении, затем применяется
 * `id asc`. `dueAt = null` всегда последние независимо от направления.
 */
export function compareTaskList(left: Task, right: Task, sort: TaskSort): number {
  let result: number;

  if (sort.field === "dueAt") {
    result = compareNullableDueAt(left.dueAt, right.dueAt, sort.direction);
  } else {
    switch (sort.field) {
      case "position":
        result = left.position - right.position;
        break;
      case "createdAt":
        result = compareUtcTimestamps(left.createdAt, right.createdAt);
        break;
      case "updatedAt":
        result = compareUtcTimestamps(left.updatedAt, right.updatedAt);
        break;
      case "title":
        result = compareCodePoints(left.title, right.title);
        break;
    }

    if (sort.direction === "desc") {
      result = -result;
    }
  }

  return result === 0 ? compareCodePoints(left.id, right.id) : result;
}

/** Сравнивает проекты по контракту `project.list`: createdAt asc, id asc. */
export function compareProjects(left: Project, right: Project): number {
  const createdAtOrder = compareUtcTimestamps(left.createdAt, right.createdAt);

  return createdAtOrder === 0 ? compareCodePoints(left.id, right.id) : createdAtOrder;
}

/**
 * Проверяет попадание `dueAt` в включительный диапазон.
 *
 * `dueBefore` и `dueAfter` включают границу. Если задан хотя бы один предел,
 * задача без срока (`dueAt = null`) в диапазон не попадает.
 */
export function matchesDueRange(
  dueAt: UtcTimestamp | null,
  dueBefore?: UtcTimestamp,
  dueAfter?: UtcTimestamp,
): boolean {
  if (dueBefore === undefined && dueAfter === undefined) {
    return true;
  }

  if (dueAt === null) {
    return false;
  }

  if (dueBefore !== undefined && compareUtcTimestamps(dueAt, dueBefore) > 0) {
    return false;
  }

  if (dueAfter !== undefined && compareUtcTimestamps(dueAt, dueAfter) < 0) {
    return false;
  }

  return true;
}
