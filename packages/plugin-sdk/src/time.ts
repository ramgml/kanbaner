import { Type } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";

/**
 * UTC timestamp в формате RFC 3339 с обязательным `Z`.
 *
 * `date-time` из `ajv-formats` проверяет реальные календарные даты и время,
 * а pattern запрещает локальные смещения. Локальные `Date.toString()` и
 * несуществующие даты вроде `2026-02-31` не принимаются.
 */
export const UTC_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$";

export const UtcTimestampSchema = Type.String({
  ...DRAFT_2020_12,
  minLength: 20,
  format: "date-time",
  pattern: UTC_TIMESTAMP_PATTERN,
});
