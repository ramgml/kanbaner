import type { JsonObject } from "../json.ts";
import type { PluginId, PluginVersion } from "../plugin-id.ts";
import type { UtcTimestamp } from "./time.ts";

/**
 * Состояние плагина в логической инфраструктурной записи ядра.
 *
 * Запись не содержит доменных данных: `state` принадлежит плагину и
 * интерпретируется только им.
 */
export interface PluginStateRecord {
  readonly pluginId: PluginId;
  readonly version: PluginVersion;
  readonly enabled: boolean;
  readonly state: JsonObject;
  readonly updatedAt: UtcTimestamp;
}

export interface PluginStatePutInput {
  readonly pluginId: PluginId;
  readonly version: PluginVersion;
  readonly enabled: boolean;
  readonly state: JsonObject;
}

/**
 * Асинхронное хранилище состояния и версии плагина.
 *
 * Отключение плагина не удаляет состояние; удаление выполняется отдельным
 * явным вызовом `delete`.
 */
export interface PluginStateStore {
  get(pluginId: PluginId): Promise<PluginStateRecord | null>;
  put(input: PluginStatePutInput): Promise<PluginStateRecord>;
  delete(pluginId: PluginId): Promise<boolean>;
  list(): Promise<readonly PluginStateRecord[]>;
}
