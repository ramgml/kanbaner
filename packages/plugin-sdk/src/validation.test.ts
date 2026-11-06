import { Type } from "@sinclair/typebox";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  JsonObjectSchema,
  createJsonObjectSchema,
  createResultSchema,
  createResultValidator,
  createSchemaValidator,
  isSuccessResult,
  validateCommandMetadata,
  validateOperationInput,
  validateQueryMetadata,
  validateWithSchema,
  type CommandMetadata,
  type JsonSchemaValidator,
  type QueryMetadata,
  type ValidationResult,
} from "./index.ts";

const outputSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
});

const command: CommandMetadata = {
  id: "kanbaner.tasks.create",
  contract: "kanbaner.tasks.commands.v1",
  version: 1,
  kind: "mutation",
  risk: "write",
  idempotency: "supported",
  inputSchema: Type.Object({
    at: Type.String({ format: "date-time" }),
  }),
  outputSchema,
};

describe("ajv-formats и Draft 2020-12 metadata", () => {
  it("компилирует и валидирует date-time без unknown format", () => {
    const metadata = validateCommandMetadata(command);

    expect(metadata.ok).toBe(true);
    expect(validateOperationInput(command, { at: "2026-11-06T12:00:00Z" }).ok).toBe(true);

    const invalid = validateOperationInput(command, { at: "2026-02-31T12:00:00Z" });

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.some((issue) => issue.path === "/at")).toBe(true);
    }
  });

  it("возвращает issue для неверного type во inputSchema", () => {
    const result = validateCommandMetadata({
      ...command,
      inputSchema: { type: "objectt" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((issue) => issue.path.startsWith("/inputSchema"))).toBe(true);
    }
  });

  it("возвращает issue для неверного properties", () => {
    const result = validateCommandMetadata({
      ...command,
      inputSchema: { type: "object", properties: 42 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((issue) => issue.path === "/inputSchema/properties")).toBe(true);
    }
  });

  it("возвращает issue для отсутствующего $ref", () => {
    const query: QueryMetadata = {
      id: "kanbaner.tasks.list",
      contract: "kanbaner.tasks.queries.v1",
      version: 1,
      kind: "query",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: { id: { $ref: "#/$defs/missing" } },
      },
      outputSchema,
    };
    const result = validateQueryMetadata(query);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((issue) => issue.path === "/inputSchema" && issue.keyword === "compile"),
      ).toBe(true);
    }
  });

  it("проверяет outputSchema и не ломает self-contained $ref", () => {
    const selfContained = {
      $defs: {
        id: { type: "string", minLength: 1 },
      },
      type: "object",
      properties: { id: { $ref: "#/$defs/id" } },
      required: ["id"],
      additionalProperties: false,
    };
    const valid = validateCommandMetadata({
      ...command,
      inputSchema: selfContained,
      outputSchema: { type: "object", properties: 42 },
    });
    const selfContainedValid = validateCommandMetadata({
      ...command,
      inputSchema: selfContained,
      outputSchema: selfContained,
    });

    expect(valid.ok).toBe(false);
    if (!valid.ok) {
      expect(valid.errors.some((issue) => issue.path === "/outputSchema/properties")).toBe(true);
    }
    expect(selfContainedValid.ok).toBe(true);
    if (selfContainedValid.ok) {
      expect(validateOperationInput(selfContainedValid.value, { id: "01J" }).ok).toBe(true);
      expect(validateOperationInput(selfContainedValid.value, { id: "" }).ok).toBe(false);
    }
  });
});

describe("schema-aware generics", () => {
  it("выводит Static<S> из validateWithSchema и createSchemaValidator", () => {
    const schema = Type.Object({ id: Type.String() });
    const result = validateWithSchema(schema, { id: "01J" });
    const validator = createSchemaValidator(schema);

    expect(result.ok).toBe(true);
    expect(validator.check({ id: "01J" })).toBe(true);
    expectTypeOf(result).toEqualTypeOf<ValidationResult<{ id: string }>>();
    expectTypeOf(validator).toEqualTypeOf<JsonSchemaValidator<{ id: string }>>();
  });

  it("валидирует результат через createResultSchema по типу data.id", () => {
    const dataSchema = Type.Object({ id: Type.String() });
    const resultSchema = createResultSchema(dataSchema);
    const valid = validateWithSchema(resultSchema, { ok: true, data: { id: "01J" } });
    const invalid = validateWithSchema(resultSchema, { ok: true, data: { id: 42 } });

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.some((issue) => issue.path === "/data/id")).toBe(true);
    }
  });

  it("создаёт типизированный валидатор результата", () => {
    const dataSchema = Type.Object({ id: Type.String() });
    const validator = createResultValidator(dataSchema);

    expect(validator.check({ ok: true, data: { id: "01J" } })).toBe(true);
    expect(validator.validate({ ok: true, data: { id: 42 } }).ok).toBe(false);

    const success = validator.validate({ ok: true, data: { id: "01J" } });

    expect(success.ok).toBe(true);
    if (success.ok && isSuccessResult(success.value)) {
      expectTypeOf(success.value.data.id).toEqualTypeOf<string>();
    }
  });

  it("не создаёт конфликт $id при вложении success/error веток", () => {
    const constantValidator = createResultValidator(JsonObjectSchema);
    const factoryValidator = createResultValidator(createJsonObjectSchema());

    for (const validator of [constantValidator, factoryValidator]) {
      expect(validator.check({ ok: true, data: { a: 1 } })).toBe(true);
      expect(
        validator.check({
          ok: false,
          error: { code: "NOT_FOUND", message: "Нет", retryable: false, details: { a: 1 } },
        }),
      ).toBe(true);

      expect(validator.validate({ ok: true, data: { a: 1 } }).ok).toBe(true);
      expect(validator.validate({ ok: true, data: null }).ok).toBe(false);
      expect(validator.validate({ ok: true, data: { a: () => 1 } }).ok).toBe(false);
      expect(validator.validate({ ok: false, error: { code: "NOPE", message: "" } }).ok).toBe(
        false,
      );
    }
  });
});
