import type { Static, TSchema } from "@sinclair/typebox";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ajvFormatsModule from "ajv-formats";

// ajv-formats — CJS-пакет с ESM-декларацией; NodeNext типизирует default как namespace.
const addFormats = ajvFormatsModule.default as unknown as (ajv: Ajv2020) => unknown;

import {
  EventEnvelopeSchema,
  EventSubscriptionSchema,
  EventTypeSchema,
  type EventEnvelope,
} from "./events.ts";
import { PluginErrorSchema, type PluginError } from "./errors.ts";
import { JsonValueSchema, type JsonValue } from "./json.ts";
import { PluginManifestSchema, type PluginManifest } from "./manifest.ts";
import {
  CommandMetadataSchema,
  OperationEnvelopeSchema,
  OperationMetadataSchema,
  QueryMetadataSchema,
  type CommandMetadata,
  type OperationEnvelope,
  type OperationMetadata,
  type QueryMetadata,
} from "./operations.ts";
import {
  HostApiRangeSchema,
  OperationIdSchema,
  PluginIdSchema,
  RelationSchema,
  SemVerSchema,
  isHostApiRange,
} from "./plugin-id.ts";
import {
  ResourceDescriptorSchema,
  ResourceLinkSchema,
  ResourceRefSchema,
  type ResourceDescriptor,
  type ResourceLink,
  type ResourceRef,
} from "./resources.ts";
import { OperationResultSchema, createResultSchema, type OperationResult } from "./results.ts";
import { UtcTimestampSchema } from "./time.ts";
import { UiContributionSchema, type UiContribution } from "./ui.ts";

/** Одна ошибка JSON Schema-валидации в безопасной форме. */
export interface ValidationIssue {
  /** JSON Pointer до неверного значения; `/` для корня. */
  readonly path: string;
  /** JSON Pointer до места в схеме. */
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

/** Публичный валидатор, не раскрывающий тип Ajv. */
export interface JsonSchemaValidator<T = unknown> {
  check(value: unknown): value is T;
  validate(value: unknown): ValidationResult<T>;
}

const validatorCache = new WeakMap<TSchema, ValidateFunction>();

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
  });

  addFormats(ajv);
  ajv.addFormat("host-api-range", {
    type: "string",
    validate: (value: string) => isHostApiRange(value),
  });

  return ajv;
}

function compileSchema(schema: TSchema): ValidateFunction {
  const cached = validatorCache.get(schema);

  if (cached !== undefined) {
    return cached;
  }

  // Отдельный экземпляр на схему изолирует `$id` разных плагинов друг от друга.
  const compiled = createAjv().compile(schema);
  validatorCache.set(schema, compiled);

  return compiled;
}

function toIssue(error: ErrorObject): ValidationIssue {
  return {
    path: error.instancePath === "" ? "/" : error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "is invalid",
    params: { ...error.params },
  };
}

function issuesFrom(validate: ValidateFunction): readonly ValidationIssue[] {
  const errors = validate.errors;

  if (errors === null || errors === undefined || errors.length === 0) {
    return [
      {
        path: "/",
        schemaPath: "#",
        keyword: "invalid",
        message: "Значение не соответствует схеме",
        params: {},
      },
    ];
  }

  return errors.map(toIssue);
}

function prefixedIssue(issue: ValidationIssue, prefix: string): ValidationIssue {
  return {
    ...issue,
    path: issue.path === "/" ? prefix : `${prefix}${issue.path}`,
  };
}

function jsonIssue(
  path: string,
  message: string,
  keyword = "json-value",
  params: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    path: path === "" ? "/" : path,
    schemaPath: "#",
    keyword,
    message,
    params,
  };
}

function appendJsonPointer(path: string, segment: string | number): string {
  const escaped = String(segment).replace(/~/g, "~0").replace(/\//g, "~1");

  return `${path}/${escaped}`;
}

/**
 * Boundary-guard для JSON-значений.
 *
 * Ajv не различает отсутствие свойства и `undefined`, пропускает `NaN`,
 * `Infinity` и экземпляры классов как обычные object. Guard дополняет Ajv и
 * не даёт рекурсивной схеме уйти в stack overflow на циклических ссылках.
 */
function findJsonValueIssue(value: unknown, path = ""): ValidationIssue | null {
  const stack = new WeakSet<object>();

  const walk = (current: unknown, currentPath: string): ValidationIssue | null => {
    if (current === null) {
      return null;
    }

    switch (typeof current) {
      case "string":
      case "boolean":
        return null;
      case "number":
        return Number.isFinite(current)
          ? null
          : jsonIssue(currentPath, "JSON-число должно быть конечным");
      case "undefined":
        return jsonIssue(currentPath, "JSON-значение не может быть undefined");
      case "bigint":
        return jsonIssue(currentPath, "bigint не является JSON-значением");
      case "function":
        return jsonIssue(currentPath, "function не является JSON-значением");
      case "symbol":
        return jsonIssue(currentPath, "symbol не является JSON-значением");
      case "object":
        break;
      default:
        return jsonIssue(currentPath, "Значение не является JSON-значением");
    }

    const object = current;

    if (stack.has(object)) {
      return jsonIssue(currentPath, "Циклическая ссылка не является JSON-значением");
    }

    if (Array.isArray(object)) {
      stack.add(object);

      try {
        for (let index = 0; index < object.length; index += 1) {
          const issue = walk(object[index], appendJsonPointer(currentPath, index));

          if (issue !== null) {
            return issue;
          }
        }
      } finally {
        stack.delete(object);
      }

      return null;
    }

    const prototype = Object.getPrototypeOf(object);

    if (prototype !== Object.prototype && prototype !== null) {
      return jsonIssue(currentPath, "JSON-объект должен быть plain object");
    }

    stack.add(object);

    try {
      for (const key of Object.keys(object)) {
        const issue = walk(
          (object as Record<string, unknown>)[key],
          appendJsonPointer(currentPath, key),
        );

        if (issue !== null) {
          return issue;
        }
      }
    } finally {
      stack.delete(object);
    }

    return null;
  };

  try {
    return walk(value, path);
  } catch {
    return jsonIssue(path, "Не удалось проверить JSON-значение");
  }
}

function compileIssue(pointer: string, error: unknown): ValidationIssue {
  const missingRef =
    typeof error === "object" &&
    error !== null &&
    "missingRef" in error &&
    typeof error.missingRef === "string"
      ? error.missingRef
      : undefined;

  return {
    path: pointer,
    schemaPath: `#${pointer}`,
    keyword: "compile",
    message: error instanceof Error ? error.message : "JSON Schema не компилируется",
    params: missingRef === undefined ? {} : { missingRef },
  };
}

function schemaCompileIssues(schema: unknown, pointer: string): readonly ValidationIssue[] {
  const ajv = createAjv();

  try {
    if (!ajv.validateSchema(schema as TSchema)) {
      return (ajv.errors ?? []).map((error) => prefixedIssue(toIssue(error), pointer));
    }

    ajv.compile(schema as TSchema);
  } catch (error) {
    return [compileIssue(pointer, error)];
  }

  return [];
}

function operationSchemaIssues(metadata: OperationMetadata): readonly ValidationIssue[] {
  return [
    ...schemaCompileIssues(metadata.inputSchema, "/inputSchema"),
    ...schemaCompileIssues(metadata.outputSchema, "/outputSchema"),
  ];
}

/** Валидирует значение по произвольной TypeBox/JSON Schema-схеме. */
export function validateWithSchema<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
): ValidationResult<Static<Schema>> {
  // Все публичные схемы SDK описывают логические JSON-сообщения. Guard
  // выполняется на каждой границе, а не по маркеру корневой схемы, поэтому
  // вложенные и составные схемы не могут обойти проверку.
  const jsonIssueResult = findJsonValueIssue(value);

  if (jsonIssueResult !== null) {
    return { ok: false, errors: [jsonIssueResult] };
  }

  const validate = compileSchema(schema);

  if (validate(value)) {
    return { ok: true, value: value as Static<Schema> };
  }

  return { ok: false, errors: issuesFrom(validate) };
}

/** Создаёт переиспользуемый публичный валидатор для схемы. */
export function createSchemaValidator<Schema extends TSchema>(
  schema: Schema,
): JsonSchemaValidator<Static<Schema>> {
  const validate = compileSchema(schema);

  return {
    check(value: unknown): value is Static<Schema> {
      return findJsonValueIssue(value) === null && validate(value);
    },
    validate(value: unknown): ValidationResult<Static<Schema>> {
      const jsonIssueResult = findJsonValueIssue(value);

      if (jsonIssueResult !== null) {
        return { ok: false, errors: [jsonIssueResult] };
      }

      if (validate(value)) {
        return { ok: true, value: value as Static<Schema> };
      }

      return { ok: false, errors: issuesFrom(validate) };
    },
  };
}

export function validatePluginId(value: unknown): ValidationResult<string> {
  return validateWithSchema(PluginIdSchema, value);
}

export function validateSemVer(value: unknown): ValidationResult<string> {
  return validateWithSchema(SemVerSchema, value);
}

export function validateHostApiRange(value: unknown): ValidationResult<string> {
  return validateWithSchema(HostApiRangeSchema, value);
}

export function validateOperationId(value: unknown): ValidationResult<string> {
  return validateWithSchema(OperationIdSchema, value);
}

export function validatePluginManifest(value: unknown): ValidationResult<PluginManifest> {
  return validateWithSchema(PluginManifestSchema, value);
}

export function validateCommandMetadata(value: unknown): ValidationResult<CommandMetadata> {
  const base = validateWithSchema(CommandMetadataSchema, value);

  if (!base.ok) {
    return base;
  }

  const issues = operationSchemaIssues(base.value);

  return issues.length === 0 ? base : { ok: false, errors: issues };
}

export function validateQueryMetadata(value: unknown): ValidationResult<QueryMetadata> {
  const base = validateWithSchema(QueryMetadataSchema, value);

  if (!base.ok) {
    return base;
  }

  const issues = operationSchemaIssues(base.value);

  return issues.length === 0 ? base : { ok: false, errors: issues };
}

export function validateOperationMetadata(value: unknown): ValidationResult<OperationMetadata> {
  const base = validateWithSchema(OperationMetadataSchema, value);

  if (!base.ok) {
    return base;
  }

  return base.value.kind === "mutation"
    ? validateCommandMetadata(value)
    : validateQueryMetadata(value);
}

export function validateOperationEnvelope(value: unknown): ValidationResult<OperationEnvelope> {
  return validateWithSchema(OperationEnvelopeSchema, value);
}

export function validateEventEnvelope(value: unknown): ValidationResult<EventEnvelope> {
  return validateWithSchema(EventEnvelopeSchema, value);
}

export function validateEventType(value: unknown): ValidationResult<string> {
  return validateWithSchema(EventTypeSchema, value);
}

export function validateEventSubscription(value: unknown): ValidationResult<string> {
  return validateWithSchema(EventSubscriptionSchema, value);
}

export function validateResourceRef(value: unknown): ValidationResult<ResourceRef> {
  return validateWithSchema(ResourceRefSchema, value);
}

export function validateRelation(value: unknown): ValidationResult<string> {
  return validateWithSchema(RelationSchema, value);
}

export function validateResourceLink(value: unknown): ValidationResult<ResourceLink> {
  return validateWithSchema(ResourceLinkSchema, value);
}

export function validateResourceDescriptor(value: unknown): ValidationResult<ResourceDescriptor> {
  return validateWithSchema(ResourceDescriptorSchema, value);
}

export function validateUiContribution(value: unknown): ValidationResult<UiContribution> {
  return validateWithSchema(UiContributionSchema, value);
}

export function validateJsonValue(value: unknown): ValidationResult<JsonValue> {
  return validateWithSchema(JsonValueSchema, value);
}

export function isUtcTimestamp(value: unknown): value is string {
  return validateWithSchema(UtcTimestampSchema, value).ok;
}

export function validateUtcTimestamp(value: unknown): ValidationResult<string> {
  return validateWithSchema(UtcTimestampSchema, value);
}

export function validatePluginError(value: unknown): ValidationResult<PluginError> {
  return validateWithSchema(PluginErrorSchema, value);
}

export function validateOperationResult(value: unknown): ValidationResult<OperationResult> {
  return validateWithSchema(OperationResultSchema, value);
}

/**
 * Создаёт schema-aware валидатор результата для конкретной схемы данных.
 */
export function createResultValidator<Data extends TSchema>(
  data: Data,
): JsonSchemaValidator<OperationResult<Static<Data>>> {
  const validator = createSchemaValidator(createResultSchema(data));

  return {
    check(value: unknown): value is OperationResult<Static<Data>> {
      return validator.check(value);
    },
    validate(value: unknown): ValidationResult<OperationResult<Static<Data>>> {
      return validator.validate(value) as ValidationResult<OperationResult<Static<Data>>>;
    },
  };
}

function inputSchemaOf(metadata: OperationMetadata): TSchema {
  return metadata.inputSchema as TSchema;
}

function outputSchemaOf(metadata: OperationMetadata): TSchema {
  return metadata.outputSchema as TSchema;
}

/** Валидирует вход команды/запроса по её `inputSchema`. */
export function validateOperationInput(
  metadata: OperationMetadata,
  value: unknown,
): ValidationResult<unknown> {
  return validateWithSchema(inputSchemaOf(metadata), value);
}

/** Валидирует выход команды/запроса по её `outputSchema`. */
export function validateOperationOutput(
  metadata: OperationMetadata,
  value: unknown,
): ValidationResult<unknown> {
  return validateWithSchema(outputSchemaOf(metadata), value);
}

/** Компилирует валидатор входа операции один раз. */
export function createOperationInputValidator(
  metadata: OperationMetadata,
): JsonSchemaValidator<unknown> {
  return createSchemaValidator(inputSchemaOf(metadata));
}

/** Компилирует валидатор выхода операции один раз. */
export function createOperationOutputValidator(
  metadata: OperationMetadata,
): JsonSchemaValidator<unknown> {
  return createSchemaValidator(outputSchemaOf(metadata));
}
