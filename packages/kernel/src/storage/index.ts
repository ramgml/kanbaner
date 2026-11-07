/**
 * Локальная точка входа Storage-слоя ядра.
 *
 * Корневой `packages/kernel/src/index.ts` подключает модуль отдельной задачей
 * оркестратора. Пакет не содержит SQL, драйвера БД и доменных понятий.
 */
export * from "./bootstrap.ts";
export * from "./conformance.ts";
export * from "./errors.ts";
export * from "./in-memory-provider.ts";
export * from "./migrations.ts";
export * from "./registry.ts";
