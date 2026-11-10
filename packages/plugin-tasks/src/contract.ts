/**
 * Client-safe entrypoint домена задач.
 *
 * Здесь публикуются только константы, TypeBox/JSON Schema, производные типы,
 * чистые доменные валидаторы, backend-neutral компараторы списков,
 * `ResourceRef`, payload событий и чистое преобразование в
 * `SearchDocumentInput`. Модуль не содержит `activate`, Store,
 * обращений к `node:*`, SQL и серверных зависимостей, поэтому его может
 * импортировать UI и другой плагин.
 *
 * Серверная точка входа `@kanbaner/plugin-tasks` дополнительно экспортирует
 * метаданные операций и `TasksStore`.
 */
export * from "./constants.ts";
export * from "./model.ts";
export * from "./schemas/common.ts";
export * from "./schemas/column.ts";
export * from "./schemas/project.ts";
export * from "./schemas/task.ts";
export * from "./schemas/queries.ts";
export * from "./validation.ts";
export * from "./listing.ts";
export * from "./resources.ts";
export * from "./events.ts";
export * from "./search.ts";
