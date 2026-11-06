import { describe, expect, it, vi } from "vitest";

import { OperationRegistrationError } from "./errors.ts";
import { OperationRegistry } from "./registry.ts";
import { commandMetadata, queryMetadata } from "./test-fixtures.ts";
import type { OperationHandler } from "./types.ts";

function catchRegistrationError(run: () => unknown): OperationRegistrationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationRegistrationError);

    return error as OperationRegistrationError;
  }

  throw new Error("Ожидалась ошибка регистрации операции");
}

const handler: OperationHandler = () => ({ ok: true });

describe("OperationRegistry", () => {
  it("регистрирует команду и запрос в раздельных реестрах", () => {
    const registry = new OperationRegistry();

    const command = registry.registerCommand({ metadata: commandMetadata(), handler });
    const query = registry.registerQuery({ metadata: queryMetadata(), handler });

    expect(command.kind).toBe("mutation");
    expect(command.pluginId).toBe("test.tasks");
    expect(command.exposure).toEqual({ ui: true, http: false, mcp: false });

    expect(query.kind).toBe("query");
    expect(query.exposure).toEqual({ ui: true, http: false, mcp: false });

    expect(registry.getCommand(command.id)?.id).toBe(command.id);
    expect(registry.getQuery(query.id)?.id).toBe(query.id);
    expect(registry.getCommand(query.id)).toBeUndefined();
    expect(registry.getQuery(command.id)).toBeUndefined();
    expect(registry.commands.has(command.id)).toBe(true);
    expect(registry.commands.has(query.id)).toBe(false);
    expect(registry.queries.has(query.id)).toBe(true);
    expect(registry.queries.has(command.id)).toBe(false);
    expect(registry.has(command.id)).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });

  it("отклоняет повторный ID команды", () => {
    const registry = new OperationRegistry();
    registry.registerCommand({ metadata: commandMetadata(), handler });

    const error = catchRegistrationError(() =>
      registry.registerCommand({ metadata: commandMetadata(), handler }),
    );

    expect(error.code).toBe("DUPLICATE_OPERATION_ID");
    expect(error.operationId).toBe("test.tasks.create");
  });

  it("отклоняет повторный ID запроса", () => {
    const registry = new OperationRegistry();
    registry.registerQuery({ metadata: queryMetadata(), handler });

    const error = catchRegistrationError(() =>
      registry.registerQuery({ metadata: queryMetadata(), handler }),
    );

    expect(error.code).toBe("DUPLICATE_OPERATION_ID");
  });

  it("отклоняет одинаковый ID команды и запроса", () => {
    const registry = new OperationRegistry();
    registry.registerCommand({ metadata: commandMetadata(), handler });

    const error = catchRegistrationError(() =>
      registry.registerQuery({
        metadata: queryMetadata({ id: "test.tasks.create" }),
        handler,
      }),
    );

    expect(error.code).toBe("DUPLICATE_OPERATION_ID");
    expect(error.operationId).toBe("test.tasks.create");
  });

  it.each([
    {
      name: "неверный kind команды",
      metadata: commandMetadata({ kind: "query" }),
    },
    {
      name: "неверный risk команды",
      metadata: commandMetadata({ risk: "admin" }),
    },
    {
      name: "нулевая версия",
      metadata: commandMetadata({ version: 0 }),
    },
    {
      name: "нецелая версия",
      metadata: commandMetadata({ version: 1.5 }),
    },
    {
      name: "неверный тип exposure",
      metadata: commandMetadata({ exposure: { ui: "yes" } }),
    },
    {
      name: "неизвестный канал exposure",
      metadata: commandMetadata({ exposure: { ui: true, ftp: true } }),
    },
  ])("отклоняет метаданные команды: $name", ({ metadata }) => {
    const registry = new OperationRegistry();
    const error = catchRegistrationError(() =>
      registry.registerCommand({ metadata: metadata as never, handler }),
    );

    expect(error.code).toBe("INVALID_OPERATION_METADATA");
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it.each([
    {
      name: "неверный risk запроса",
      metadata: queryMetadata({ risk: "write" }),
    },
    {
      name: "вид mutation в реестре запросов",
      metadata: queryMetadata({ kind: "mutation" }),
    },
  ])("отклоняет метаданные запроса: $name", ({ metadata }) => {
    const registry = new OperationRegistry();
    const error = catchRegistrationError(() =>
      registry.registerQuery({ metadata: metadata as never, handler }),
    );

    expect(error.code).toBe("INVALID_OPERATION_METADATA");
  });

  it("не принимает метаданные с некомпилируемой inputSchema", () => {
    const registry = new OperationRegistry();
    const invalidSchema = { type: "object", required: "title" };
    const error = catchRegistrationError(() =>
      registry.registerCommand({
        metadata: commandMetadata({ inputSchema: invalidSchema }),
        handler,
      }),
    );

    expect(error.code).toBe("INVALID_OPERATION_METADATA");
  });

  it("не принимает не-функцию в качестве обработчика", () => {
    const registry = new OperationRegistry();
    const error = catchRegistrationError(() =>
      registry.registerCommand({
        metadata: commandMetadata(),
        handler: null as unknown as OperationHandler,
      }),
    );

    expect(error.code).toBe("INVALID_OPERATION_HANDLER");
  });

  it("удаляет операцию и освобождает ID", () => {
    const registry = new OperationRegistry();
    registry.registerCommand({ metadata: commandMetadata(), handler });

    expect(registry.unregister("test.tasks.create")).toBe(true);
    expect(registry.has("test.tasks.create")).toBe(false);
    expect(registry.commands.has("test.tasks.create")).toBe(false);
    expect(registry.unregister("test.tasks.create")).toBe(false);

    expect(() =>
      registry.registerQuery({ metadata: queryMetadata({ id: "test.tasks.create" }), handler }),
    ).not.toThrow();
  });

  it("не вызывает обработчик при регистрации", () => {
    const registry = new OperationRegistry();
    const spy = vi.fn(handler);

    registry.registerCommand({ metadata: commandMetadata(), handler: spy });

    expect(spy).not.toHaveBeenCalled();
  });
});
