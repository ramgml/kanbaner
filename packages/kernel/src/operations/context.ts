import type {
  EventEnvelope,
  EventHandler,
  EventPublishOptions,
  EventPublishResult,
  EventService,
  EventSubscription,
  EventUnsubscribe,
  PluginEventService,
  PluginId,
  PluginLogger,
  ResourceDescriptor,
  ResourceLink,
  ResourceService,
  OperationResult,
} from "@kanbaner/plugin-sdk";

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
/** Заглушка событий, если composition root не подключил шину. */
export function createUnavailableEventService(): EventService {
  return {
    subscribe(): EventUnsubscribe {
      throw new OperationFailure("PLUGIN_UNAVAILABLE", "Шина событий не подключена");
    },
    publishAfterCommit(): Promise<EventPublishResult> {
      return Promise.reject(
        new OperationFailure("PLUGIN_UNAVAILABLE", "Шина событий не подключена"),
      );
    },
  };
}

/**
 * Привязывает хост-сервис событий к namespace-у операции.
 *
 * Плагин не может подменить `pluginId` подписки или опубликовать событие
 * чужого namespace-а.
 */
export function bindEventService(events: EventService, pluginId: PluginId): PluginEventService {
  return {
    subscribe(type: EventSubscription, handler: EventHandler): EventUnsubscribe {
      return events.subscribe(type, handler, { pluginId });
    },
    publishAfterCommit(
      envelope: EventEnvelope,
      options: EventPublishOptions,
    ): Promise<EventPublishResult> {
      if (envelope.source !== pluginId || !envelope.type.startsWith(`${pluginId}.`)) {
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
