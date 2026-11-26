/** Версия Plugin Contract, которую реализует SDK. */
export const PLUGIN_CONTRACT_VERSION = "1" as const;

/**
 * Числовая версия Plugin Contract для конвертов команд, запросов и событий.
 *
 * Строковая константа выше используется как часть идентификаторов контрактов
 * (`*.v1`), а в логических конвертах версия передаётся целым числом.
 */
export const PLUGIN_CONTRACT_VERSION_NUMBER = 1 as const;

/** Диалект JSON Schema, в котором SDK описывает и валидирует контракты. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

/** Версия внутрипроцессного UI-контракта. */
export const UI_CONTRACT_VERSION = "1" as const;

/** Опции TypeBox, помечающие самостоятельную схему как Draft 2020-12. */
export const DRAFT_2020_12 = { $schema: JSON_SCHEMA_DIALECT } as const;
