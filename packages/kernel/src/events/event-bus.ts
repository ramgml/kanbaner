import {
  isEventSubscription,
  isEventType,
  isPluginId,
  matchesEventSubscription,
  validateEventEnvelope,
  type EventEnvelope,
  type EventSubscription,
  type PluginId,
  type PluginLogger,
  type ValidationIssue,
} from "@kanbaner/plugin-sdk";

/** Обработчик доменного события. */
export type EventHandler = (
  envelope: EventEnvelope,
  context: EventDeliveryContext,
) => void | Promise<void>;

/** Безопасный контекст доставки, не содержащий payload события. */
export interface EventDeliveryContext {
  readonly traceId: string;
}

/** Параметры подписки. `pluginId` используется только для диагностики. */
export interface EventSubscriptionOptions {
  readonly pluginId: PluginId;
}

/** Идемпотентная отмена подписки; возвращает `true`, если подписка была удалена. */
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

/** Настройки шины событий. */
export interface EventBusOptions {
  /** Структурный логгер ядра; обязателен, чтобы ошибки не терялись молча. */
  readonly logger: PluginLogger;
  /**
   * Верхняя граница in-memory dedupe по `eventId`.
   *
   * Значение по умолчанию — 10 000. При переполнении самые старые
   * идентификаторы забываются.
   */
  readonly maxTrackedEventIds?: number;
}

/**
 * Шина доменных событий ядра.
 *
 * Гарантии намеренно ограничены:
 * - публикация выполняется только явным вызовом `publishAfterCommit`;
 * - транзакционной семантики нет: вызов должен делать runtime после коммита;
 * - доставка асинхронная и best-effort, без гарантии порядка;
 * - ошибка подписчика изолируется и журналируется, но не откатывает источник;
 * - повторный `eventId` в пределах процесса отбрасывается in-memory dedupe.
 *
 * Dedupe не является exactly-once: он живёт в памяти процесса, ограничен по
 * размеру и теряется при перезапуске. Подписчики обязаны оставаться
 * идемпотентными.
 */
export class EventBus {
  readonly #logger: PluginLogger;
  readonly #maxTrackedEventIds: number;
  readonly #subscriptions = new Set<SubscriptionRecord>();
  readonly #seenEventIds = new Set<string>();

  constructor(options: EventBusOptions) {
    const maxTrackedEventIds = options.maxTrackedEventIds ?? 10_000;

    if (!Number.isInteger(maxTrackedEventIds) || maxTrackedEventIds < 1) {
      throw new TypeError("maxTrackedEventIds должен быть положительным целым числом");
    }

    this.#logger = options.logger;
    this.#maxTrackedEventIds = maxTrackedEventIds;
  }

  /**
   * Подписывает плагин на точный тип события или wildcard в конце сегментов.
   *
   * Неизвестный точный тип допустим по контракту: подписка активируется без
   * ошибки и просто не получает событий, пока такой тип не появится.
   */
  subscribe(
    type: EventSubscription,
    handler: EventHandler,
    options: EventSubscriptionOptions,
  ): EventUnsubscribe {
    if (!isEventSubscription(type)) {
      throw new TypeError(
        "Некорректная подписка: допустим точный тип события или wildcard в конце сегментов",
      );
    }

    if (!isPluginId(options.pluginId)) {
      throw new TypeError("Некорректный plugin ID подписки");
    }

    if (typeof handler !== "function") {
      throw new TypeError("Обработчик события должен быть функцией");
    }

    const record: SubscriptionRecord = {
      type,
      pluginId: options.pluginId,
      handler,
    };

    this.#subscriptions.add(record);

    return () => this.#subscriptions.delete(record);
  }

  /**
   * Публикует событие после успешного коммита источника.
   *
   * Метод не открывает транзакцию, не ожидает коммита и не откатывает
   * источник. Вызывающая сторона обязана вызвать его только после того, как
   * изменение действительно зафиксировано.
   */
  async publishAfterCommit(
    envelope: EventEnvelope,
    options: EventPublishOptions,
  ): Promise<EventPublishResult> {
    if (typeof options.traceId !== "string" || options.traceId.trim().length === 0) {
      throw new TypeError("traceId обязателен для публикации события");
    }

    const validation = validateEventEnvelope(envelope);

    if (!validation.ok) {
      this.#logInvalidEnvelope(envelope, options.traceId, validation.errors.length);

      return { status: "invalid", errors: validation.errors };
    }

    const event = validation.value;

    if (!this.#markSeen(event.eventId)) {
      this.#logger.debug("event.duplicate_ignored", {
        eventId: event.eventId,
        eventType: event.type,
        traceId: options.traceId,
      });

      return { status: "duplicate", eventId: event.eventId };
    }

    const subscribers = [...this.#subscriptions].filter((subscription) =>
      matchesEventSubscription(subscription.type, event.type),
    );

    const context: EventDeliveryContext = { traceId: options.traceId };
    let failedSubscribers = 0;

    await Promise.all(
      subscribers.map(async (subscription) => {
        try {
          await subscription.handler(event, context);
        } catch (error) {
          failedSubscribers += 1;
          this.#logger.error("event.subscriber_failed", {
            eventId: event.eventId,
            eventType: event.type,
            pluginId: subscription.pluginId,
            traceId: options.traceId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }),
    );

    return {
      status: "accepted",
      eventId: event.eventId,
      matchedSubscribers: subscribers.length,
      failedSubscribers,
    };
  }

  /** Удаляет все подписки и in-memory историю eventId. */
  dispose(): void {
    this.#subscriptions.clear();
    this.#seenEventIds.clear();
  }

  #markSeen(eventId: string): boolean {
    if (this.#seenEventIds.has(eventId)) {
      return false;
    }

    while (this.#seenEventIds.size >= this.#maxTrackedEventIds) {
      const oldest = this.#seenEventIds.values().next().value as string | undefined;

      if (oldest === undefined) {
        break;
      }

      this.#seenEventIds.delete(oldest);
    }

    this.#seenEventIds.add(eventId);

    return true;
  }

  #logInvalidEnvelope(envelope: unknown, traceId: string, issueCount: number): void {
    const fields: Record<string, unknown> = { traceId, issueCount };

    if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
      const candidate = envelope as Record<string, unknown>;

      if (typeof candidate.eventId === "string" && candidate.eventId.length > 0) {
        fields.eventId = candidate.eventId;
      }

      if (isEventType(candidate.type)) {
        fields.eventType = candidate.type;
      }
    }

    this.#logger.warn("event.envelope_invalid", fields);
  }
}

interface SubscriptionRecord {
  readonly type: EventSubscription;
  readonly pluginId: PluginId;
  readonly handler: EventHandler;
}
