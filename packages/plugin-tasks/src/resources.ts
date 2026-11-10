import {
  formatResourceRef,
  parseResourceRef,
  type ResourceRef,
  type ResourceRefParts,
} from "@kanbaner/plugin-sdk";

import {
  COLUMN_RESOURCE_TYPE,
  PLUGIN_ID,
  PROJECT_RESOURCE_TYPE,
  TASK_RESOURCE_TYPE,
} from "./constants.ts";

/** Тип ресурса задач. */
export type TasksResourceKind =
  typeof PROJECT_RESOURCE_TYPE | typeof TASK_RESOURCE_TYPE | typeof COLUMN_RESOURCE_TYPE;

/** Разобранная ссылка на ресурс домена задач. */
export interface ParsedTasksResourceRef {
  readonly kind: TasksResourceKind;
  readonly id: string;
}

function assertOwnParts(parts: ResourceRefParts): void {
  if (parts.pluginId !== PLUGIN_ID) {
    throw new TypeError("ResourceRef принадлежит другому плагину");
  }
}

function tryParse(value: unknown): ResourceRefParts | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return parseResourceRef(value);
  } catch {
    return null;
  }
}

/** Собирает ResourceRef проекта. */
export function formatProjectRef(id: string): ResourceRef {
  return formatResourceRef({
    pluginId: PLUGIN_ID,
    resourceType: PROJECT_RESOURCE_TYPE,
    opaqueId: id,
  });
}

/** Собирает ResourceRef задачи. */
export function formatTaskRef(id: string): ResourceRef {
  return formatResourceRef({
    pluginId: PLUGIN_ID,
    resourceType: TASK_RESOURCE_TYPE,
    opaqueId: id,
  });
}

/** Собирает ResourceRef колонки. */
export function formatColumnRef(id: string): ResourceRef {
  return formatResourceRef({
    pluginId: PLUGIN_ID,
    resourceType: COLUMN_RESOURCE_TYPE,
    opaqueId: id,
  });
}

/** Разбирает ResourceRef проекта и проверяет владельца. */
export function parseProjectRef(ref: ResourceRef): string {
  const parts = parseResourceRef(ref);

  assertOwnParts(parts);

  if (parts.resourceType !== PROJECT_RESOURCE_TYPE) {
    throw new TypeError("ResourceRef не является проектом задач");
  }

  return parts.opaqueId;
}

/** Разбирает ResourceRef задачи и проверяет владельца. */
export function parseTaskRef(ref: ResourceRef): string {
  const parts = parseResourceRef(ref);

  assertOwnParts(parts);

  if (parts.resourceType !== TASK_RESOURCE_TYPE) {
    throw new TypeError("ResourceRef не является задачей");
  }

  return parts.opaqueId;
}

/** Проверяет, что строка — ResourceRef проекта задач. */
export function isProjectRef(value: unknown): value is ResourceRef {
  const parts = tryParse(value);

  return (
    parts !== null && parts.pluginId === PLUGIN_ID && parts.resourceType === PROJECT_RESOURCE_TYPE
  );
}

/** Проверяет, что строка — ResourceRef задачи. */
export function isTaskRef(value: unknown): value is ResourceRef {
  const parts = tryParse(value);

  return (
    parts !== null && parts.pluginId === PLUGIN_ID && parts.resourceType === TASK_RESOURCE_TYPE
  );
}

/** Разбирает любой ресурс домена задач. */
export function parseTasksResourceRef(ref: ResourceRef): ParsedTasksResourceRef {
  const parts = parseResourceRef(ref);

  assertOwnParts(parts);

  if (
    parts.resourceType === PROJECT_RESOURCE_TYPE ||
    parts.resourceType === TASK_RESOURCE_TYPE ||
    parts.resourceType === COLUMN_RESOURCE_TYPE
  ) {
    return { kind: parts.resourceType, id: parts.opaqueId };
  }

  throw new TypeError("ResourceRef не является ресурсом домена задач");
}

/** Разбирает ResourceRef без исключения; чужой ресурс даёт null. */
export function tryParseTasksResourceRef(value: unknown): ParsedTasksResourceRef | null {
  const parts = tryParse(value);

  if (
    parts === null ||
    parts.pluginId !== PLUGIN_ID ||
    (parts.resourceType !== PROJECT_RESOURCE_TYPE &&
      parts.resourceType !== TASK_RESOURCE_TYPE &&
      parts.resourceType !== COLUMN_RESOURCE_TYPE)
  ) {
    return null;
  }

  return { kind: parts.resourceType, id: parts.opaqueId };
}
