import { describe, expect, it } from "vitest";

import {
  JsonObjectSchema,
  JsonValueSchema,
  createJsonObjectSchema,
  createJsonValueSchema,
  createPluginError,
  createSchemaValidator,
  toErrorResult,
  toSuccessResult,
  validateEventEnvelope,
  validateJsonValue,
  validateOperationEnvelope,
  validateOperationResult,
  validatePluginError,
  validateResourceDescriptor,
  validateWithSchema,
  type JsonObject,
} from "./index.ts";

describe("рекурсивный JsonValue", () => {
  it("принимает вложенные массивы и объекты", () => {
    const value = { a: [1, "x", true, null, { b: [2, 3] }] };

    expect(validateJsonValue(value).ok).toBe(true);
    expect(JsonValueSchema.$id).toMatch(/^urn:kanbaner:json-value:/);
    expect(JsonObjectSchema.$id).toMatch(/^urn:kanbaner:json-object:/);
    expect(JSON.stringify(JsonValueSchema)).toContain("$ref");
    expect(JSON.stringify(JsonValueSchema)).not.toContain('"type":"unknown"');
  });

  it("даёт уникальные $id фабрикам схем", () => {
    expect(createJsonValueSchema().$id).not.toBe(createJsonValueSchema().$id);
    expect(createJsonObjectSchema().$id).not.toBe(createJsonObjectSchema().$id);
  });

  it("отклоняет вложенный undefined с точным путём", () => {
    const result = validateJsonValue({ a: [1, { b: undefined }] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        path: "/a/1/b",
        keyword: "json-value",
      });
    }
  });

  it("отклоняет bigint, NaN, Infinity, functions и symbol", () => {
    const values: readonly unknown[] = [
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      () => 1,
      Symbol("x"),
      { nested: 1n },
      [Number.NaN],
    ];

    for (const value of values) {
      expect(validateJsonValue(value).ok).toBe(false);
    }
  });

  it("отклоняет non-plain objects", () => {
    expect(validateJsonValue(new Date()).ok).toBe(false);
    expect(validateJsonValue(new Map()).ok).toBe(false);
    expect(validateJsonValue(new Set()).ok).toBe(false);
    expect(validateJsonValue({ nested: new Date() }).ok).toBe(false);
  });

  it("отклоняет циклы без stack overflow", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    const result = validateJsonValue(cyclic);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("/self");
      expect(result.errors[0]?.message).toContain("Циклическая");
    }
  });

  it("применяет boundary-guard через validateWithSchema и createSchemaValidator", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(validateWithSchema(JsonValueSchema, cyclic).ok).toBe(false);
    expect(createSchemaValidator(JsonValueSchema).check(cyclic)).toBe(false);
    expect(createSchemaValidator(JsonValueSchema).validate(cyclic).ok).toBe(false);
  });
});

describe("JSON boundary в конвертах", () => {
  it("проверяет payload конверта операции", () => {
    const valid = validateOperationEnvelope({
      contractVersion: 1,
      requestId: "01K-request",
      operationId: "kanbaner.tasks.create",
      operationVersion: 1,
      source: { type: "http" },
      payload: { title: "ok" },
    });
    const invalid = validateOperationEnvelope({
      contractVersion: 1,
      requestId: "01K-request",
      operationId: "kanbaner.tasks.create",
      operationVersion: 1,
      source: { type: "http" },
      payload: { nested: [undefined] },
    });

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors[0]?.path).toBe("/payload/nested/0");
    }
  });

  it("проверяет payload события", () => {
    const result = validateEventEnvelope({
      eventId: "01K-event",
      type: "kanbaner.tasks.task.updated",
      contractVersion: 1,
      source: "kanbaner.tasks",
      occurredAt: "2026-11-06T12:00:00Z",
      resource: "kanbaner.tasks:task:01J",
      payload: { changed: new Map() },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("/payload/changed");
    }
  });

  it("проверяет data успешного результата", () => {
    const result = validateOperationResult(toSuccessResult({ nested: { bad: undefined } }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("/data/nested/bad");
    }
  });

  it("проверяет details ошибки", () => {
    const details = { bad: () => 1 } as unknown as JsonObject;
    const pluginError = createPluginError("INTERNAL_ERROR", "Сбой", { details });
    const direct = validatePluginError(pluginError);
    const wrapped = validateOperationResult(toErrorResult(pluginError));

    expect(direct.ok).toBe(false);
    expect(wrapped.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.errors[0]?.path).toBe("/details/bad");
    }
    if (!wrapped.ok) {
      expect(wrapped.errors[0]?.path).toBe("/error/details/bad");
    }
  });

  it("проверяет metadata ресурса", () => {
    const result = validateResourceDescriptor({
      ref: "kanbaner.tasks:task:01J",
      resourceType: "task",
      title: "Задача",
      metadata: { nested: new Date() },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("/metadata/nested");
    }
  });

  it("безопасно отклоняет циклический payload без исключения", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    const result = validateOperationEnvelope({
      contractVersion: 1,
      requestId: "01K-request",
      operationId: "kanbaner.tasks.create",
      operationVersion: 1,
      source: { type: "http" },
      payload: cyclic,
    });

    expect(result.ok).toBe(false);
  });
});
