/**
 * Ошибки реализации `TasksStore`.
 *
 * Коды совпадают по смыслу с Plugin Contract и не раскрывают SQL, пути или
 * содержимое документов. Версия в конфликте — публичная версия доменной
 * сущности, а не внутренняя ревизия документа Storage Provider.
 */

/** Код конфликта ожидаемой и текущей версии. */
export const TASKS_VERSION_CONFLICT_CODE = "VERSION_CONFLICT" as const;

/** Код отсутствующей сущности. */
export const TASKS_NOT_FOUND_CODE = "NOT_FOUND" as const;

/** Код невалидного документа на границе Store. */
export const TASKS_STORE_VALIDATION_CODE = "VALIDATION_ERROR" as const;

/** Конфликт `expectedVersion`: документ не перезаписывается. */
export class TasksVersionConflictError extends Error {
  override readonly name = "TasksVersionConflictError";
  readonly code = TASKS_VERSION_CONFLICT_CODE;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super("Сущность была изменена другой операцией");
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Запрошенная сущность не существует. */
export class TasksNotFoundError extends Error {
  override readonly name = "TasksNotFoundError";
  readonly code = TASKS_NOT_FOUND_CODE;
  readonly entity: "project" | "task" | "column";
  readonly id: string;

  constructor(entity: "project" | "task" | "column", id: string) {
    super(
      entity === "project"
        ? "Проект не найден"
        : entity === "column"
          ? "Колонка не найдена"
          : "Задача не найдена",
    );
    this.entity = entity;
    this.id = id;
  }
}

/** Документ не соответствует сохранённой модели задач или проекта. */
export class TasksStoreValidationError extends Error {
  override readonly name = "TasksStoreValidationError";
  readonly code = TASKS_STORE_VALIDATION_CODE;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}
