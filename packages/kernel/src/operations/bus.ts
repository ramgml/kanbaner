import {
  OperationSourceSchema,
  toSuccessResult,
  validateWithSchema,
  type CommandInvoker,
  type ExecutionContext,
  type OperationId,
  type OperationResult,
  type OperationSource,
  type PluginLogger,
  type QueryInvoker,
  type ResourceService,
} from "@kanbaner/plugin-sdk";

import { createUnavailableResourceService, NOOP_LOGGER } from "./context.ts";
import {
  cancelledError,
  inputValidationError,
  internalError,
  invalidOptionError,
  invalidOutputError,
  limitError,
  mapThrownError,
  notFoundError,
  OPERATION_LIMIT_REASONS,
  sourceValidationError,
  timeoutError,
} from "./errors.ts";
import { createRequestId, createTraceId } from "./ids.ts";
import { OperationRegistry, pluginIdOf } from "./registry.ts";
import type {
  CommandRegistration,
  ExecutionOptions,
  OperationBusOptions,
  OperationDescriptor,
  OperationKind,
  QueryRegistration,
  RegisteredOperation,
} from "./types.ts";

/** Глубина вложенности по умолчанию, включая верхний вызов. */
export const DEFAULT_MAX_DEPTH = 16;

const DEFAULT_SOURCE: OperationSource = Object.freeze({ type: "system" });

const TIMEOUT_ABORT_REASON = Symbol("kanbaner.operations.timeout");
const CANCELLED_ABORT_REASON = Symbol("kanbaner.operations.cancelled");

interface ExecutionFrame {
  readonly requestId: string;
  readonly traceId: string;
  readonly source: OperationSource;
  readonly signal: AbortSignal;
  readonly deadline: Date | undefined;
  readonly idempotencyKey: string | undefined;
  readonly depth: number;
  readonly stack: readonly string[];
}

/** Верхний и вложенный вызов команды. */
export interface CommandExecutor extends CommandInvoker {
  execute<TInput = unknown, TOutput = unknown>(
    commandId: OperationId,
    input: TInput,
    options?: ExecutionOptions,
  ): Promise<OperationResult<TOutput>>;
}

/** Верхний и вложенный вызов запроса. */
export interface QueryExecutor extends QueryInvoker {
  execute<TInput = unknown, TOutput = unknown>(
    queryId: OperationId,
    input: TInput,
    options?: ExecutionOptions,
  ): Promise<OperationResult<TOutput>>;
}

function earliestDeadline(parent: Date | undefined, child: Date | undefined): Date | undefined {
  if (parent === undefined) {
    return child;
  }

  if (child === undefined) {
    return parent;
  }

  return child.getTime() < parent.getTime() ? child : parent;
}

class OperationRuntime {
  readonly registry = new OperationRegistry();

  private readonly maxDepth: number;
  private readonly validateOutput: boolean;
  private readonly logger: PluginLogger;
  private readonly resources: ResourceService;
  private readonly storage: unknown;

  constructor(options: OperationBusOptions) {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError("maxDepth должен быть целым числом не меньше 1");
    }

    if (options.validateOutput !== undefined && typeof options.validateOutput !== "boolean") {
      throw new TypeError("validateOutput должен быть логическим значением");
    }

    this.maxDepth = maxDepth;
    this.validateOutput = options.validateOutput === true;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.resources = options.resources ?? createUnavailableResourceService();
    this.storage = options.storage;
  }

  async execute(
    kind: OperationKind,
    operationId: OperationId,
    input: unknown,
    options: ExecutionOptions,
    parent?: ExecutionFrame,
  ): Promise<OperationResult<unknown>> {
    const startedAt = Date.now();
    const requestId = createRequestId();
    const traceId = parent === undefined ? createTraceId() : parent.traceId;

    const sourceValidation =
      parent === undefined
        ? validateWithSchema(OperationSourceSchema, options.source ?? DEFAULT_SOURCE)
        : { ok: true as const, value: parent.source };

    if (!sourceValidation.ok) {
      return sourceValidationError(sourceValidation.errors);
    }

    const source: OperationSource = Object.freeze({ ...sourceValidation.value });
    const operation = this.registry.resolve(operationId);
    const depth = parent === undefined ? 1 : parent.depth + 1;

    const complete = (result: OperationResult<unknown>): OperationResult<unknown> => {
      this.writeLog({
        operationId,
        pluginId: operation?.pluginId ?? pluginIdOf(operationId),
        kind,
        source: source.type,
        requestId,
        traceId,
        depth,
        durationMs: Date.now() - startedAt,
        ok: result.ok,
        ...(result.ok ? {} : { code: result.error.code }),
      });

      return result;
    };

    if (operation === undefined || operation.kind !== kind) {
      return complete(notFoundError(operationId, kind));
    }

    let stack: readonly string[] = [operationId];

    if (parent !== undefined) {
      if (parent.stack.includes(operationId)) {
        return complete(
          limitError(OPERATION_LIMIT_REASONS.cycle, operationId, {
            chain: [...parent.stack, operationId],
          }),
        );
      }

      if (depth > this.maxDepth) {
        return complete(
          limitError(OPERATION_LIMIT_REASONS.maxDepth, operationId, {
            depth,
            maxDepth: this.maxDepth,
          }),
        );
      }

      stack = [...parent.stack, operationId];
    }

    const childDeadline: unknown = options.deadline;

    if (
      childDeadline !== undefined &&
      (!(childDeadline instanceof Date) || !Number.isFinite(childDeadline.getTime()))
    ) {
      return complete(invalidOptionError("deadline"));
    }

    const deadline = earliestDeadline(parent?.deadline, childDeadline);

    const suppliedIdempotencyKey: unknown = options.idempotencyKey;

    if (
      suppliedIdempotencyKey !== undefined &&
      (typeof suppliedIdempotencyKey !== "string" || suppliedIdempotencyKey.length === 0)
    ) {
      return complete(invalidOptionError("idempotencyKey"));
    }

    const idempotencyKey = suppliedIdempotencyKey;

    const controller = new AbortController();
    const detach: Array<() => void> = [];
    let interrupted: "cancelled" | "timeout" | undefined;
    let canBeInterrupted = false;
    let wake: (() => void) | undefined;
    const interruption = new Promise<void>((resolve) => {
      wake = resolve;
    });

    const relayAbort = (signal: AbortSignal | undefined): void => {
      if (signal === undefined) {
        return;
      }

      canBeInterrupted = true;

      const onAbort = (): void => {
        const timedOut = signal.reason === TIMEOUT_ABORT_REASON;

        if (interrupted === undefined) {
          interrupted = timedOut ? "timeout" : "cancelled";
        }

        controller.abort(timedOut ? TIMEOUT_ABORT_REASON : CANCELLED_ABORT_REASON);
        wake?.();
      };

      if (signal.aborted) {
        onAbort();

        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
      detach.push(() => signal.removeEventListener("abort", onAbort));
    };

    relayAbort(parent?.signal);
    relayAbort(options.signal);

    const cleanup = (): void => {
      for (const remove of detach) {
        remove();
      }

      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;

    if (controller.signal.aborted) {
      cleanup();

      return complete(interrupted === "timeout" ? timeoutError() : cancelledError());
    }

    if (deadline !== undefined && deadline.getTime() <= Date.now()) {
      cleanup();

      return complete(timeoutError());
    }

    const inputValidation = operation.inputValidator.validate(input);

    if (!inputValidation.ok) {
      cleanup();

      return complete(inputValidationError(operationId, inputValidation.errors));
    }

    if (controller.signal.aborted) {
      cleanup();

      return complete(interrupted === "timeout" ? timeoutError() : cancelledError());
    }

    if (deadline !== undefined && deadline.getTime() <= Date.now()) {
      cleanup();

      return complete(timeoutError());
    }

    if (deadline !== undefined) {
      canBeInterrupted = true;
      timer = setTimeout(
        () => {
          if (interrupted === undefined) {
            interrupted = "timeout";
          }

          controller.abort(TIMEOUT_ABORT_REASON);
          wake?.();
        },
        Math.max(0, deadline.getTime() - Date.now()),
      );
      timer.unref();
    }

    const frame: ExecutionFrame = {
      requestId,
      traceId,
      source,
      signal: controller.signal,
      deadline,
      idempotencyKey,
      depth,
      stack,
    };
    const commands = new CommandBus(this, frame);
    const queries = new QueryBus(this, frame);
    const context: ExecutionContext = {
      requestId,
      traceId,
      source,
      signal: controller.signal,
      logger: this.logger,
      commands,
      queries,
      resources: this.resources,
      storage: this.storage,
      ...(deadline === undefined ? {} : { deadline }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };

    const interruptionResult: Promise<OperationResult<unknown>> | undefined = canBeInterrupted
      ? interruption.then(() => (interrupted === "timeout" ? timeoutError() : cancelledError()))
      : undefined;

    const handlerPromise = Promise.resolve().then(() => operation.handler(input, context));
    const outcome = handlerPromise.then(
      (data) => this.successResult(operation, data),
      (error: unknown) => {
        if (interrupted !== undefined) {
          return interrupted === "timeout" ? timeoutError() : cancelledError();
        }

        return mapThrownError(error);
      },
    );

    try {
      const result =
        interruptionResult === undefined
          ? await outcome
          : await Promise.race([outcome, interruptionResult]);

      return complete(result);
    } finally {
      cleanup();
    }
  }

  private successResult(operation: RegisteredOperation, data: unknown): OperationResult<unknown> {
    if (!this.validateOutput) {
      return toSuccessResult(data);
    }

    try {
      const validation = operation.outputValidator.validate(data);

      if (!validation.ok) {
        return invalidOutputError(operation.id, validation.errors);
      }
    } catch {
      return internalError();
    }

    return toSuccessResult(data);
  }

  private writeLog(fields: Readonly<Record<string, unknown>>): void {
    try {
      this.logger.debug("operation.finished", fields);
    } catch {
      // Ошибка журналирования не должна менять результат операции.
    }
  }
}

class CommandBus implements CommandExecutor {
  constructor(
    private readonly runtime: OperationRuntime,
    private readonly parent?: ExecutionFrame,
  ) {}

  execute<TInput = unknown, TOutput = unknown>(
    commandId: OperationId,
    input: TInput,
    options: ExecutionOptions = {},
  ): Promise<OperationResult<TOutput>> {
    return this.runtime.execute("mutation", commandId, input, options, this.parent) as Promise<
      OperationResult<TOutput>
    >;
  }
}

class QueryBus implements QueryExecutor {
  constructor(
    private readonly runtime: OperationRuntime,
    private readonly parent?: ExecutionFrame,
  ) {}

  execute<TInput = unknown, TOutput = unknown>(
    queryId: OperationId,
    input: TInput,
    options: ExecutionOptions = {},
  ): Promise<OperationResult<TOutput>> {
    return this.runtime.execute("query", queryId, input, options, this.parent) as Promise<
      OperationResult<TOutput>
    >;
  }
}

/**
 * Шина команд и запросов.
 *
 * Команды и запросы используют раздельные фасады выполнения, но общий реестр
 * и общее пространство operation ID. Вложенные вызовы получают тот же
 * `traceId`, источник и цепочку выполнения.
 */
export class OperationBus {
  readonly registry: OperationRegistry;
  readonly commands: CommandExecutor;
  readonly queries: QueryExecutor;

  private readonly runtime: OperationRuntime;

  constructor(options: OperationBusOptions = {}) {
    this.runtime = new OperationRuntime(options);
    this.registry = this.runtime.registry;
    this.commands = new CommandBus(this.runtime);
    this.queries = new QueryBus(this.runtime);
  }

  registerCommand(registration: CommandRegistration): OperationDescriptor {
    return this.registry.registerCommand(registration);
  }

  registerQuery(registration: QueryRegistration): OperationDescriptor {
    return this.registry.registerQuery(registration);
  }

  executeCommand<TInput = unknown, TOutput = unknown>(
    commandId: OperationId,
    input: TInput,
    options: ExecutionOptions = {},
  ): Promise<OperationResult<TOutput>> {
    return this.commands.execute<TInput, TOutput>(commandId, input, options);
  }

  executeQuery<TInput = unknown, TOutput = unknown>(
    queryId: OperationId,
    input: TInput,
    options: ExecutionOptions = {},
  ): Promise<OperationResult<TOutput>> {
    return this.queries.execute<TInput, TOutput>(queryId, input, options);
  }
}

/** Создаёт шину операций. */
export function createOperationBus(options: OperationBusOptions = {}): OperationBus {
  return new OperationBus(options);
}
