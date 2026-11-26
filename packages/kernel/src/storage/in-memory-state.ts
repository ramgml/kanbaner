import type {
  AppliedMigration,
  PluginDocument,
  PluginStateRecord,
  ResourceLink,
  SearchIndexDocument,
} from "./contracts.ts";

/**
 * Внутреннее состояние тестового in-memory backend.
 *
 * Имена полей соответствуют логическим инфраструктурным областям ядра
 * (`core_plugins`, `core_plugin_migrations`, `core_resource_links`), но в
 * публичные контракты имена таблиц не попадают.
 */
export interface InMemoryState {
  readonly documents: Map<string, PluginDocument>;
  readonly links: Map<string, ResourceLink>;
  readonly pluginStates: Map<string, PluginStateRecord>;
  readonly migrations: Map<string, AppliedMigration>;
  readonly search: Map<string, SearchIndexDocument>;
}

export type StoreRunner = <T>(operation: (state: InMemoryState) => T | Promise<T>) => Promise<T>;

export function createEmptyState(): InMemoryState {
  return {
    documents: new Map<string, PluginDocument>(),
    links: new Map<string, ResourceLink>(),
    pluginStates: new Map<string, PluginStateRecord>(),
    migrations: new Map<string, AppliedMigration>(),
    search: new Map<string, SearchIndexDocument>(),
  };
}

export function cloneState(state: InMemoryState): InMemoryState {
  return {
    documents: cloneMap(state.documents),
    links: cloneMap(state.links),
    pluginStates: cloneMap(state.pluginStates),
    migrations: cloneMap(state.migrations),
    search: cloneMap(state.search),
  };
}

function cloneMap<T>(map: ReadonlyMap<string, T>): Map<string, T> {
  return new Map<string, T>([...map].map(([key, value]) => [key, structuredClone(value)]));
}

export function documentKey(pluginId: string, collection: string, id: string): string {
  return JSON.stringify([pluginId, collection, id]);
}

export function linkKey(sourceRef: string, targetRef: string, relation: string): string {
  return JSON.stringify([sourceRef, targetRef, relation]);
}

export function migrationKey(backendId: string, pluginId: string, version: number): string {
  return JSON.stringify([backendId, pluginId, version]);
}
