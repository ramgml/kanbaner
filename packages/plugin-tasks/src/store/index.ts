/**
 * Реализация доменного Store задач.
 *
 * Модуль использует только публичный `@kanbaner/plugin-sdk` и собственные
 * типы пакета. SQL, имена таблиц, драйвер БД и синхронные операции Store
 * отсутствуют.
 */
export {
  TasksNotFoundError,
  TasksStoreValidationError,
  TasksVersionConflictError,
  TASKS_NOT_FOUND_CODE,
  TASKS_STORE_VALIDATION_CODE,
  TASKS_VERSION_CONFLICT_CODE,
} from "./errors.ts";
export {
  createTasksStore,
  type CreateTasksStoreOptions,
  type TasksNowSource,
} from "./create-tasks-store.ts";
