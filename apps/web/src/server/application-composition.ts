import {
  adaptResourceServiceErrors,
  createOperationBus,
  createSearchService,
  EventBus,
  KernelResourceService,
  LinkService,
  OperationBus,
  OperationFailure,
  ResourceRegistry,
  ResourceServiceError,
  subscribeResourceDeletedCleanup,
  type OperationBusOptions,
} from "@kanbaner/kernel";
import {
  createPluginError,
  isEventSubscription,
  isPluginId,
  toErrorResult,
  validateUiContribution,
  type EventSubscription,
  type JsonValue,
  type OperationResult,
  type PluginHostServices,
  type PluginId,
  type PluginLogger,
  type SearchRegistrar,
  type StorageProvider,
  type UiContribution,
  type UiContributionRegistrar,
} from "@kanbaner/plugin-sdk";

const NOOP_LOGGER: PluginLogger = Object.freeze({
  debug(): void {
    // Намеренно пусто.
  },
  info(): void {
    // Намеренно пусто.
  },
  warn(): void {
    // Намеренно пусто.
  },
  error(): void {
    // Намеренно пусто.
  },
});

export interface PluginUiContributionRecord {
  readonly pluginId: PluginId;
  readonly contribution: UiContribution;
}

/**
 * Серверный реестр UI-метаданных.
 *
 * Хранит только сериализуемые декларации SDK. React-рендерер и DOM
 * подключаются на клиенте через публичный UI API; сервер не знает о DOM.
 */
export class UiMetadataRegistry implements UiContributionRegistrar {
  readonly #byPlugin = new Map<PluginId, readonly UiContribution[]>();

  register(pluginId: PluginId, contributions: readonly UiContribution[]): void {
    if (!isPluginId(pluginId)) {
      throw new TypeError("Некорректный Plugin ID UI-вклада");
    }

    const seen = new Set<string>();
    const validated: UiContribution[] = [];

    for (const contribution of contributions) {
      const result = validateUiContribution(contribution);

      if (!result.ok) {
        throw new TypeError("UI-вклад не прошёл валидацию Plugin Contract");
      }

      if (seen.has(result.value.id) || this.#idExists(result.value.id)) {
        throw new TypeError("UI-вклад с таким ID уже зарегистрирован");
      }

      seen.add(result.value.id);
      validated.push({ ...result.value });
    }

    this.#byPlugin.set(pluginId, [...(this.#byPlugin.get(pluginId) ?? []), ...validated]);
  }

  unregister(pluginId: PluginId): void {
    this.#byPlugin.delete(pluginId);
  }

  list(): readonly PluginUiContributionRecord[] {
    const records: PluginUiContributionRecord[] = [];

    for (const [pluginId, contributions] of [...this.#byPlugin].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      for (const contribution of contributions) {
        records.push({ pluginId, contribution });
      }
    }

    return records;
  }

  #idExists(id: string): boolean {
    for (const contributions of this.#byPlugin.values()) {
      if (contributions.some((contribution) => contribution.id === id)) {
        return true;
      }
    }

    return false;
  }
}

export interface ApplicationPluginCompositionOptions {
  readonly storage: StorageProvider;
  readonly logger?: PluginLogger;
  readonly operationBus?: Omit<OperationBusOptions, "resources" | "events" | "search" | "storage">;
}

/**
 * Общий composition плагинной инфраструктуры приложения.
 *
 * Один экземпляр EventBus, ResourceRegistry, LinkService, KernelResourceService
 * и OperationBus используется и runtime-ом активации, и выполнением команд.
 * Production LinkStore берётся из активного Storage Provider (SQLite), а не из
 * in-memory реализации.
 */
export interface ApplicationPluginComposition {
  readonly events: EventBus;
  readonly registry: ResourceRegistry;
  readonly links: LinkService;
  readonly resources: KernelResourceService;
  readonly search: SearchRegistrar;
  readonly operations: OperationBus;
  readonly ui: UiMetadataRegistry;
  readonly services: PluginHostServices;
  /** Подписки удаления ресурса для namespace-ов активных плагинов. */
  bindPlugins(pluginIds: readonly PluginId[]): void;
  listUiContributions(): readonly PluginUiContributionRecord[];
  executeUiOperation(operationId: string, input: JsonValue): Promise<OperationResult<unknown>>;
  dispose(): void;
}

function namespacesOf(pluginIds: readonly PluginId[]): readonly EventSubscription[] {
  const subscriptions = new Set<EventSubscription>();

  for (const pluginId of pluginIds) {
    if (!isPluginId(pluginId)) {
      continue;
    }

    const namespace = pluginId.split(".")[0];
    const subscription = `${namespace ?? ""}.*`;

    if (isEventSubscription(subscription)) {
      subscriptions.add(subscription);
    }
  }

  return [...subscriptions].sort();
}

function mapResourceError(error: unknown): OperationFailure | undefined {
  if (!(error instanceof ResourceServiceError)) {
    return undefined;
  }

  return OperationFailure.from(error.toResult().error);
}

export function createApplicationPluginComposition(
  options: ApplicationPluginCompositionOptions,
): ApplicationPluginComposition {
  const logger = options.logger ?? NOOP_LOGGER;
  const events = new EventBus({ logger });
  const registry = new ResourceRegistry({ logger });
  const links = new LinkService({ store: options.storage.links, logger });
  const resources = new KernelResourceService({ registry, links });
  const search = createSearchService(options.storage);
  const ui = new UiMetadataRegistry();

  const operations = createOperationBus({
    ...options.operationBus,
    logger,
    resources: adaptResourceServiceErrors(resources, mapResourceError),
    events,
    search,
    storage: options.storage,
  });

  let unsubscribeDeleted = (): boolean => false;

  const services: PluginHostServices = {
    commands: {
      execute: operations.commands.execute.bind(operations.commands),
      register: (registration) => {
        operations.registerCommand(registration);
      },
      unregister: (operationId) => operations.registry.unregister(operationId),
    },
    queries: {
      execute: operations.queries.execute.bind(operations.queries),
      register: (registration) => {
        operations.registerQuery(registration);
      },
      unregister: (operationId) => operations.registry.unregister(operationId),
    },
    resources,
    resourceTypes: {
      register(pluginId, registration) {
        registry.register({
          pluginId,
          resourceTypes: registration.resourceTypes,
          adapter: registration.adapter,
        });
      },
      unregister(pluginId) {
        return registry.unregister(pluginId);
      },
    },
    events,
    storage: options.storage,
    search,
    ui,
  };

  return {
    events,
    registry,
    links,
    resources,
    search,
    operations,
    ui,
    services,

    bindPlugins(pluginIds: readonly PluginId[]): void {
      unsubscribeDeleted();
      unsubscribeDeleted = subscribeResourceDeletedCleanup(
        events,
        links,
        namespacesOf(pluginIds),
        { pluginId: "kanbaner.core" },
        search,
      );
    },

    listUiContributions(): readonly PluginUiContributionRecord[] {
      return ui.list();
    },

    async executeUiOperation(
      operationId: string,
      input: JsonValue,
    ): Promise<OperationResult<unknown>> {
      const descriptor = operations.registry.get(operationId);

      if (descriptor === undefined || descriptor.exposure.ui !== true) {
        return toErrorResult(createPluginError("PLUGIN_UNAVAILABLE", "Операция недоступна для UI"));
      }

      const executionOptions = {
        source: { type: "ui" as const, id: "web" },
      };

      return descriptor.kind === "mutation"
        ? operations.executeCommand(operationId, input, executionOptions)
        : operations.executeQuery(operationId, input, executionOptions);
    },

    dispose(): void {
      unsubscribeDeleted();
      events.dispose();
    },
  };
}
