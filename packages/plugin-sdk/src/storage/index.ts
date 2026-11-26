/**
 * Публичные контракты Storage-слоя.
 *
 * Модуль не зависит от ядра, React, SQL, драйвера БД и доменных плагинов.
 * Все операции Provider и Store асинхронны, публичные ID создаются
 * приложением до записи, время передаётся в UTC.
 */
export * from "./capabilities.ts";
export * from "./common.ts";
export * from "./documents.ts";
export * from "./errors.ts";
export * from "./links.ts";
export * from "./migrations.ts";
export * from "./plugin-state.ts";
export * from "./provider.ts";
export * from "./search.ts";
export * from "./plugin-storage.ts";
export * from "./stores.ts";
export * from "./time.ts";
