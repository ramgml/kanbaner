import {
  type EventEnvelope,
  type ExecutionContext,
  type JsonObject,
  type PluginLogger,
  type ResourceRef,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, TASKS_CONTRACT_VERSION, type TasksEventType } from "../constants.ts";

/** Параметры построения события домена задач. */
export interface DomainEventInput {
  readonly eventId?: string;
  readonly type: TasksEventType;
  readonly resource: ResourceRef;
  readonly resourceVersion: number;
  readonly payload: JsonObject;
  readonly occurredAt?: UtcTimestamp;
}

function newEventId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Собирает конверт события домена задач.
 *
 * `resourceVersion` — версия новой сущности; для delete — `eventVersion` из
 * Store (`version + 1`), а не последняя сохранённая версия.
 */
export function domainEvent(input: DomainEventInput): EventEnvelope {
  return {
    eventId: input.eventId ?? newEventId(),
    type: input.type,
    contractVersion: TASKS_CONTRACT_VERSION,
    source: PLUGIN_ID,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    resource: input.resource,
    resourceVersion: input.resourceVersion,
    payload: input.payload,
  };
}

/** Приводит доменный payload к JSON-объекту без потери структуры. */
export function eventPayload(value: object): JsonObject {
  return value as unknown as JsonObject;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
}

/**
 * Публикует события после коммита.
 *
 * Доставка best-effort: ошибка шины или невалидный конверт логируются и не
 * превращают уже зафиксированный результат команды в ошибку.
 */
export async function publishDomainEvents(
  executionContext: ExecutionContext,
  events: readonly EventEnvelope[],
  logger: PluginLogger,
): Promise<void> {
  for (const event of events) {
    try {
      const result = await executionContext.events.publishAfterCommit(event, {
        traceId: executionContext.traceId,
      });

      if (result.status === "invalid") {
        logger.warn("tasks.event_rejected", {
          eventId: event.eventId,
          eventType: event.type,
        });
      }
    } catch (error) {
      logger.warn("tasks.event_publish_failed", {
        eventId: event.eventId,
        eventType: event.type,
        errorName: safeErrorName(error),
      });
    }
  }
}
