/**
 * Шина команд и запросов ядра.
 *
 * Локальная точка входа `packages/kernel/src/operations/index.ts`.
 * Корневой `packages/kernel/src/index.ts` подключает её отдельной задачей
 * оркестратора, чтобы не смешивать состав публичного API ядра.
 */
export * from "./bus.ts";
export * from "./context.ts";
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./registry.ts";
export * from "./resource-adapter.ts";
export * from "./types.ts";
