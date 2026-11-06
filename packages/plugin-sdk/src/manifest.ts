import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";
import { ContractIdSchema, HostApiRangeSchema, PluginIdSchema, SemVerSchema } from "./plugin-id.ts";

/**
 * Точки входа плагина. Обязательна хотя бы одна из них.
 *
 * Манифест описывает метаданные, а не загружает код: пути проверяются
 * загрузчиком плагинов, а SDK фиксирует только форму контракта.
 */
export const PluginEntrypointsSchema = Type.Object(
  {
    server: Type.Optional(Type.String({ minLength: 1 })),
    client: Type.Optional(Type.String({ minLength: 1 })),
  },
  {
    ...DRAFT_2020_12,
    minProperties: 1,
    additionalProperties: false,
  },
);

export type PluginEntrypoints = Static<typeof PluginEntrypointsSchema>;

/**
 * Манифест плагина Plugin Contract v1.
 *
 * `migrations` необязателен: он нужен только плагинам, которые владеют
 * сохраняемыми данными. Остальные поля обязательны и могут быть пустыми
 * коллекциями.
 */
export const PluginManifestSchema = Type.Object(
  {
    id: PluginIdSchema,
    name: Type.String({ minLength: 1 }),
    version: SemVerSchema,
    hostApi: HostApiRangeSchema,
    entrypoints: PluginEntrypointsSchema,
    requires: Type.Record(PluginIdSchema, HostApiRangeSchema, {
      additionalProperties: false,
    }),
    consumes: Type.Array(ContractIdSchema, { uniqueItems: true }),
    provides: Type.Array(ContractIdSchema, { uniqueItems: true }),
    permissions: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    migrations: Type.Optional(Type.String({ minLength: 1 })),
  },
  DRAFT_2020_12,
);

export type PluginManifest = Static<typeof PluginManifestSchema>;
