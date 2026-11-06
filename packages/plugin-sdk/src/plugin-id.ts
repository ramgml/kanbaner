import { Type } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";

/**
 * Идентификатор плагина в формате `<namespace>.<plugin>`.
 *
 * Plugin ID неизменяем после публикации, глобально уникален и не зависит
 * от отображаемого названия плагина.
 */
export type PluginId = string;

/** Версия плагина в формате SemVer. */
export type PluginVersion = string;

/** SemVer-диапазон совместимого Host API. */
export type HostApiRange = string;

/** Идентификатор версионированного контракта, например `kanbaner.tasks.commands.v1`. */
export type ContractId = string;

/** Идентификатор команды или запроса в формате `<plugin-id>.<action>`. */
export type OperationId = string;

/** Namespace-ированный тип связи, например `kanbaner.notes.references`. */
export type Relation = string;

/** Сегмент идентификатора: нижний регистр, цифры и дефисы. */
export const SEGMENT_SOURCE = "[a-z][a-z0-9-]*";

/** Источник Plugin ID без якорей: ровно `<namespace>.<plugin>`. */
export const PLUGIN_ID_SOURCE = `${SEGMENT_SOURCE}\\.${SEGMENT_SOURCE}`;

export const PLUGIN_ID_PATTERN = `^${PLUGIN_ID_SOURCE}$`;

export const OPERATION_ID_PATTERN = `^${PLUGIN_ID_SOURCE}\\.${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE})*$`;

export const CONTRACT_ID_PATTERN = `^${PLUGIN_ID_SOURCE}\\.${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE})*\\.v[0-9]+$`;

export const RESOURCE_TYPE_PATTERN = `^${SEGMENT_SOURCE}$`;

export const RELATION_PATTERN = `^${SEGMENT_SOURCE}(?:\\.${SEGMENT_SOURCE})+$`;

/**
 * SemVer 2.0.0 без ослаблений: обязательные major.minor.patch, корректные
 * prerelease/build-части и запрет ведущих нулей в числовых сегментах.
 */
export const SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?" +
  "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$";

const HOST_API_RANGE_TOKEN =
  "(?:\\^|~|>=|<=|>|<|=)?\\s*" +
  "(?:0|[1-9]\\d*|[xX*])(?:\\.(?:0|[1-9]\\d*|[xX*])){0,2}" +
  "(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";

/**
 * Разумно валидный SemVer-диапазон Host API.
 *
 * Поддерживаются точные версии, `^`, `~`, comparators, `*`, `x` и
 * объединения через `||` или пробел. Полный semver-engine здесь не нужен:
 * контракт требует лишь непустой диапазон, а совместимость проверяет ядро.
 */
export const HOST_API_RANGE_PATTERN = `^\\s*${HOST_API_RANGE_TOKEN}(?:\\s*(?:\\|\\||\\s)\\s*${HOST_API_RANGE_TOKEN})*\\s*$`;

export const PluginIdSchema = Type.String({
  ...DRAFT_2020_12,
  minLength: 3,
  pattern: PLUGIN_ID_PATTERN,
});

export const SemVerSchema = Type.String({
  minLength: 5,
  pattern: SEMVER_PATTERN,
});

/** Схема версии плагина: тот же SemVer, отдельное публичное имя. */
export const PluginVersionSchema = SemVerSchema;

export const HostApiRangeSchema = Type.String({
  minLength: 1,
  pattern: HOST_API_RANGE_PATTERN,
});

export const ContractIdSchema = Type.String({
  minLength: 3,
  pattern: CONTRACT_ID_PATTERN,
});

export const OperationIdSchema = Type.String({
  minLength: 5,
  pattern: OPERATION_ID_PATTERN,
});

export const RelationSchema = Type.String({
  ...DRAFT_2020_12,
  minLength: 5,
  pattern: RELATION_PATTERN,
});

const pluginIdRegex = new RegExp(PLUGIN_ID_PATTERN);
const operationIdRegex = new RegExp(OPERATION_ID_PATTERN);
const contractIdRegex = new RegExp(CONTRACT_ID_PATTERN);
const semVerRegex = new RegExp(SEMVER_PATTERN);
const hostApiRangeRegex = new RegExp(HOST_API_RANGE_PATTERN);
const relationRegex = new RegExp(RELATION_PATTERN);
const resourceTypeRegex = new RegExp(RESOURCE_TYPE_PATTERN);

export function isPluginId(value: unknown): value is PluginId {
  return typeof value === "string" && pluginIdRegex.test(value);
}

export function isOperationId(value: unknown): value is OperationId {
  return typeof value === "string" && operationIdRegex.test(value);
}

export function isContractId(value: unknown): value is ContractId {
  return typeof value === "string" && contractIdRegex.test(value);
}

export function isSemVer(value: unknown): value is PluginVersion {
  return typeof value === "string" && semVerRegex.test(value);
}

export function isHostApiRange(value: unknown): value is HostApiRange {
  return typeof value === "string" && hostApiRangeRegex.test(value);
}

export function isRelation(value: unknown): value is Relation {
  return typeof value === "string" && relationRegex.test(value);
}

export function isResourceType(value: unknown): value is string {
  return typeof value === "string" && resourceTypeRegex.test(value);
}
