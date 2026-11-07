import { isUtcTimestamp, type UtcTimestamp } from "@kanbaner/plugin-sdk";

import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_POSITION,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
} from "./constants.ts";
import type { Task, TaskStatus } from "./model.ts";

/** Коды доменных ошибок валидации. */
export const TASKS_VALIDATION_CODES = [
  "INVALID_TITLE",
  "INVALID_TAGS",
  "INVALID_NORMALIZED_TAGS",
  "INVALID_TAG",
  "TAG_EMPTY",
  "TAG_TOO_LONG",
  "TAG_LIMIT",
  "INVALID_POSITION",
  "INVALID_LIMIT",
  "INVALID_OFFSET",
  "INVALID_EXPECTED_VERSION",
  "INVALID_TIMESTAMP",
  "INVALID_COMPLETION",
  "PARENT_NOT_FOUND",
  "PARENT_IN_OTHER_PROJECT",
  "SUBTASK_DEPTH_EXCEEDED",
] as const;

export type TasksValidationCode = (typeof TASKS_VALIDATION_CODES)[number];

export interface TasksValidationFailure {
  readonly ok: false;
  readonly code: TasksValidationCode;
  readonly message: string;
}

export type TasksValidationResult<Value> =
  { readonly ok: true; readonly value: Value } | TasksValidationFailure;

/** Ошибка чистой доменной валидации с безопасным сообщением. */
export class TasksValidationError extends Error {
  override readonly name = "TasksValidationError";
  readonly code: TasksValidationCode;

  constructor(code: TasksValidationCode, message: string) {
    super(message);
    this.code = code;
  }
}

function failure(code: TasksValidationCode, message: string): TasksValidationFailure {
  return { ok: false, code, message };
}

/** Минимальный снимок родительской задачи для проверки вложенности. */
export interface ParentTaskSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly parentTaskId: string | null;
}

/** Проверяет и нормализует заголовок. */
export function validateTitle(value: unknown): TasksValidationResult<string> {
  if (typeof value !== "string") {
    return failure("INVALID_TITLE", "Заголовок должен быть строкой");
  }

  const title = value.trim();

  if (title.length === 0) {
    return failure("INVALID_TITLE", "Заголовок не может быть пустым");
  }

  if (title.length > MAX_TITLE_LENGTH) {
    return failure("INVALID_TITLE", `Заголовок не может быть длиннее ${MAX_TITLE_LENGTH} символов`);
  }

  return { ok: true, value: title };
}

/** Нормализует теги и проверяет лимиты; бросает `TasksValidationError`. */
export function normalizeTags(tags: readonly string[]): readonly string[] {
  const result = validateTags(tags);

  if (!result.ok) {
    throw new TasksValidationError(result.code, result.message);
  }

  return result.value;
}

/**
 * Проверяет и нормализует теги: trim, нижний регистр, дедупликация,
 * лимит количества и длины.
 */
export function validateTags(value: unknown): TasksValidationResult<readonly string[]> {
  if (!Array.isArray(value)) {
    return failure("INVALID_TAGS", "Теги должны быть массивом строк");
  }

  const normalized: string[] = [];

  for (const candidate of value) {
    if (typeof candidate !== "string") {
      return failure("INVALID_TAG", "Каждый тег должен быть строкой");
    }

    const tag = candidate.trim().toLowerCase();

    if (tag.length === 0) {
      return failure("TAG_EMPTY", "Тег не может быть пустым");
    }

    if (tag.length > MAX_TAG_LENGTH) {
      return failure("TAG_TOO_LONG", `Тег не может быть длиннее ${MAX_TAG_LENGTH} символов`);
    }

    if (!normalized.includes(tag)) {
      normalized.push(tag);
    }
  }

  if (normalized.length > MAX_TAGS) {
    return failure("TAG_LIMIT", `У задачи не может быть больше ${MAX_TAGS} тегов`);
  }

  return { ok: true, value: Object.freeze(normalized) };
}

/**
 * Нормализует один тег тем же способом, что и теги задачи.
 *
 * Используется для фильтра `task.list.tag`: trim, нижний регистр, лимит
 * `MAX_TAG_LENGTH`. Пустой или слишком длинный тег даёт
 * `TasksValidationError`.
 */
export function normalizeTag(value: string): string {
  const normalized = normalizeTags([value]);
  const tag = normalized[0];

  if (tag === undefined) {
    throw new TasksValidationError("TAG_EMPTY", "Тег не может быть пустым");
  }

  return tag;
}

/**
 * Проверяет, что массив тегов уже нормализован.
 *
 * Сравнивает вход с результатом `validateTags`, поэтому отклоняет верхний
 * регистр, внешние пробелы и дубликаты, включая Unicode-регистр (`Ä`/`ä`).
 * Store обязан вызывать эту функцию на границе сохранённой модели: перед
 * записью и после чтения задачи.
 */
export function validateNormalizedTags(value: unknown): TasksValidationResult<readonly string[]> {
  const normalized = validateTags(value);

  if (!normalized.ok) {
    return normalized;
  }

  if (!Array.isArray(value)) {
    return failure("INVALID_TAGS", "Теги должны быть массивом строк");
  }

  const input = value as readonly string[];

  if (input.length !== normalized.value.length) {
    return failure("INVALID_NORMALIZED_TAGS", "Сохранённые теги не должны содержать дубликаты");
  }

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== normalized.value[index]) {
      return failure(
        "INVALID_NORMALIZED_TAGS",
        "Сохранённые теги должны быть trim и в нижнем регистре",
      );
    }
  }

  return normalized;
}

/**
 * Проверяет сохранённую модель задачи: инвариант `completedAt` и
 * нормализованные теги.
 *
 * Это граница Store: реализация KAN-011 обязана вызывать функцию перед
 * записью и после чтения.
 */
export function validateStoredTask(
  task: Pick<Task, "status" | "completedAt" | "tags">,
): TasksValidationResult<true> {
  const completion = validateCompletionInvariant(task);

  if (!completion.ok) {
    return completion;
  }

  const tags = validateNormalizedTags(task.tags);

  if (!tags.ok) {
    return tags;
  }

  return { ok: true, value: true };
}

/** Бросает `TasksValidationError`, если сохранённая задача невалидна. */
export function assertStoredTask(task: Pick<Task, "status" | "completedAt" | "tags">): void {
  const result = validateStoredTask(task);

  if (!result.ok) {
    throw new TasksValidationError(result.code, result.message);
  }
}

/**
 * Проверяет родителя подзадачи.
 *
 * Подзадача может ссылаться только на корневую задачу того же проекта.
 * `null` и `undefined` означают, что родитель не найден.
 */
export function validateSubtaskParent(
  childProjectId: string,
  parent: ParentTaskSnapshot | null | undefined,
): TasksValidationResult<{ readonly parentTaskId: string | null }> {
  if (parent === null || parent === undefined) {
    return failure("PARENT_NOT_FOUND", "Родительская задача не найдена");
  }

  if (parent.projectId !== childProjectId) {
    return failure("PARENT_IN_OTHER_PROJECT", "Родительская задача принадлежит другому проекту");
  }

  if (parent.parentTaskId !== null) {
    return failure(
      "SUBTASK_DEPTH_EXCEEDED",
      "Подзадача может иметь только один уровень вложенности",
    );
  }

  return { ok: true, value: { parentTaskId: parent.id } };
}

/**
 * Вычисляет `completedAt` при смене статуса.
 *
 * Чистая доменная функция для Store:
 * - создание в `done` — `resolveCompletedAt("done", null, createdAt)`;
 * - перемещение в `done` — `resolveCompletedAt("done", previous, updatedAt)`;
 * - выход из `done` — `resolveCompletedAt(status, previous, now)` даёт `null`.
 *
 * Повторный `completeTask` для уже завершённой задачи не вызывает обновление:
 * Store возвращает текущую задачу без изменения версии.
 */
export function resolveCompletedAt(
  status: TaskStatus,
  previousCompletedAt: UtcTimestamp | null,
  now: UtcTimestamp,
): UtcTimestamp | null {
  if (!isUtcTimestamp(now)) {
    throw new TasksValidationError("INVALID_TIMESTAMP", "Текущее время должно быть UTC timestamp");
  }

  if (previousCompletedAt !== null && !isUtcTimestamp(previousCompletedAt)) {
    throw new TasksValidationError(
      "INVALID_TIMESTAMP",
      "Предыдущий completedAt должен быть UTC timestamp",
    );
  }

  if (status !== "done") {
    return null;
  }

  return previousCompletedAt ?? now;
}

/**
 * Проверяет доменный инвариант `done ⇔ completedAt !== null`.
 *
 * Схема `TaskSchema` выражает то же правило, а эта функция нужна Store и
 * обработчикам для явной проверки после вычисления `completedAt`.
 */
export function validateCompletionInvariant(
  task: Pick<Task, "status" | "completedAt">,
): TasksValidationResult<true> {
  const isDone = task.status === "done";
  const hasCompletedAt = task.completedAt !== null;

  if (isDone !== hasCompletedAt) {
    return failure(
      "INVALID_COMPLETION",
      isDone
        ? "Задача в done обязана иметь completedAt"
        : "completedAt допустим только для задачи в done",
    );
  }

  return { ok: true, value: true };
}

/**
 * Возвращает ключ области уникальности позиции `(projectId, status)`.
 *
 * `parentTaskId` намеренно не входит в область: подзадачи и корневые задачи
 * одного проекта и статуса упорядочиваются вместе. Непрерывность `0…N-1` не
 * требуется.
 */
export function taskPositionScopeKey(projectId: string, status: TaskStatus): string {
  return `${projectId}:${status}`;
}

/**
 * Проверяет позицию задачи.
 *
 * Проверяется только диапазон; уникальность и порядок обеспечиваются Store в
 * области `(projectId, status)`. Непрерывность позиций не требуется.
 */
export function validatePosition(value: unknown): TasksValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return failure("INVALID_POSITION", "Позиция должна быть целым числом");
  }

  if (value < 0 || value > MAX_POSITION) {
    return failure("INVALID_POSITION", `Позиция должна быть в диапазоне 0..${MAX_POSITION}`);
  }

  return { ok: true, value };
}

/** Проверяет лимит страницы. */
export function validateLimit(
  value: unknown,
  options: { readonly defaultLimit?: number; readonly maxLimit?: number } = {},
): TasksValidationResult<number> {
  const maxLimit = options.maxLimit ?? MAX_LIST_LIMIT;

  if (value === undefined) {
    return { ok: true, value: options.defaultLimit ?? DEFAULT_LIST_LIMIT };
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maxLimit) {
    return failure("INVALID_LIMIT", `Лимит должен быть целым числом в диапазоне 1..${maxLimit}`);
  }

  return { ok: true, value };
}

/** Проверяет смещение страницы. */
export function validateOffset(value: unknown): TasksValidationResult<number> {
  if (value === undefined) {
    return { ok: true, value: 0 };
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return failure("INVALID_OFFSET", "Смещение должно быть целым неотрицательным числом");
  }

  return { ok: true, value };
}

/** Проверяет `limit`/`offset` и подставляет значения по умолчанию. */
export function validatePagination(
  input: { readonly limit?: unknown; readonly offset?: unknown },
  options: { readonly defaultLimit?: number; readonly maxLimit?: number } = {},
): TasksValidationResult<{ readonly limit: number; readonly offset: number }> {
  const limit = validateLimit(input.limit, options);

  if (!limit.ok) {
    return limit;
  }

  const offset = validateOffset(input.offset);

  if (!offset.ok) {
    return offset;
  }

  return { ok: true, value: { limit: limit.value, offset: offset.value } };
}

/** Проверяет `expectedVersion`; для создания допустим только 0. */
export function validateExpectedVersion(
  value: unknown,
  options: { readonly allowZero?: boolean } = {},
): TasksValidationResult<number> {
  const minimum = options.allowZero === true ? 0 : 1;

  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    return failure(
      "INVALID_EXPECTED_VERSION",
      `expectedVersion должен быть целым числом ≥ ${minimum}`,
    );
  }

  return { ok: true, value };
}
