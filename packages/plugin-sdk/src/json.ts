import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";

/**
 * JSON-значение на уровне конверта.
 *
 * Глубокая рекурсивная проверка здесь не нужна: контракт требует, чтобы
 * payload и детали ошибки были JSON-совместимыми, а формы доменных данных
 * описываются собственными схемами плагинов.
 */
export const JsonValueSchema = Type.Union(
  [
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Array(Type.Unknown()),
    Type.Record(Type.String(), Type.Unknown()),
  ],
  DRAFT_2020_12,
);

export type JsonValue = Static<typeof JsonValueSchema>;

/** JSON-объект с безопасными для журнала и передачи значениями. */
export const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown(), DRAFT_2020_12);

export type JsonObject = Static<typeof JsonObjectSchema>;
