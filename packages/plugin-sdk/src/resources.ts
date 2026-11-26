import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";
import { JsonObjectSchema } from "./json.ts";
import {
  PLUGIN_ID_SOURCE,
  RelationSchema,
  RESOURCE_TYPE_PATTERN,
  SEGMENT_SOURCE,
  isPluginId,
  isRelation,
  isResourceType,
  type Relation,
} from "./plugin-id.ts";
import type { OperationResult } from "./results.ts";
import { UtcTimestampSchema } from "./time.ts";

/** Стабильный тип ресурса внутри плагина, например `task`. */
export type ResourceType = string;

/**
 * Универсальная ссылка `<plugin-id>:<resource-type>:<opaque-id>`.
 *
 * `opaqueId` не интерпретируется другими плагинами и остаётся непрозрачным.
 * SDK намеренно не связывает его с ULID или другим генератором ID.
 */
export type ResourceRef = string;

export const OPAQUE_ID_PATTERN = "^[^:\\s]+$";

export const RESOURCE_REF_PATTERN = `^${PLUGIN_ID_SOURCE}:${SEGMENT_SOURCE}:[^:\\s]+$`;

export const ResourceRefSchema = Type.String({
  ...DRAFT_2020_12,
  minLength: 5,
  pattern: RESOURCE_REF_PATTERN,
});

export interface ResourceRefParts {
  readonly pluginId: string;
  readonly resourceType: ResourceType;
  readonly opaqueId: string;
}

/** Связь двух ResourceRef с namespace-ированным типом. */
export const ResourceLinkSchema = Type.Object(
  {
    sourceRef: ResourceRefSchema,
    targetRef: ResourceRefSchema,
    relation: RelationSchema,
    createdAt: Type.Optional(UtcTimestampSchema),
  },
  DRAFT_2020_12,
);

export type ResourceLink = Static<typeof ResourceLinkSchema>;

/** Метаданные ресурса, которые возвращает адаптер плагина-владельца. */
export const ResourceDescriptorSchema = Type.Object(
  {
    ref: ResourceRefSchema,
    resourceType: Type.String({ pattern: RESOURCE_TYPE_PATTERN }),
    title: Type.String({ minLength: 1 }),
    state: Type.Optional(Type.String()),
    metadata: Type.Optional(JsonObjectSchema),
  },
  DRAFT_2020_12,
);

export type ResourceDescriptor = Static<typeof ResourceDescriptorSchema>;

/** Асинхронные операции универсальных связей и открытия ресурсов. */
export interface ResourceService {
  link(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<ResourceLink>;
  unlink(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<void>;
  list(ref: ResourceRef, relation?: Relation): Promise<readonly ResourceLink[]>;
  resolve(ref: ResourceRef): Promise<OperationResult<ResourceDescriptor>>;
  canOpen(ref: ResourceRef): Promise<boolean>;
  open(ref: ResourceRef): Promise<void>;
}

const resourceRefRegex = new RegExp(RESOURCE_REF_PATTERN);
const opaqueIdRegex = new RegExp(OPAQUE_ID_PATTERN);

/** Проверяет строку как ResourceRef без разбора на части. */
export function isResourceRef(value: unknown): value is ResourceRef {
  return typeof value === "string" && resourceRefRegex.test(value);
}

/**
 * Разбирает ResourceRef на части.
 *
 * Бросает `TypeError` с безопасным сообщением при неверном формате. Для
 * проверки без исключения используйте `isResourceRef`.
 */
export function parseResourceRef(value: string): ResourceRefParts {
  if (typeof value !== "string") {
    throw new TypeError("ResourceRef должен быть строкой");
  }

  const parts = value.split(":");

  if (parts.length !== 3) {
    throw new TypeError("ResourceRef должен иметь формат <plugin-id>:<resource-type>:<opaque-id>");
  }

  const [pluginId, resourceType, opaqueId] = parts;

  if (pluginId === undefined || !isPluginId(pluginId)) {
    throw new TypeError("ResourceRef содержит неверный plugin-id");
  }

  if (resourceType === undefined || !isResourceType(resourceType)) {
    throw new TypeError("ResourceRef содержит неверный resource-type");
  }

  if (opaqueId === undefined || !opaqueIdRegex.test(opaqueId)) {
    throw new TypeError("ResourceRef содержит пустой или неверный opaque-id");
  }

  return { pluginId, resourceType, opaqueId };
}

/** Собирает ResourceRef из частей, проверяя каждую часть. */
export function formatResourceRef(parts: ResourceRefParts): ResourceRef {
  const pluginId: unknown = parts.pluginId;
  const resourceType: unknown = parts.resourceType;
  const opaqueId: unknown = parts.opaqueId;

  if (typeof pluginId !== "string" || !isPluginId(pluginId)) {
    throw new TypeError("ResourceRef содержит неверный plugin-id");
  }

  if (typeof resourceType !== "string" || !isResourceType(resourceType)) {
    throw new TypeError("ResourceRef содержит неверный resource-type");
  }

  if (typeof opaqueId !== "string" || !opaqueIdRegex.test(opaqueId)) {
    throw new TypeError("ResourceRef содержит пустой или неверный opaque-id");
  }

  return `${pluginId}:${resourceType}:${opaqueId}`;
}

/** Проверяет namespace-ированный тип связи. */
export function isNamespacedRelation(value: unknown): value is Relation {
  return isRelation(value);
}
