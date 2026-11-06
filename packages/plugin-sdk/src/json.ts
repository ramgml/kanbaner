import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";

let jsonSchemaSequence = 0;

function nextJsonSchemaId(kind: "value" | "object"): string {
  jsonSchemaSequence += 1;
  return `urn:kanbaner:json-${kind}:${jsonSchemaSequence}`;
}

/**
 * Рекурсивная схема JSON-значения.
 *
 * Массивы и объекты проверяются вложенно через `$ref`; `Unknown` внутри нет.
 * Фабрика нужна, чтобы каждый контекст получал уникальный `$id` и одну
 * схему можно было безопасно встраивать несколько раз.
 */
export function createJsonValueSchema() {
  return Type.Recursive(
    (This) =>
      Type.Union([
        Type.String(),
        Type.Number(),
        Type.Boolean(),
        Type.Null(),
        Type.Array(This),
        Type.Record(Type.String(), This),
      ]),
    {
      ...DRAFT_2020_12,
      $id: nextJsonSchemaId("value"),
    },
  );
}

/** Рекурсивная схема JSON-объекта. */
export function createJsonObjectSchema() {
  return Type.Record(Type.String(), createJsonValueSchema(), {
    ...DRAFT_2020_12,
    $id: nextJsonSchemaId("object"),
  });
}

export const JsonValueSchema = createJsonValueSchema();

export type JsonValue = Static<typeof JsonValueSchema>;

/** JSON-объект с безопасными для журнала и передачи значениями. */
export const JsonObjectSchema = createJsonObjectSchema();

export type JsonObject = Static<typeof JsonObjectSchema>;
