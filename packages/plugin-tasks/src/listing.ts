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

/** Сравнивает два UTC timestamp лексикографически; формат фиксирован. */
export function compareUtcTimestamps(left: UtcTimestamp, right: UtcTimestamp): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
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

  if (dueBefore !== undefined && dueAt > dueBefore) {
    return false;
  }

  if (dueAfter !== undefined && dueAt < dueAfter) {
    return false;
  }

  return true;
}
