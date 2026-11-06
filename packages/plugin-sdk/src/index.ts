/**
 * Версия Plugin Contract, которую реализует SDK.
 *
 * Каркас KAN-001 намеренно не содержит команд, запросов, событий и
 * доменных типов. Публичные контракты добавляются в KAN-002.
 */
export const PLUGIN_CONTRACT_VERSION = "1" as const;

/** Идентификатор плагина в формате `<namespace>.<plugin>`. */
export type PluginId = string;
