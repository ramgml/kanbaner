import type {
  EventEnvelope,
  EventPublishOptions,
  EventPublishResult,
  EventService,
  PluginEventPublisher,
  PluginId,
  PluginLogger,
  PluginSearchService,
  ResourceDescriptor,
  ResourceLink,
  ResourceService,
  OperationResult,
  SearchHit,
  SearchIndexDocument,
  SearchRegistrar,
} from "@kanbaner/plugin-sdk";
import { isEventOwnedByPlugin } from "@kanbaner/plugin-sdk";

import { bindPluginSearch } from "../search/binding.ts";
import { OperationFailure } from "./errors.ts";

/** Логгер по умолчанию: ядро не требует обязательного журналирования. */
export const NOOP_LOGGER: PluginLogger = Object.freeze({
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

function unavailable(): Promise<never> {
  return Promise.reject(
    new OperationFailure("PLUGIN_UNAVAILABLE", "Сервис ресурсов не подключён к шине операций"),
  );
}

/**
 * Заглушка `ctx.resources` до подключения сервиса из KAN-005.
 *
 * Не возвращает пустые данные: обращение к неприсоединённому сервису должно
 * быть явной ошибкой, а не скрытым успехом.
 */
/**
 * Заглушка publication-only сервиса событий.
 *
 * ExecutionContext не умеет подписываться: регистрация подписок остаётся
 * только в activation tracker и снимается при деактивации.
 */
export function createUnavailableEventPublisher(): PluginEventPublisher {
  return {
    publishAfterCommit(): Promise<EventPublishResult> {
      return Promise.reject(
        new OperationFailure("PLUGIN_UNAVAILABLE", "Шина событий не подключена"),
      );
    },
  };
}

/**
 * Привязывает publication-only хост-сервис событий к namespace-у операции.
 *
 * Проверяются источник, тип и владелец ResourceRef. Подписка через
 * ExecutionContext недоступна по типу и по объекту.
 */
export function bindEventPublisher(
  events: Pick<EventService, "publishAfterCommit">,
  pluginId: PluginId,
): PluginEventPublisher {
  return {
    publishAfterCommit(
      envelope: EventEnvelope,
      options: EventPublishOptions,
    ): Promise<EventPublishResult> {
      if (!isEventOwnedByPlugin(envelope, pluginId)) {
        return Promise.reject(
          new OperationFailure(
            "PERMISSION_DENIED",
            "Публикация события вне namespace-а плагина запрещена",
          ),
        );
      }

      return events.publishAfterCommit(envelope, options);
    },
  };
}

function searchUnavailable(): Promise<never> {
  return Promise.reject(
    new OperationFailure("PLUGIN_UNAVAILABLE", "Поисковый сервис не подключён к шине"),
  );
}

export function createUnavailableSearchRegistrar(): SearchRegistrar {
  return {
    upsert(): Promise<number> {
      return searchUnavailable();
    },
    delete(): Promise<boolean> {
      return searchUnavailable();
    },
    list(): Promise<readonly SearchIndexDocument[]> {
      return searchUnavailable();
    },
    search(): Promise<readonly SearchHit[]> {
      return searchUnavailable();
    },
    reindex(): Promise<number> {
      return searchUnavailable();
    },
  };
}

export function bindSearchService(
  search: SearchRegistrar,
  pluginId: PluginId,
): PluginSearchService {
  return bindPluginSearch(search, pluginId);
}

export function createUnavailableResourceService(): ResourceService {
  return {
    link(): Promise<ResourceLink> {
      return unavailable();
    },
    unlink(): Promise<void> {
      return unavailable();
    },
    list(): Promise<readonly ResourceLink[]> {
      return unavailable();
    },
    resolve(): Promise<OperationResult<ResourceDescriptor>> {
      return unavailable();
    },
    canOpen(): Promise<boolean> {
      return unavailable();
    },
    open(): Promise<void> {
      return unavailable();
    },
  };
}
