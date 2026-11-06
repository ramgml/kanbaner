import { Type } from "@sinclair/typebox";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  JsonObjectSchema,
  OperationEnvelopeSchema,
  createJsonObjectSchema,
  createResultSchema,
  createResultValidator,
  createSchemaValidator,
  isSuccessResult,
  validateCommandMetadata,
  validateOperationInput,
  validateOperationMetadata,
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

describe("boundary-guard на всех публичных входах", () => {
  const queryMetadata: QueryMetadata = {
    id: "kanbaner.tasks.list",
    contract: "kanbaner.tasks.queries.v1",
    version: 1,
    kind: "query",
    risk: "read",
    inputSchema: Type.Object({}),
    outputSchema,
  };

  function commandWithSchema(
    field: "inputSchema" | "outputSchema",
    schema: unknown,
  ): CommandMetadata {
    return { ...command, [field]: schema } as unknown as CommandMetadata;
  }

  function queryWithSchema(field: "inputSchema" | "outputSchema", schema: unknown): QueryMetadata {
    return { ...queryMetadata, [field]: schema } as unknown as QueryMetadata;
  }

  it("ловит Date, Map и циклы в inputSchema/outputSchema всех metadata-валидаторов", () => {
    const cyclicSchema: Record<string, unknown> = { type: "object", properties: {} };
    cyclicSchema.self = cyclicSchema;
    const badSchemas = [
      { name: "Date", schema: { type: "object", properties: { when: new Date() } } },
      { name: "Map", schema: { type: "object", properties: { map: new Map() } } },
      { name: "cycle", schema: cyclicSchema },
    ];

    for (const { name, schema } of badSchemas) {
      for (const field of ["inputSchema", "outputSchema"] as const) {
        const commandValue = commandWithSchema(field, schema);
        const queryValue = queryWithSchema(field, schema);
        const run = () => [
          validateCommandMetadata(commandValue),
          validateQueryMetadata(queryValue),
          validateOperationMetadata(commandValue),
          validateOperationMetadata(queryValue),
        ];

        expect(run).not.toThrow();

        for (const result of run()) {
          expect(result.ok, `${name}:${field}`).toBe(false);
          if (!result.ok) {
            expect(
              result.errors.some(
                (issue) => issue.path.startsWith(`/${field}`) && issue.keyword === "json-value",
              ),
              `${name}:${field}: ${JSON.stringify(result.errors)}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("generic и schema-validator не обходят guard", () => {
    const cyclicPayload: Record<string, unknown> = { a: 1 };
    cyclicPayload.self = cyclicPayload;
    const cyclicResult = { ok: true, data: cyclicPayload };
    const result = validateWithSchema(createResultSchema(JsonObjectSchema), cyclicResult);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("/data/self");
    }

    const validator = createSchemaValidator(OperationEnvelopeSchema);
    const envelope = (payload: unknown) => ({
      contractVersion: 1,
      requestId: "01K-request",
      operationId: "kanbaner.tasks.create",
      operationVersion: 1,
      source: { type: "http" },
      payload,
    });

    for (const value of [envelope(cyclicPayload), envelope(new Map()), envelope(new Date())]) {
      expect(validator.check(value)).toBe(false);

      const validated = validator.validate(value);

      expect(validated.ok).toBe(false);
      if (!validated.ok) {
        expect(validated.errors[0]?.keyword).toBe("json-value");
      }
    }
  });

  it("принимает повторно используемые, но не циклические объекты и валидные envelopes", () => {
    const shared = { a: 1 };
    const sharedSchema = { type: "string", minLength: 1 };
    const commandValue = commandWithSchema("inputSchema", {
      type: "object",
      properties: { a: sharedSchema, b: sharedSchema },
      required: ["a", "b"],
      additionalProperties: false,
    });

    expect(
      validateWithSchema(createResultSchema(JsonObjectSchema), {
        ok: true,
        data: { left: shared, right: shared },
      }).ok,
    ).toBe(true);

    const metadata = validateCommandMetadata(commandValue);

    expect(metadata.ok).toBe(true);
    if (metadata.ok) {
      expect(validateOperationMetadata(metadata.value).ok).toBe(true);
    }

    const envelope = {
      contractVersion: 1,
      requestId: "01K-request",
      operationId: "kanbaner.tasks.create",
      operationVersion: 1,
      source: { type: "http" },
      payload: { left: shared, right: shared },
    };
    const validator = createSchemaValidator(OperationEnvelopeSchema);

    expect(validator.check(envelope)).toBe(true);
    expect(validator.validate(envelope).ok).toBe(true);
  });
});
