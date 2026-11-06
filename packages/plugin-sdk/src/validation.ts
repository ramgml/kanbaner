import type { TSchema } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

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
} from "./plugin-id.ts";
import {
  ResourceDescriptorSchema,
  ResourceLinkSchema,
  ResourceRefSchema,
  type ResourceDescriptor,
  type ResourceLink,
  type ResourceRef,
} from "./resources.ts";
import { OperationResultSchema, type OperationResult } from "./results.ts";
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

function compileSchema(schema: TSchema): ValidateFunction {
  const cached = validatorCache.get(schema);

  if (cached !== undefined) {
    return cached;
  }

  // Отдельный экземпляр на схему изолирует `$id` разных плагинов друг от друга.
  const compiled = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile(schema);

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

/** Валидирует значение по произвольной TypeBox/JSON Schema-схеме. */
export function validateWithSchema<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  const validate = compileSchema(schema);

  if (validate(value)) {
    return { ok: true, value: value as T };
  }

  return { ok: false, errors: issuesFrom(validate) };
}

/** Создаёт переиспользуемый публичный валидатор для схемы. */
export function createSchemaValidator<T = unknown>(schema: TSchema): JsonSchemaValidator<T> {
  const validate = compileSchema(schema);

  return {
    check(value: unknown): value is T {
      return validate(value);
    },
    validate(value: unknown): ValidationResult<T> {
      if (validate(value)) {
        return { ok: true, value: value as T };
      }

      return { ok: false, errors: issuesFrom(validate) };
    },
  };
}

export function validatePluginId(value: unknown): ValidationResult<string> {
  return validateWithSchema<string>(PluginIdSchema, value);
}

export function validateSemVer(value: unknown): ValidationResult<string> {
  return validateWithSchema<string>(SemVerSchema, value);
}

export function validateHostApiRange(value: unknown): ValidationResult<string> {
  return validateWithSchema<string>(HostApiRangeSchema, value);
}

export function validateOperationId(value: unknown): ValidationResult<string> {
  return validateWithSchema<string>(OperationIdSchema, value);
}

export function validatePluginManifest(value: unknown): ValidationResult<PluginManifest> {
  return validateWithSchema<PluginManifest>(PluginManifestSchema, value);
}

export function validateCommandMetadata(value: unknown): ValidationResult<CommandMetadata> {
  return validateWithSchema<CommandMetadata>(CommandMetadataSchema, value);
}

export function validateQueryMetadata(value: unknown): ValidationResult<QueryMetadata> {
  return validateWithSchema<QueryMetadata>(QueryMetadataSchema, value);
}

export function validateOperationMetadata(value: unknown): ValidationResult<OperationMetadata> {
  return validateWithSchema<OperationMetadata>(OperationMetadataSchema, value);
}

export function validateOperationEnvelope(value: unknown): ValidationResult<OperationEnvelope> {
  return validateWithSchema<OperationEnvelope>(OperationEnvelopeSchema, value);
}

export function validateEventEnvelope(value: unknown): ValidationResult<EventEnvelope> {
  return validateWithSchema<EventEnvelope>(EventEnvelopeSchema, value);
}

export function validateEventType(value: unknown): ValidationResult<string> {
  return validateWithSchema<string>(EventTypeSchema, value);
}

export function validateEventSubscription(value: unknown): ValidationResult<string> {
  return validateWithSchema<string>(EventSubscriptionSchema, value);
}

export function validateResourceRef(value: unknown): ValidationResult<ResourceRef> {
  return validateWithSchema<ResourceRef>(ResourceRefSchema, value);
}

export function validateRelation(value: unknown): ValidationResult<string> {
  return validateWithSchema<string>(RelationSchema, value);
}

export function validateResourceLink(value: unknown): ValidationResult<ResourceLink> {
  return validateWithSchema<ResourceLink>(ResourceLinkSchema, value);
}

export function validateResourceDescriptor(value: unknown): ValidationResult<ResourceDescriptor> {
  return validateWithSchema<ResourceDescriptor>(ResourceDescriptorSchema, value);
}

export function validateUiContribution(value: unknown): ValidationResult<UiContribution> {
  return validateWithSchema<UiContribution>(UiContributionSchema, value);
}

export function validateJsonValue(value: unknown): ValidationResult<JsonValue> {
  return validateWithSchema<JsonValue>(JsonValueSchema, value);
}

export function validatePluginError(value: unknown): ValidationResult<PluginError> {
  return validateWithSchema<PluginError>(PluginErrorSchema, value);
}

export function validateOperationResult<T = unknown>(
  value: unknown,
): ValidationResult<OperationResult<T>> {
  return validateWithSchema<OperationResult<T>>(OperationResultSchema, value);
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
