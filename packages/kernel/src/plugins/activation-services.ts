import {
  createStorageCapabilities,
  StorageError,
  type ActivationCommandRegistration,
  type ActivationQueryRegistration,
  type ActivationResourceRegistration,
  type CommandMetadata,
  type EventEnvelope,
  type EventHandler,
  type EventPublishOptions,
  type EventPublishResult,
  type EventService,
  type EventSubscription,
  type EventUnsubscribe,
  type InvocationOptions,
  type OperationId,
  type OperationResult,
  type PluginActivationServices,
  type PluginCommandService,
  type PluginEventService,
  type PluginHostServices,
  type PluginId,
  type PluginQueryService,
  type PluginSearchService,
  type PluginStorage,
  type PluginUiRegistrar,
  type ResourceDescriptor,
  type ResourceLink,
  type ResourceRef,
  type ResourceService,
  type SearchRegistrar,
  type StorageCapabilities,
  type StorageProvider,
  type StorageStoreRegistration,
  type StorageTransaction,
  type UiContribution,
  isEventOwnedByPlugin,
} from "@kanbaner/plugin-sdk";

import { OperationFailure } from "../operations/errors.ts";
import { bindPluginSearch } from "../search/binding.ts";
import { bindPluginStorage } from "../storage/plugin-storage-binding.ts";

/*
 * Заглушки повторяют публичные сигнатуры SDK, но намеренно не используют
 * аргументы: сервис недоступен до подключения composition root.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

function unavailableError(message: string): OperationFailure {
  return new OperationFailure("PLUGIN_UNAVAILABLE", message);
}

function reject<T>(error: Error = unavailableError("Сервис не подключён к runtime")): Promise<T> {
  return Promise.reject(error);
}

function storageUnavailable(): StorageError {
  return new StorageError("PROVIDER_NOT_READY", "Storage Provider не подключён к runtime");
}

function commandMetadataOwnedBy(metadata: CommandMetadata, pluginId: PluginId): boolean {
  return metadata.id.startsWith(`${pluginId}.`);
}

/* -------------------------------------------------------------------------- */
/* Unavailable defaults                                                       */
/* -------------------------------------------------------------------------- */

function createUnavailableStorageProvider(): StorageProvider {
  const closed = (): Promise<never> => Promise.reject(storageUnavailable());
  const capabilities: StorageCapabilities = createStorageCapabilities();

  return {
    backendId: "unavailable",
    capabilities,
    documents: {
      get: closed,
      put: closed,
      delete: closed,
      query: closed,
      list: closed,
    },
    links: {
      add: closed,
      remove: closed,
      listByRef: closed,
      deleteByRef: closed,
    },
    pluginStates: {
      get: closed,
      put: closed,
      delete: closed,
      list: closed,
    },
    migrations: {
      list: closed,
      find: closed,
      record: closed,
    },
    searchIndex: {
      strategy: "substring",
      upsert: closed,
      delete: closed,
      deleteMany: closed,
      clear: closed,
      search: closed,
      list: closed,
      reindex: closed,
    },
    open: closed,
    close: closed,
    healthCheck: closed,
    withTransaction<T>(_callback: (transaction: StorageTransaction) => Promise<T>): Promise<T> {
      return closed();
    },
    createStore<TStore>(_registration: StorageStoreRegistration<TStore>): Promise<TStore> {
      return closed();
    },
  };
}

function createUnavailableCommandService(): PluginCommandService {
  return {
    execute<TInput = unknown, TOutput = unknown>(
      _commandId: OperationId,
      _input: TInput,
      _options?: InvocationOptions,
    ): Promise<OperationResult<TOutput>> {
      return reject();
    },
    register(_registration: ActivationCommandRegistration): void {
      throw unavailableError("Регистратор команд не подключён к runtime");
    },
    unregister(_operationId: OperationId): boolean {
      return false;
    },
  };
}

function createUnavailableQueryService(): PluginQueryService {
  return {
    execute<TInput = unknown, TOutput = unknown>(
      _queryId: OperationId,
      _input: TInput,
      _options?: InvocationOptions,
    ): Promise<OperationResult<TOutput>> {
      return reject();
    },
    register(_registration: ActivationQueryRegistration): void {
      throw unavailableError("Регистратор запросов не подключён к runtime");
    },
    unregister(_operationId: OperationId): boolean {
      return false;
    },
  };
}

function createUnavailableResourceService(): ResourceService {
  return {
    link(
      _sourceRef: ResourceRef,
      _targetRef: ResourceRef,
      _relation: string,
    ): Promise<ResourceLink> {
      return reject();
    },
    unlink(_sourceRef: ResourceRef, _targetRef: ResourceRef, _relation: string): Promise<void> {
      return reject();
    },
    list(_ref: ResourceRef, _relation?: string): Promise<readonly ResourceLink[]> {
      return reject();
    },
    resolve(_ref: ResourceRef): Promise<OperationResult<ResourceDescriptor>> {
      return reject();
    },
    canOpen(_ref: ResourceRef): Promise<boolean> {
      return reject();
    },
    open(_ref: ResourceRef): Promise<void> {
      return reject();
    },
  };
}

function createUnavailableEventService(): EventService {
  return {
    subscribe(
      _type: EventSubscription,
      _handler: EventHandler,
      _options: { readonly pluginId: PluginId },
    ): EventUnsubscribe {
      throw unavailableError("Шина событий не подключена к runtime");
    },
    publishAfterCommit(
      _envelope: EventEnvelope,
      _options: EventPublishOptions,
    ): Promise<EventPublishResult> {
      return reject();
    },
  };
}

function createUnavailableSearchRegistrar(): SearchRegistrar {
  const closed = (): Promise<never> =>
    Promise.reject(unavailableError("Поисковый сервис не подключён к runtime"));

  return {
    upsert: closed,
    delete: closed,
    list: closed,
    search: closed,
    reindex: closed,
  };
}

/** Безопасные заглушки для runtime без composition root. */
export function createUnavailableHostServices(): PluginHostServices {
  return {
    commands: createUnavailableCommandService(),
    queries: createUnavailableQueryService(),
    resources: createUnavailableResourceService(),
    resourceTypes: {
      register(_pluginId: PluginId, _registration: ActivationResourceRegistration): void {
        throw unavailableError("Регистратор ресурсов не подключён к runtime");
      },
      unregister(_pluginId: PluginId): boolean {
        return false;
      },
    },
    events: createUnavailableEventService(),
    storage: createUnavailableStorageProvider(),
    search: createUnavailableSearchRegistrar(),
    ui: {
      register(_pluginId: PluginId, _contributions: readonly UiContribution[]): void {
        throw unavailableError("Регистратор UI-вкладов не подключён к runtime");
      },
      unregister(_pluginId: PluginId): void {
        // Нет зарегистрированных вкладов.
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Bound services                                                             */
/* -------------------------------------------------------------------------- */

/** Освобождает всё, что плагин зарегистрировал во время активации. */
export interface BoundPluginServices extends PluginActivationServices {
  dispose(): void;
}

class BoundServices implements BoundPluginServices {
  readonly commands: PluginCommandService;
  readonly queries: PluginQueryService;
  readonly resources: ResourceService;
  readonly resourceTypes: PluginActivationServices["resourceTypes"];
  readonly events: PluginEventService;
  readonly storage: PluginStorage;
  readonly search: PluginSearchService;
  readonly ui: PluginUiRegistrar;
  readonly #unregisterCommands: () => void;
  readonly #unregisterQueries: () => void;
  readonly #unregisterResources: () => void;
  readonly #unregisterUi: () => void;
  readonly #unsubscribe: () => void;

  constructor(host: PluginHostServices, pluginId: PluginId) {
    const commandIds = new Set<OperationId>();
    const queryIds = new Set<OperationId>();
    const unsubscribers = new Set<EventUnsubscribe>();
    let resourcesRegistered = false;
    let uiRegistered = false;

    this.commands = {
      execute: host.commands.execute.bind(host.commands),
      register: (registration: ActivationCommandRegistration): void => {
        if (!commandMetadataOwnedBy(registration.metadata, pluginId)) {
          throw new OperationFailure(
            "PERMISSION_DENIED",
            "ID команды должен принадлежать namespace-у плагина",
          );
        }

        host.commands.register(registration);
        commandIds.add(registration.metadata.id);
      },
      unregister: (operationId: OperationId): boolean => {
        if (!operationId.startsWith(`${pluginId}.`) || !commandIds.delete(operationId)) {
          return false;
        }

        return host.commands.unregister(operationId);
      },
    };

    this.queries = {
      execute: host.queries.execute.bind(host.queries),
      register: (registration: ActivationQueryRegistration): void => {
        if (!registration.metadata.id.startsWith(`${pluginId}.`)) {
          throw new OperationFailure(
            "PERMISSION_DENIED",
            "ID запроса должен принадлежать namespace-у плагина",
          );
        }

        host.queries.register(registration);
        queryIds.add(registration.metadata.id);
      },
      unregister: (operationId: OperationId): boolean => {
        if (!operationId.startsWith(`${pluginId}.`) || !queryIds.delete(operationId)) {
          return false;
        }

        return host.queries.unregister(operationId);
      },
    };

    this.resources = host.resources;
    this.resourceTypes = {
      register: (registration: ActivationResourceRegistration): void => {
        host.resourceTypes.register(pluginId, registration);
        resourcesRegistered = true;
      },
      unregister: (): void => {
        if (!resourcesRegistered) {
          return;
        }

        resourcesRegistered = false;
        host.resourceTypes.unregister(pluginId);
      },
    };
    this.storage = bindPluginStorage(host.storage, pluginId);
    this.search = bindPluginSearch(host.search, pluginId);

    this.events = {
      subscribe(type: EventSubscription, handler: EventHandler): EventUnsubscribe {
        let active = true;
        const unsubscribe = host.events.subscribe(type, handler, { pluginId });
        const tracked: EventUnsubscribe = () => {
          if (!active) {
            return false;
          }

          active = false;
          unsubscribers.delete(tracked);

          return unsubscribe();
        };

        unsubscribers.add(tracked);

        return tracked;
      },
      publishAfterCommit(
        envelope: EventEnvelope,
        options: EventPublishOptions,
      ): Promise<EventPublishResult> {
        if (!isEventOwnedByPlugin(envelope, pluginId)) {
          return reject(
            new OperationFailure(
              "PERMISSION_DENIED",
              "Публикация события вне namespace-а плагина запрещена",
            ),
          );
        }

        return host.events.publishAfterCommit(envelope, options);
      },
    };

    this.ui = {
      register(contributions: readonly UiContribution[]): void {
        host.ui.register(pluginId, contributions);
        uiRegistered = true;
      },
      unregister(): void {
        if (!uiRegistered) {
          return;
        }

        uiRegistered = false;
        host.ui.unregister(pluginId);
      },
    };

    this.#unregisterCommands = (): void => {
      for (const operationId of [...commandIds]) {
        host.commands.unregister(operationId);
      }

      commandIds.clear();
    };
    this.#unregisterQueries = (): void => {
      for (const operationId of [...queryIds]) {
        host.queries.unregister(operationId);
      }

      queryIds.clear();
    };
    this.#unregisterResources = (): void => {
      if (resourcesRegistered) {
        resourcesRegistered = false;
        host.resourceTypes.unregister(pluginId);
      }
    };
    this.#unregisterUi = (): void => {
      if (uiRegistered) {
        uiRegistered = false;
        host.ui.unregister(pluginId);
      }
    };
    this.#unsubscribe = (): void => {
      for (const unsubscribe of [...unsubscribers]) {
        unsubscribe();
      }

      unsubscribers.clear();
    };
  }

  dispose(): void {
    this.#unregisterCommands();
    this.#unregisterQueries();
    this.#unregisterResources();
    this.#unregisterUi();
    this.#unsubscribe();
  }
}

/**
 * Создаёт сервисы активации, привязанные к конкретному плагину.
 *
 * Повторный вызов `dispose()` идемпотентен. Runtime вызывает его при
 * деактивации и откате неудачной активации, чтобы не оставлять глобальные
 * регистрации.
 */
export function bindPluginServices(
  host: PluginHostServices,
  pluginId: PluginId,
): BoundPluginServices {
  if (pluginId.length === 0) {
    throw new TypeError("Plugin ID обязателен для activation services");
  }

  return new BoundServices(host, pluginId);
}
