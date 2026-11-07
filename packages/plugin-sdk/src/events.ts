import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, PLUGIN_CONTRACT_VERSION_NUMBER } from "./contract.ts";
import { createJsonObjectSchema } from "./json.ts";
import { PluginIdSchema, SEGMENT_SOURCE, type PluginId } from "./plugin-id.ts";
import { ResourceRefSchema } from "./resources.ts";
import { UtcTimestampSchema } from "./time.ts";
import type { ValidationIssue } from "./validation.ts";

/**
 * Тип события `<plugin-id>.<resource>.<past-tense-action>`.
 *
 * Plugin ID занимает два сегмента, поэтому корректный тип события состоит
 * ровно из четырёх сегментов.
 */
export type EventType = string;

/** Подписка на событие или wildcard в конце сегментов, например `kanbaner.tasks.*`. */
export type EventSubscription = string;

export const EVENT_TYPE_PATTERN = `^${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE}){3}$`;

const SUBSCRIPTION_PREFIX = `${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE}){0,2}`;

export const EVENT_SUBSCRIPTION_PATTERN = `^(?:${SUBSCRIPTION_PREFIX}\\.\\*|${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE}){3})$`;

export const EventTypeSchema = Type.String({
  ...DRAFT_2020_12,
  minLength: 7,
  pattern: EVENT_TYPE_PATTERN,
});

export const EventSubscriptionSchema = Type.String({
  ...DRAFT_2020_12,
  minLength: 3,
  pattern: EVENT_SUBSCRIPTION_PATTERN,
});

/** Конверт доменного события. */
export const EventEnvelopeSchema = Type.Object(
  {
    eventId: Type.String({ minLength: 1 }),
    type: EventTypeSchema,
    contractVersion: Type.Literal(PLUGIN_CONTRACT_VERSION_NUMBER),
    source: PluginIdSchema,
    occurredAt: UtcTimestampSchema,
    resource: ResourceRefSchema,
    resourceVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    payload: createJsonObjectSchema(),
  },
  DRAFT_2020_12,
);

export type EventEnvelope = Static<typeof EventEnvelopeSchema>;

const eventTypeRegex = new RegExp(EVENT_TYPE_PATTERN);
const eventSubscriptionRegex = new RegExp(EVENT_SUBSCRIPTION_PATTERN);

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && eventTypeRegex.test(value);
}

export function isEventSubscription(value: unknown): value is EventSubscription {
  return typeof value === "string" && eventSubscriptionRegex.test(value);
}

/**
 * Проверяет соответствие события подписке.
 *
 * Wildcard допускается только как последний сегмент подписки. Сравнение
 * префикса идёт по границе сегментов, поэтому `kanbaner.tasks.*` не совпадает
 * с `kanbaner.task-list.task.created`.
 */
export function matchesEventSubscription(
  subscription: EventSubscription,
  eventType: EventType,
): boolean {
  if (!isEventSubscription(subscription) || !isEventType(eventType)) {
    return false;
  }

  if (subscription === eventType) {
    return true;
  }

  if (!subscription.endsWith(".*")) {
    return false;
  }

  return eventType.startsWith(subscription.slice(0, -1));
}

export interface EventSubscriptionMetadata {
  readonly type: EventSubscription;
}

/** Безопасный контекст доставки, не содержащий payload события. */
export interface EventDeliveryContext {
  readonly traceId: string;
}

/** Обработчик доменного события. */
export type EventHandler = (
  envelope: EventEnvelope,
  context: EventDeliveryContext,
) => void | Promise<void>;

/** Параметры подписки. `pluginId` используется только для диагностики. */
export interface EventSubscriptionOptions {
  readonly pluginId: PluginId;
}

/** Идемпотентная отмена подписки; `true`, если подписка была удалена. */
export type EventUnsubscribe = () => boolean;

/** Параметры явной публикации после успешного коммита. */
export interface EventPublishOptions {
  readonly traceId: string;
}

/**
 * Результат публикации.
 *
 * `accepted` означает, что событие принято шиной и передано подписчикам
 * best-effort. Это не подтверждение успешной обработки: часть подписчиков
 * могла завершиться ошибкой (`failedSubscribers`).
 */
export type EventPublishResult =
  | {
      readonly status: "accepted";
      readonly eventId: string;
      readonly matchedSubscribers: number;
      readonly failedSubscribers: number;
    }
  | { readonly status: "duplicate"; readonly eventId: string }
  | { readonly status: "invalid"; readonly errors: readonly ValidationIssue[] };
