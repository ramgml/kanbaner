import { Type } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  CommandMetadataSchema,
  DEFAULT_EXPOSURE,
  ERROR_RETRYABLE,
  PLUGIN_ERROR_CODES,
  QueryMetadataSchema,
  createOperationInputValidator,
  createPluginError,
  createResultSchema,
  isErrorResult,
  isRetryableErrorCode,
  isSuccessResult,
  resolveExposure,
  toErrorResult,
  toSuccessResult,
  validateCommandMetadata,
  validateOperationEnvelope,
  validateOperationInput,
  validateOperationMetadata,
  validateOperationOutput,
  validateOperationResult,
  validateQueryMetadata,
  validateWithSchema,
  type CommandMetadata,
  type OperationResult,
  type ResolvedExposure,
} from "./index.ts";

const inputSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
});

const outputSchema = Type.Object({
  resource: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
});

const command: CommandMetadata = {
  id: "kanbaner.tasks.create",
  contract: "kanbaner.tasks.commands.v1",
  version: 1,
  kind: "mutation",
  risk: "write",
  idempotency: "supported",
  inputSchema,
  outputSchema,
  exposure: { http: true },
};

const query = {
  id: "kanbaner.tasks.list",
  contract: "kanbaner.tasks.queries.v1",
  version: 1,
  kind: "query",
  risk: "read",
  inputSchema,
  outputSchema,
} as const;

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

describe("метаданные команд и запросов", () => {
  it("принимает mutation command", () => {
    const result = validateCommandMetadata(command);

    expect(result.ok).toBe(true);
  });

  it("принимает query", () => {
    const result = validateQueryMetadata(query);

    expect(result.ok).toBe(true);
  });

  it("не смешивает mutation и query", () => {
    expect(validateCommandMetadata(query).ok).toBe(false);
    expect(
      validateQueryMetadata({
        ...query,
        id: "kanbaner.tasks.create",
        kind: "mutation",
      }).ok,
    ).toBe(false);
    expect(
      validateOperationMetadata({
        ...query,
        risk: "write",
      }).ok,
    ).toBe(false);
  });

  it("требует idempotency у команды", () => {
    expect(validateCommandMetadata(without(command, "idempotency")).ok).toBe(false);
  });

  it("требует inputSchema и outputSchema", () => {
    expect(validateCommandMetadata(without(command, "inputSchema")).ok).toBe(false);
    expect(validateCommandMetadata(without(command, "outputSchema")).ok).toBe(false);
  });

  it("отклоняет некорректный operation ID", () => {
    expect(validateCommandMetadata({ ...command, id: "kanbaner.create" }).ok).toBe(false);
    expect(validateCommandMetadata({ ...command, id: "kanbaner.tasks.Create" }).ok).toBe(false);
  });

  it("оставляет все каналы экспорта выключенными по умолчанию", () => {
    expect(DEFAULT_EXPOSURE).toEqual({ ui: false, http: false, mcp: false });
    expect(resolveExposure()).toEqual({ ui: false, http: false, mcp: false });
    expect(resolveExposure({})).toEqual({ ui: false, http: false, mcp: false });
    expect(resolveExposure({ http: true })).toEqual({ ui: false, http: true, mcp: false });
  });

  it("не включает не заданные каналы при частичном exposure", () => {
    const resolved: ResolvedExposure = resolveExposure({ mcp: true, ui: false });

    expect(resolved).toEqual({ ui: false, http: false, mcp: true });
  });
});

describe("валидация входа, выхода и результата", () => {
  it("валидирует вход команды по inputSchema", () => {
    const valid = validateOperationInput(command, { title: "Подготовить релиз" });
    const invalid = validateOperationInput(command, { title: "" });

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.some((issue) => issue.path === "/title")).toBe(true);
    }
  });

  it("валидирует выход команды по outputSchema", () => {
    const valid = validateOperationOutput(command, {
      resource: "kanbaner.tasks:task:01J",
      version: 1,
    });
    const invalid = validateOperationOutput(command, {
      resource: "kanbaner.tasks:task:01J",
      version: 0,
    });

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(
        invalid.errors.some((issue) => issue.path === "/version" && issue.keyword === "minimum"),
      ).toBe(true);
    }
  });

  it("переиспользует скомпилированный валидатор входа", () => {
    const validator = createOperationInputValidator(command);

    expect(validator.check({ title: "ok" })).toBe(true);
    expect(validator.validate({ title: "" }).ok).toBe(false);
  });

  it("валидирует success и error конверты", () => {
    expect(validateOperationResult(toSuccessResult({ id: "01J" })).ok).toBe(true);
    expect(
      validateOperationResult({
        ok: false,
        error: createPluginError("NOT_FOUND", "Ресурс не найден"),
      }).ok,
    ).toBe(true);
  });

  it("отклоняет success без data и error без retryable", () => {
    expect(validateOperationResult({ ok: true }).ok).toBe(false);
    expect(
      validateOperationResult({
        ok: false,
        error: { code: "NOT_FOUND", message: "Ресурс не найден" },
      }).ok,
    ).toBe(false);
  });

  it("поддерживает все стабильные коды ошибок с корректным retryable", () => {
    expect(PLUGIN_ERROR_CODES).toHaveLength(11);

    for (const code of PLUGIN_ERROR_CODES) {
      const error = createPluginError(code, `Ошибка ${code}`);

      expect(error.code).toBe(code);
      expect(error.retryable).toBe(ERROR_RETRYABLE[code]);
      expect(isRetryableErrorCode(code)).toBe(error.retryable);
      expect(validateOperationResult(toErrorResult(error)).ok).toBe(true);
    }
  });

  it("позволяет безопасно переопределить retryable и детали", () => {
    const error = createPluginError("INTERNAL_ERROR", "Сбой", {
      retryable: true,
      details: { operation: "kanbaner.tasks.create" },
    });

    expect(error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Сбой",
      retryable: true,
      details: { operation: "kanbaner.tasks.create" },
    });
    expect(validateOperationResult(toErrorResult(error)).ok).toBe(true);
  });

  it("отклоняет неизвестный код ошибки", () => {
    expect(
      validateOperationResult({
        ok: false,
        error: { code: "UNKNOWN_ERROR", message: "x", retryable: false },
      }).ok,
    ).toBe(false);
  });

  it("строит схему результата для конкретных данных", () => {
    const schema = createResultSchema(Type.Object({ id: Type.String() }));
    const result = validateOperationResult({
      ok: true,
      data: { id: "01J" },
    });

    expect(result.ok).toBe(true);
    expect(schema.anyOf).toBeDefined();
  });

  it("различает success и error type guards", () => {
    const success: OperationResult<string> = toSuccessResult("ok");
    const failure: OperationResult<string> = toErrorResult(
      createPluginError("CANCELLED", "Отменено"),
    );

    expect(isSuccessResult(success)).toBe(true);
    expect(isErrorResult(success)).toBe(false);
    expect(isErrorResult(failure)).toBe(true);
    expect(isSuccessResult(failure)).toBe(false);
  });
});

describe("конверт вызова операции", () => {
  it("принимает логический конверт с source http", () => {
    const result = validateOperationEnvelope({
      contractVersion: 1,
      requestId: "01K-request",
      operationId: "kanbaner.tasks.create",
      operationVersion: 1,
      idempotencyKey: "01K-idempotency",
      source: { type: "http", id: "api" },
      payload: { title: "Подготовить релиз" },
    });

    expect(result.ok).toBe(true);
  });

  it("принимает все типы source из контракта", () => {
    for (const type of ["ui", "http", "mcp", "plugin", "system"] as const) {
      const result = validateOperationEnvelope({
        contractVersion: 1,
        requestId: "01K-request",
        operationId: "kanbaner.tasks.create",
        operationVersion: 1,
        source: { type },
        payload: {},
      });

      expect(result.ok).toBe(true);
    }
  });

  it("отклоняет чужие source и contractVersion", () => {
    const base = {
      contractVersion: 1,
      requestId: "01K-request",
      operationId: "kanbaner.tasks.create",
      operationVersion: 1,
      source: { type: "http" },
      payload: {},
    };

    expect(validateOperationEnvelope({ ...base, contractVersion: 2 }).ok).toBe(false);
    expect(validateOperationEnvelope({ ...base, source: { type: "worker" } }).ok).toBe(false);
  });

  it("TypeBox-схемы команд и запросов компилируются Ajv Draft 2020-12", () => {
    const ajv = new Ajv2020({ strict: true });

    expect(ajv.validateSchema(CommandMetadataSchema)).toBe(true);
    expect(ajv.validateSchema(QueryMetadataSchema)).toBe(true);
  });

  it("изолирует схемы плагинов с одинаковым $id", () => {
    const first = Type.Object({ first: Type.String() }, { $id: "urn:plugin:schema" });
    const second = Type.Object({ second: Type.Number() }, { $id: "urn:plugin:schema" });

    expect(validateWithSchema(first, { first: "ok" }).ok).toBe(true);
    expect(validateWithSchema(second, { second: 1 }).ok).toBe(true);
  });
});
