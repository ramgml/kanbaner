import {
  parseResourceRef,
  type EventSubscription,
  type EventType,
  type SearchRegistrar,
} from "@kanbaner/plugin-sdk";

import {
  type EventBus,
  type EventHandler,
  type EventSubscriptionOptions,
  type EventUnsubscribe,
} from "../events/index.ts";
import type { LinkService } from "./link-service.ts";

type CleanupTarget = Pick<LinkService, "cleanup">;

/**
 * Проверяет контрактное имя действия удаления без доменных типов.
 *
 * Событие ресурса имеет формат `<plugin-id>.<resource>.<past-tense-action>`.
 * Ядру достаточно последнего сегмента `deleted`, чтобы очистить связи; оно не
 * знает, какой именно доменный ресурс удалён.
 */
export function isResourceDeletedEvent(type: EventType): boolean {
  return type.split(".").at(-1) === "deleted";
}

/**
 * Создаёт обработчик, который очищает связи удалённого ресурса.
 *
 * Обработчик читает только `type` и `resource` из конверта, поэтому не зависит
 * от плагина, домена и payload. Ошибка очистки пробрасывается в шину, где
 * изолируется и журналируется без payload.
 */
export function createResourceDeletedHandler(
  links: CleanupTarget,
  search?: Pick<SearchRegistrar, "delete">,
): EventHandler {
  return async (envelope) => {
    if (!isResourceDeletedEvent(envelope.type)) {
      return;
    }

    const parts = parseResourceRef(envelope.resource);

    // Событие обязано быть опубликовано владельцем ресурса. Иначе чужой
    // плагин мог бы очистить связи и поисковый индекс другого namespace-а.
    if (parts.pluginId !== envelope.source) {
      return;
    }

    await links.cleanup(envelope.resource);

    if (search !== undefined) {
      await search.delete(parts.pluginId, envelope.resource);
    }
  };
}

/**
 * Подписывает очистку связей на события удаления.
 *
 * Контракт допускает wildcard только в конце сегментов и не имеет
 * глобального `*`, поэтому composition root передаёт по одному шаблону на
 * namespace включённых плагинов, например `kanbaner.*` или `acme.*`.
 *
 * `pluginId` используется только для безопасной диагностики ошибок.
 */
export function subscribeResourceDeletedCleanup(
  events: EventBus,
  links: CleanupTarget,
  subscriptions: readonly EventSubscription[],
  options: EventSubscriptionOptions,
  search?: Pick<SearchRegistrar, "delete">,
): EventUnsubscribe {
  const handler = createResourceDeletedHandler(links, search);
  const unsubscribers: EventUnsubscribe[] = [];

  try {
    for (const subscription of subscriptions) {
      unsubscribers.push(events.subscribe(subscription, handler, options));
    }
  } catch (error) {
    for (let index = unsubscribers.length - 1; index >= 0; index -= 1) {
      unsubscribers[index]?.();
    }

    throw error;
  }

  return () => {
    let removed = false;

    for (const unsubscribe of unsubscribers) {
      removed = unsubscribe() || removed;
    }

    return removed;
  };
}
