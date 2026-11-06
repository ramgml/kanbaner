import { Type } from "@sinclair/typebox";

/**
 * UTC timestamp в формате RFC 3339 с обязательным `Z`.
 *
 * Контракт хранит время в UTC. Локальные смещения и `Date.toString()`
 * не принимаются, чтобы не терять зону при сериализации.
 */
export const UTC_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$";

export const UtcTimestampSchema = Type.String({
  minLength: 20,
  pattern: UTC_TIMESTAMP_PATTERN,
});
