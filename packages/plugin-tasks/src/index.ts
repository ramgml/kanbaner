/**
 * Серверная точка входа плагина задач.
 *
 * Публичный client-safe контракт живёт в `@kanbaner/plugin-tasks/contract`.
 * Здесь он дополняется метаданными операций и контрактом `TasksStore`, которые
 * нужны composition root и реализации плагина, но не UI.
 */
export * from "./contract.ts";
export * from "./operations.ts";
export * from "./store.ts";
export * from "./store/index.ts";
export { activate, type TasksActivationContext } from "./activation.ts";
