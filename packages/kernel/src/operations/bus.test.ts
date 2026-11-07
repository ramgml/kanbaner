import {
  PluginOperationError,
  type ExecutionContext,
  type PluginLogger,
} from "@kanbaner/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import { InMemoryStorageProvider } from "../storage/in-memory-provider.ts";
import { createOperationBus } from "./bus.ts";
import { OperationFailure } from "./errors.ts";
import {
  commandMetadata,
  delay,
  identifierOutputSchema,
  queryMetadata,
  titleInputSchema,
} from "./test-fixtures.ts";
import type { ExecutionOptions, OperationHandler } from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ContextSnapshot {
  readonly requestId: string;
  readonly traceId: string;
  readonly source: { readonly type: string; readonly id?: string };
  readonly idempotencyKey: string | null;
}

function contextSnapshot(context: ExecutionContext): ContextSnapshot {
  return {
    requestId: context.requestId,
    traceId: context.traceId,
    source: context.source,
    idempotencyKey: context.idempotencyKey ?? null,
  };
}

async function propagate<TInput>(
  parent: ExecutionContext,
  operationId: string,
  input: TInput,
): Promise<unknown> {
  const result = await parent.commands.execute(operationId, input);

  if (!result.ok) {
    throw OperationFailure.from(result.error);
  }

  return result.data;
}

describe("OperationBus: базовое выполнение", () => {
  it("выполняет команду и возвращает единый успешный конверт", async () => {
    const bus = createOperationBus();
    bus.registerCommand({
      metadata: commandMetadata(),
      handler: (input) => {
        const value = input as { title: string };

        return { id: "task-1", title: value.title };
      },
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "Подготовить релиз" });

    expect(result).toEqual({
      ok: true,
      data: { id: "task-1", title: "Подготовить релиз" },
    });
  });

  it("выполняет запрос через отдельный реестр", async () => {
    const bus = createOperationBus();
    bus.registerQuery({
      metadata: queryMetadata(),
      handler: () => ({ items: [] }),
    });

    const result = await bus.executeQuery("test.tasks.list", { title: "ignored" });

    expect(result).toEqual({ ok: true, data: { items: [] } });
  });

  it("возвращает NOT_FOUND для неизвестной операции", async () => {
    const bus = createOperationBus();

    const result = await bus.executeCommand("test.tasks.missing", {});

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.details).toEqual({
        operationId: "test.tasks.missing",
        kind: "mutation",
      });
    }
  });

  it("не выполняет запрос через реестр команд и наоборот", async () => {
    const bus = createOperationBus();
    bus.registerQuery({
      metadata: queryMetadata(),
      handler: () => ({ items: [] }),
    });

    const wrongRegistry = await bus.executeCommand("test.tasks.list", { title: "x" });

    expect(wrongRegistry.ok).toBe(false);

    if (!wrongRegistry.ok) {
      expect(wrongRegistry.error.code).toBe("NOT_FOUND");
    }
  });

  it("не вызывает обработчик при неверном входе", async () => {
    const bus = createOperationBus();
    const handler = vi.fn(() => ({ ok: true }));

    bus.registerCommand({ metadata: commandMetadata(), handler });

    const result = await bus.executeCommand("test.tasks.create", { title: 42 });

    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details).toMatchObject({ operationId: "test.tasks.create" });
      expect(result.error.details?.issues).toBeInstanceOf(Array);
    }
  });

  it("не раскрывает значение входа в ошибке валидации", async () => {
    const bus = createOperationBus();
    bus.registerCommand({ metadata: commandMetadata(), handler: () => ({}) });

    const result = await bus.executeCommand("test.tasks.create", {
      title: "hunter2",
      secret: "hunter2",
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});

describe("OperationBus: контекст и идемпотентность", () => {
  it("создаёт requestId и traceId, сохраняет source и idempotencyKey", async () => {
    const bus = createOperationBus();
    let captured: ExecutionContext | undefined;

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: (_input, context) => {
        captured = context;

        return { seen: true };
      },
    });

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { source: { type: "ui", id: "web" }, idempotencyKey: "operation-key-1" },
    );

    expect(result.ok).toBe(true);
    expect(captured).toBeDefined();

    if (captured === undefined) {
      return;
    }

    expect(captured.requestId).toMatch(UUID_PATTERN);
    expect(captured.traceId).toMatch(UUID_PATTERN);
    expect(captured.requestId).not.toBe(captured.traceId);
    expect(captured.source).toEqual({ type: "ui", id: "web" });
    expect(captured.idempotencyKey).toBe("operation-key-1");
  });

  it("использует внешний requestId верхнего вызова", async () => {
    const bus = createOperationBus();
    let captured: ExecutionContext | undefined;

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: (_input, context) => {
        captured = context;

        return {};
      },
    });

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { requestId: "X-Request-Id-42", source: { type: "http", id: "api" } },
    );

    expect(result.ok).toBe(true);
    expect(captured?.requestId).toBe("X-Request-Id-42");
    expect(captured?.traceId).toMatch(UUID_PATTERN);
  });

  it("отклоняет пустой внешний requestId", async () => {
    const bus = createOperationBus();
    const handler = vi.fn(() => ({}));

    bus.registerCommand({ metadata: commandMetadata(), handler });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" }, { requestId: "" });

    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details).toMatchObject({ field: "requestId" });
    }
  });

  it("использует source.type = system по умолчанию", async () => {
    const bus = createOperationBus();
    let sourceType: string | undefined;

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: (_input, context) => {
        sourceType = context.source.type;

        return {};
      },
    });

    await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(sourceType).toBe("system");
  });

  it("передаёт idempotencyKey без собственного хранения и дедупликации", async () => {
    const bus = createOperationBus();
    const contexts: ExecutionContext[] = [];
    const handler: OperationHandler = (input, context) => {
      contexts.push(context);

      return { handled: true, input };
    };

    bus.registerCommand({ metadata: commandMetadata(), handler });

    const options = { idempotencyKey: "same-key" };
    const first = await bus.executeCommand("test.tasks.create", { title: "x" }, options);
    const second = await bus.executeCommand("test.tasks.create", { title: "x" }, options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(contexts).toHaveLength(2);

    const firstContext = contexts[0];
    const secondContext = contexts[1];

    expect(firstContext).toBeDefined();
    expect(secondContext).toBeDefined();

    if (firstContext === undefined || secondContext === undefined) {
      return;
    }

    expect(firstContext.idempotencyKey).toBe("same-key");
    expect(secondContext.idempotencyKey).toBe("same-key");
    expect(firstContext.requestId).not.toBe(secondContext.requestId);
  });

  it("передаёт idempotencyKey вложенному вызову только явно", async () => {
    const bus = createOperationBus();
    let nestedKey: string | undefined | null;

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => {
        await context.commands.execute(
          "test.tasks.nested",
          { title: "nested" },
          { idempotencyKey: "nested-key" },
        );

        return {};
      },
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.nested" }),
      handler: (_input, context) => {
        nestedKey = context.idempotencyKey;

        return {};
      },
    });

    await bus.executeCommand(
      "test.tasks.outer",
      { title: "outer" },
      { idempotencyKey: "parent-key" },
    );

    expect(nestedKey).toBe("nested-key");
  });

  it("не наследует idempotencyKey родителя во вложенный вызов", async () => {
    const bus = createOperationBus();
    let nestedKey: string | null = "not-called";

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => {
        await context.commands.execute("test.tasks.nested", { title: "nested" });

        return {};
      },
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.nested" }),
      handler: (_input, context) => {
        nestedKey = context.idempotencyKey ?? null;

        return {};
      },
    });

    await bus.executeCommand(
      "test.tasks.outer",
      { title: "outer" },
      { idempotencyKey: "parent-key" },
    );

    expect(nestedKey).toBeNull();
  });

  it("не пишет входные данные и секреты в журнал", async () => {
    const debug = vi.fn();
    const logger: PluginLogger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const bus = createOperationBus({ logger });

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: () => ({ ok: true }),
    });

    await bus.executeCommand("test.tasks.create", { title: "top-secret-token" });

    expect(debug).toHaveBeenCalled();

    const serialized = JSON.stringify(debug.mock.calls);
    expect(serialized).not.toContain("top-secret-token");
    expect(serialized).toContain("test.tasks.create");
  });
});

describe("OperationBus: валидация выхода", () => {
  it("не проверяет выход по умолчанию", async () => {
    const bus = createOperationBus();
    bus.registerCommand({
      metadata: commandMetadata({ outputSchema: identifierOutputSchema }),
      handler: () => ({ id: 42 }),
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result).toEqual({ ok: true, data: { id: 42 } });
  });

  it("возвращает INTERNAL_ERROR при неверном выходе в strict mode", async () => {
    const bus = createOperationBus({ validateOutput: true });
    bus.registerCommand({
      metadata: commandMetadata({ outputSchema: identifierOutputSchema }),
      handler: () => ({ id: 42 }),
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.details).toMatchObject({ reason: "invalid_output" });
    }
  });

  it("принимает верный выход в strict mode", async () => {
    const bus = createOperationBus({ validateOutput: true });
    bus.registerCommand({
      metadata: commandMetadata({ outputSchema: identifierOutputSchema }),
      handler: () => ({ id: "task-1" }),
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result).toEqual({ ok: true, data: { id: "task-1" } });
  });
});

describe("OperationBus: вложенные вызовы", () => {
  it("сохраняет traceId и source, создавая новый requestId для вложенного вызова", async () => {
    const bus = createOperationBus();
    const outerHandler = vi.fn(async (_input: unknown, context: ExecutionContext) => {
      const query = await context.queries.execute("test.tasks.inner", { title: "inner" });
      const command = await context.commands.execute("test.tasks.nested", { title: "nested" });

      return {
        ...contextSnapshot(context),
        query,
        command,
      };
    });

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: outerHandler,
    });
    bus.registerQuery({
      metadata: queryMetadata({ id: "test.tasks.inner" }),
      handler: (_input, context) => contextSnapshot(context),
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.nested" }),
      handler: (_input, context) => contextSnapshot(context),
    });

    const result = await bus.executeCommand(
      "test.tasks.outer",
      { title: "outer" },
      { source: { type: "mcp", id: "agent" } },
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const data = result.data as {
      requestId: string;
      traceId: string;
      source: { type: string };
      query: { ok: true; data: ContextSnapshot } | { ok: false };
      command: { ok: true; data: ContextSnapshot } | { ok: false };
    };

    expect(data.source.type).toBe("mcp");
    expect(data.query.ok).toBe(true);
    expect(data.command.ok).toBe(true);

    if (!data.query.ok || !data.command.ok) {
      return;
    }

    expect(data.query.data.traceId).toBe(data.traceId);
    expect(data.command.data.traceId).toBe(data.traceId);
    expect(data.query.data.requestId).not.toBe(data.requestId);
    expect(data.command.data.requestId).not.toBe(data.requestId);
    expect(data.query.data.requestId).not.toBe(data.command.data.requestId);
    expect(data.query.data.source.type).toBe("mcp");
    expect(data.command.data.source.type).toBe("mcp");
  });

  it("не позволяет вложенному вызову подменить requestId и source", async () => {
    const bus = createOperationBus();
    const overrideOptions: ExecutionOptions = {
      requestId: "spoofed-request-id",
      source: { type: "http", id: "evil" },
    };
    let nestedSnapshot: ContextSnapshot | undefined;

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => {
        const nested = await context.commands.execute(
          "test.tasks.nested",
          { title: "nested" },
          overrideOptions,
        );

        return { ...contextSnapshot(context), nested };
      },
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.nested" }),
      handler: (_input, context) => {
        nestedSnapshot = contextSnapshot(context);

        return nestedSnapshot;
      },
    });

    const result = await bus.executeCommand(
      "test.tasks.outer",
      { title: "outer" },
      { requestId: "external-request-id", source: { type: "ui", id: "web" } },
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const data = result.data as {
      requestId: string;
      traceId: string;
      source: { type: string };
      nested: { ok: true; data: ContextSnapshot } | { ok: false };
    };

    expect(data.requestId).toBe("external-request-id");
    expect(nestedSnapshot).toBeDefined();

    if (nestedSnapshot === undefined || !data.nested.ok) {
      return;
    }

    expect(nestedSnapshot.requestId).not.toBe("spoofed-request-id");
    expect(nestedSnapshot.requestId).toMatch(UUID_PATTERN);
    expect(nestedSnapshot.traceId).toBe(data.traceId);
    expect(nestedSnapshot.source).toEqual({ type: "ui", id: "web" });
  });

  it("не позволяет вложенной команде вызывать запрос через ctx.commands", async () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: async (_input, context) => {
        const nested = await context.commands.execute("test.tasks.list", { title: "x" });

        return { nested };
      },
    });
    bus.registerQuery({
      metadata: queryMetadata(),
      handler: () => ({}),
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result.ok).toBe(true);

    if (result.ok) {
      const data = result.data as { nested: { ok: boolean; error?: { code: string } } };
      expect(data.nested.ok).toBe(false);
      expect(data.nested.error?.code).toBe("NOT_FOUND");
    }
  });

  it("обнаруживает цикл вложенных вызовов", async () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => propagate(context, "test.tasks.inner", { title: "x" }),
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.inner" }),
      handler: async (_input, context) => propagate(context, "test.tasks.outer", { title: "x" }),
    });

    const result = await bus.executeCommand("test.tasks.outer", { title: "x" });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.details).toMatchObject({
        reason: "operation_cycle",
        operationId: "test.tasks.outer",
      });
    }
  });

  it("ограничивает максимальную глубину", async () => {
    const bus = createOperationBus({ maxDepth: 2 });
    const deepest = vi.fn(() => ({}));

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => propagate(context, "test.tasks.middle", { title: "x" }),
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.middle" }),
      handler: async (_input, context) => propagate(context, "test.tasks.deep", { title: "x" }),
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.deep" }),
      handler: deepest,
    });

    const result = await bus.executeCommand("test.tasks.outer", { title: "x" });

    expect(result.ok).toBe(false);
    expect(deepest).not.toHaveBeenCalled();

    if (!result.ok) {
      expect(result.error.details).toMatchObject({
        reason: "max_depth_exceeded",
        maxDepth: 2,
        depth: 3,
      });
    }
  });

  it("не разрешает вложенный вызов при maxDepth = 1", async () => {
    const bus = createOperationBus({ maxDepth: 1 });
    const nested = vi.fn(() => ({}));

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => propagate(context, "test.tasks.inner", { title: "x" }),
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.inner" }),
      handler: nested,
    });

    const result = await bus.executeCommand("test.tasks.outer", { title: "x" });

    expect(result.ok).toBe(false);
    expect(nested).not.toHaveBeenCalled();
  });
});

describe("OperationBus: отмена и таймаут", () => {
  it("не запускает обработчик, если AbortSignal сработал сразу после executeCommand", async () => {
    const bus = createOperationBus();
    const handler = vi.fn(() => ({}));

    bus.registerCommand({ metadata: commandMetadata(), handler });

    const controller = new AbortController();
    const pending = bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { signal: controller.signal },
    );

    controller.abort();

    const result = await pending;

    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("CANCELLED");
    }
  });

  it("не запускает обработчик для уже отменённого signal", async () => {
    const bus = createOperationBus();
    const handler = vi.fn(() => ({}));

    bus.registerCommand({ metadata: commandMetadata(), handler });

    const controller = new AbortController();
    controller.abort();

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { signal: controller.signal },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("CANCELLED");
    }
  });

  it("не запускает вложенный обработчик при отмене сразу после вложенного вызова", async () => {
    const bus = createOperationBus();
    const nestedHandler = vi.fn(() => ({}));

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => {
        const nestedController = new AbortController();
        const nestedPending = context.commands.execute(
          "test.tasks.nested",
          { title: "nested" },
          { signal: nestedController.signal },
        );

        nestedController.abort();

        return { nested: await nestedPending };
      },
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.nested" }),
      handler: nestedHandler,
    });

    const result = await bus.executeCommand("test.tasks.outer", { title: "outer" });

    expect(nestedHandler).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);

    if (result.ok) {
      const data = result.data as { nested: { ok: boolean; error?: { code: string } } };
      expect(data.nested.ok).toBe(false);
      expect(data.nested.error?.code).toBe("CANCELLED");
    }
  });

  it("возвращает CANCELLED по AbortSignal", async () => {
    const bus = createOperationBus();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: async (_input, context) => {
        startedResolve?.();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });

        throw new OperationFailure("INTERNAL_ERROR", "Поздняя ошибка");
      },
    });

    const controller = new AbortController();
    const pending = bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { signal: controller.signal },
    );

    await started;
    controller.abort();

    const result = await pending;

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("CANCELLED");
    }
  });

  it("отменяет операцию, обработчик которой игнорирует signal, без unhandled rejection", async () => {
    const bus = createOperationBus();
    let rejectLater: ((error: Error) => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };

    process.on("unhandledRejection", onUnhandled);

    try {
      bus.registerCommand({
        metadata: commandMetadata(),
        handler: () => {
          startedResolve?.();

          return new Promise((_resolve, reject) => {
            rejectLater = reject;
          });
        },
      });

      const controller = new AbortController();
      const pending = bus.executeCommand(
        "test.tasks.create",
        { title: "x" },
        { signal: controller.signal },
      );

      await started;
      controller.abort();

      const result = await pending;

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("CANCELLED");
      }

      rejectLater?.(new Error("secret after cancellation"));
      await delay(20);

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("CANCELLED");
      }

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("не меняет результат при позднем resolve отменённого обработчика", async () => {
    const bus = createOperationBus();
    let resolveLater: ((value: unknown) => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: () => {
        startedResolve?.();

        return new Promise((resolve) => {
          resolveLater = resolve;
        });
      },
    });

    const controller = new AbortController();
    const pending = bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { signal: controller.signal },
    );

    await started;
    controller.abort();

    const result = await pending;

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("CANCELLED");
    }

    resolveLater?.({ late: true });
    await delay(20);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("CANCELLED");
    }
  });

  it("возвращает TIMEOUT по deadline и не оставляет unhandled rejection", async () => {
    const bus = createOperationBus();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };

    process.on("unhandledRejection", onUnhandled);

    try {
      bus.registerCommand({
        metadata: commandMetadata(),
        handler: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("secret after timeout")), 30);
          }),
      });

      const result = await bus.executeCommand(
        "test.tasks.create",
        { title: "x" },
        { deadline: new Date(Date.now() + 10) },
      );

      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
        expect(result.error.retryable).toBe(false);
      }

      await delay(60);

      expect(unhandled).toEqual([]);
      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("не помечает bus TIMEOUT неидемпотентной mutation как retryable и не ждёт её завершения", async () => {
    const bus = createOperationBus();
    let finished = false;

    bus.registerCommand({
      metadata: commandMetadata({ idempotency: "none" }),
      handler: async () => {
        await delay(40);
        finished = true;

        return { late: true };
      },
    });

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { deadline: new Date(Date.now() + 10) },
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(false);
    }

    expect(finished).toBe(false);

    await delay(60);

    expect(finished).toBe(true);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  it("не вызывает обработчик, если deadline уже истёк", async () => {
    const bus = createOperationBus();
    const handler = vi.fn(() => ({}));

    bus.registerCommand({ metadata: commandMetadata(), handler });

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { deadline: new Date(Date.now() - 1) },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  it("возвращает VALIDATION_ERROR для неверного deadline", async () => {
    const bus = createOperationBus();
    bus.registerCommand({ metadata: commandMetadata(), handler: () => ({}) });

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { deadline: new Date(Number.NaN) },
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details).toMatchObject({ field: "deadline" });
    }
  });

  it("возвращает VALIDATION_ERROR для пустого idempotencyKey", async () => {
    const bus = createOperationBus();
    bus.registerCommand({ metadata: commandMetadata(), handler: () => ({}) });

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { idempotencyKey: "" },
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details).toMatchObject({ field: "idempotencyKey" });
    }
  });

  it("возвращает VALIDATION_ERROR для неверного source", async () => {
    const bus = createOperationBus();
    bus.registerCommand({ metadata: commandMetadata(), handler: () => ({}) });

    const result = await bus.executeCommand(
      "test.tasks.create",
      { title: "x" },
      { source: { type: "cli" } as never },
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("ограничивает вложенный вызов его собственным deadline", async () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => {
        const nested = await context.commands.execute(
          "test.tasks.slow",
          { title: "slow" },
          { deadline: new Date(Date.now() + 10) },
        );

        return { nested };
      },
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.slow" }),
      handler: () => new Promise(() => undefined),
    });

    const result = await bus.executeCommand(
      "test.tasks.outer",
      { title: "outer" },
      { deadline: new Date(Date.now() + 5000) },
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      const data = result.data as { nested: { ok: boolean; error?: { code: string } } };
      expect(data.nested.ok).toBe(false);
      expect(data.nested.error?.code).toBe("TIMEOUT");
    }
  });

  it("распространяет timeout родителя на вложенный вызов", async () => {
    const bus = createOperationBus();
    let nestedPromise: Promise<unknown> | undefined;
    let nestedSignal: AbortSignal | undefined;

    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.outer" }),
      handler: async (_input, context) => {
        nestedPromise = context.commands.execute("test.tasks.slow", { title: "slow" });
        await new Promise(() => undefined);

        return {};
      },
    });
    bus.registerCommand({
      metadata: commandMetadata({ id: "test.tasks.slow" }),
      handler: (_input, context) => {
        nestedSignal = context.signal;

        return new Promise(() => undefined);
      },
    });

    const result = await bus.executeCommand(
      "test.tasks.outer",
      { title: "outer" },
      { deadline: new Date(Date.now() + 20) },
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(false);
    }

    expect(nestedPromise).toBeDefined();
    expect(nestedSignal).toBeDefined();
    expect(nestedSignal?.aborted).toBe(true);

    if (nestedPromise === undefined) {
      return;
    }

    const nestedResult = (await nestedPromise) as {
      ok: boolean;
      error?: { code: string; retryable: boolean };
    };

    expect(nestedResult.ok).toBe(false);
    expect(nestedResult.error?.code).toBe("TIMEOUT");
    expect(nestedResult.error?.retryable).toBe(false);
  });
});

describe("OperationBus: ошибки", () => {
  it("маппит OperationFailure в стабильный конверт", async () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: () => {
        throw new OperationFailure("VERSION_CONFLICT", "Задача изменена", {
          details: { expectedVersion: 3, actualVersion: 4 },
        });
      },
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        message: "Задача изменена",
        retryable: false,
        details: { expectedVersion: 3, actualVersion: 4 },
      },
    });
  });

  it("OperationFailure остаётся subclass публичного PluginOperationError", () => {
    const failure = new OperationFailure("NOT_FOUND", "Задача не найдена");

    expect(failure).toBeInstanceOf(PluginOperationError);
    expect(failure.error.code).toBe("NOT_FOUND");
  });

  it("маппит ошибку плагина, выброшенную как PluginOperationError", async () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: () => {
        throw new PluginOperationError("NOT_FOUND", "Задача не найдена", {
          details: { entity: "task", id: "task-1" },
        });
      },
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Задача не найдена",
        retryable: false,
        details: { entity: "task", id: "task-1" },
      },
    });
  });

  it("не раскрывает stack, внутренние пути и секреты произвольного исключения", async () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: () => {
        throw new Error("secret=/etc/passwd password=hunter2 at /home/aero/private.ts");
      },
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.message).toBe("Внутренняя ошибка операции");
      expect(result.error.details).toBeUndefined();
    }

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("/etc/passwd");
    expect(serialized).not.toContain("/home/aero");
    expect(serialized).not.toContain("private.ts");
    expect(serialized).not.toContain("Error:");
  });

  it("не раскрывает исходный Error в результате", async () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: () => {
        throw new TypeError("Секретная деталь");
      },
    });

    const result = await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.message).not.toContain("Секретная деталь");
    }
  });
});

describe("OperationBus: настройки", () => {
  it("отклоняет неверный maxDepth", () => {
    expect(() => createOperationBus({ maxDepth: 0 })).toThrow(RangeError);
    expect(() => createOperationBus({ maxDepth: 1.5 })).toThrow(RangeError);
  });

  it("выдаёт bound storage вместо raw provider-а", async () => {
    const provider = new InMemoryStorageProvider();
    const bus = createOperationBus({ storage: provider });
    let seenStorage: unknown;

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: (_input, context) => {
        seenStorage = context.storage;

        return {};
      },
    });

    await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(seenStorage).not.toBe(provider);
    expect(seenStorage).toMatchObject({ backendId: provider.backendId });
    expect((seenStorage as { readonly open?: unknown }).open).toBeUndefined();
    expect((seenStorage as { readonly migrations?: unknown }).migrations).toBeUndefined();
  });

  it("по умолчанию использует недоступный сервис ресурсов", async () => {
    const bus = createOperationBus();
    let resourcesResult: unknown;

    bus.registerCommand({
      metadata: commandMetadata(),
      handler: async (_input, context) => {
        try {
          await context.resources.list("test.tasks:task:1");
        } catch (error) {
          resourcesResult = error;
        }

        return {};
      },
    });

    await bus.executeCommand("test.tasks.create", { title: "x" });

    expect(resourcesResult).toBeInstanceOf(OperationFailure);

    if (resourcesResult instanceof OperationFailure) {
      expect(resourcesResult.error.code).toBe("PLUGIN_UNAVAILABLE");
    }
  });

  it("оставляет совместимую схему метаданных без обязательного exposure", async () => {
    const bus = createOperationBus();
    const metadata = commandMetadata();
    const withoutExposure = { ...metadata } as Record<string, unknown>;
    delete withoutExposure.exposure;

    const descriptor = bus.registerCommand({
      metadata: withoutExposure as never,
      handler: () => ({}),
    });

    expect(descriptor.exposure).toEqual({ ui: false, http: false, mcp: false });
  });
});

describe("OperationBus: схемы тестового плагина", () => {
  it("принимает отдельные inputSchema и outputSchema", () => {
    const bus = createOperationBus();

    bus.registerCommand({
      metadata: commandMetadata({
        inputSchema: titleInputSchema,
        outputSchema: identifierOutputSchema,
      }),
      handler: () => ({ id: "task-1" }),
    });

    expect(bus.registry.list()).toHaveLength(1);
  });
});
