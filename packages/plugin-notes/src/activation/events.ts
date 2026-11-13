import {
  type EventEnvelope,
  type ExecutionContext,
  type JsonObject,
  type PluginLogger,
  type ResourceRef,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import {
  NOTES_CONTRACT_VERSION,
  NOTES_EVENT_TYPES,
  NOTES_PLUGIN_ID,
  type NotesEventType,
} from "../constants.ts";
import type { Note } from "../model.ts";
import { formatNoteRef } from "../resources.ts";

/** Параметры построения события домена заметок. */
export interface DomainEventInput {
  readonly eventId?: string;
  readonly type: NotesEventType;
  readonly resource: ResourceRef;
  readonly resourceVersion: number;
  readonly payload: JsonObject;
  readonly occurredAt?: UtcTimestamp;
}

/** Дескриптор удалённой заметки без содержимого. */
export interface DeletedNoteDescriptor {
  readonly id: string;
  readonly parentId: string | null;
  readonly version: number;
  readonly eventVersion: number;
}

function newEventId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Собирает конверт события домена заметок.
 *
 * `resourceVersion` — версия новой сущности; для delete — `version + 1`, а не
 * последняя сохранённая версия.
 */
export function domainEvent(input: DomainEventInput): EventEnvelope {
  return {
    eventId: input.eventId ?? newEventId(),
    type: input.type,
    contractVersion: NOTES_CONTRACT_VERSION,
    source: NOTES_PLUGIN_ID,
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

export function noteCreatedEvent(note: Note, eventId: string): EventEnvelope {
  return domainEvent({
    eventId,
    type: NOTES_EVENT_TYPES.created,
    resource: formatNoteRef(note.id),
    resourceVersion: note.version,
    occurredAt: note.updatedAt,
    payload: eventPayload({
      noteId: note.id,
      version: note.version,
      parentId: note.parentId,
      position: note.position,
      title: note.title,
    }),
  });
}

export function noteUpdatedEvent(
  note: Note,
  changed: readonly string[],
  eventId: string,
): EventEnvelope {
  return domainEvent({
    eventId,
    type: NOTES_EVENT_TYPES.updated,
    resource: formatNoteRef(note.id),
    resourceVersion: note.version,
    occurredAt: note.updatedAt,
    payload: eventPayload({
      noteId: note.id,
      version: note.version,
      parentId: note.parentId,
      position: note.position,
      changed: [...changed],
    }),
  });
}

export function noteMovedEvent(
  note: Note,
  from: { readonly parentId: string | null; readonly position: number },
  eventId: string,
): EventEnvelope {
  return domainEvent({
    eventId,
    type: NOTES_EVENT_TYPES.moved,
    resource: formatNoteRef(note.id),
    resourceVersion: note.version,
    occurredAt: note.updatedAt,
    payload: eventPayload({
      noteId: note.id,
      version: note.version,
      fromParentId: from.parentId,
      toParentId: note.parentId,
      fromPosition: from.position,
      toPosition: note.position,
    }),
  });
}

export function noteDeletedEvent(
  descriptor: DeletedNoteDescriptor,
  deletedNotes: readonly DeletedNoteDescriptor[],
): EventEnvelope {
  return domainEvent({
    type: NOTES_EVENT_TYPES.deleted,
    resource: formatNoteRef(descriptor.id),
    resourceVersion: descriptor.eventVersion,
    payload: eventPayload({
      noteId: descriptor.id,
      version: descriptor.version,
      eventVersion: descriptor.eventVersion,
      deletedNotes: [...deletedNotes],
    }),
  });
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
        logger.warn("notes.event_rejected", {
          eventId: event.eventId,
          eventType: event.type,
        });
      }
    } catch (error) {
      logger.warn("notes.event_publish_failed", {
        eventId: event.eventId,
        eventType: event.type,
        errorName: safeErrorName(error),
      });
    }
  }
}
