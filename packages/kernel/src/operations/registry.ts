import {
  createOperationInputValidator,
  createOperationOutputValidator,
  resolveExposure,
  validateCommandMetadata,
  validateQueryMetadata,
  type OperationMetadata,
  type ValidationIssue,
} from "@kanbaner/plugin-sdk";

import { OperationRegistrationError, type OperationRegistrationErrorCode } from "./errors.ts";
import type {
  CommandRegistration,
  OperationDescriptor,
  OperationHandler,
  QueryRegistration,
  RegisteredOperation,
} from "./types.ts";

const EXPOSURE_CHANNELS = new Set(["ui", "http", "mcp"]);

/** Вычисляет plugin ID из валидного operation ID. */
export function pluginIdOf(operationId: string): string {
  return operationId.split(".").slice(0, 2).join(".");
}

function unknownExposureIssue(channel: string): ValidationIssue {
  return {
    path: `/exposure/${channel}`,
    schemaPath: "#/exposure",
    keyword: "additionalProperties",
    message: "Неизвестный канал публикации операции",
    params: { additionalProperty: channel },
  };
}

function exposureIssues(metadata: OperationMetadata): readonly ValidationIssue[] {
  const exposure: unknown = metadata.exposure;

  if (exposure === undefined) {
    return [];
  }

  if (typeof exposure !== "object" || exposure === null || Array.isArray(exposure)) {
    return [];
  }

  return Object.keys(exposure)
    .filter((channel) => !EXPOSURE_CHANNELS.has(channel))
    .map(unknownExposureIssue);
}

function registrationError(
  code: OperationRegistrationErrorCode,
  message: string,
  options: {
    readonly operationId?: string;
    readonly issues?: readonly ValidationIssue[];
  } = {},
): OperationRegistrationError {
  return new OperationRegistrationError(code, message, options);
}

function descriptorOf(operation: RegisteredOperation): OperationDescriptor {
  return Object.freeze({
    id: operation.id,
    kind: operation.kind,
    pluginId: operation.pluginId,
    metadata: operation.metadata,
    exposure: operation.exposure,
  });
}

/** Публичная часть реестра одного вида операций. */
export interface OperationStore {
  get(operationId: string): OperationDescriptor | undefined;
  has(operationId: string): boolean;
  list(): readonly OperationDescriptor[];
}

/**
 * Хранилище операций одного вида.
 *
 * Команды и запросы получают отдельные экземпляры, а общую уникальность ID
 * обеспечивает `OperationRegistry`.
 */
class TypedOperationStore implements OperationStore {
  private readonly operations = new Map<string, RegisteredOperation>();

  get(operationId: string): OperationDescriptor | undefined {
    const operation = this.operations.get(operationId);

    return operation === undefined ? undefined : descriptorOf(operation);
  }

  has(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  list(): readonly OperationDescriptor[] {
    return [...this.operations.values()].map(descriptorOf);
  }

  add(operation: RegisteredOperation): void {
    this.operations.set(operation.id, operation);
  }

  remove(operationId: string): boolean {
    return this.operations.delete(operationId);
  }

  /** @internal Возвращает запись с обработчиком для шины выполнения. */
  resolve(operationId: string): RegisteredOperation | undefined {
    return this.operations.get(operationId);
  }
}

/**
 * Общий реестр команд и запросов.
 *
 * У команд и запросов отдельные хранилища, но общее пространство operation ID:
 * зарегистрировать команду и запрос с одинаковым ID или повторно один и тот же
 * ID нельзя. Метаданные проверяются публичными валидаторами Plugin SDK.
 */
export class OperationRegistry {
  private readonly commandStore = new TypedOperationStore();
  private readonly queryStore = new TypedOperationStore();
  private readonly operationIds = new Set<string>();

  readonly commands: OperationStore = this.commandStore;
  readonly queries: OperationStore = this.queryStore;

  registerCommand(registration: CommandRegistration): OperationDescriptor {
    this.assertHandler(registration.handler);

    const validation = validateCommandMetadata(registration.metadata);

    if (!validation.ok) {
      throw registrationError(
        "INVALID_OPERATION_METADATA",
        "Метаданные команды не прошли валидацию",
        { issues: validation.errors },
      );
    }

    return this.store(validation.value, registration.handler, this.commandStore);
  }

  registerQuery(registration: QueryRegistration): OperationDescriptor {
    this.assertHandler(registration.handler);

    const validation = validateQueryMetadata(registration.metadata);

    if (!validation.ok) {
      throw registrationError(
        "INVALID_OPERATION_METADATA",
        "Метаданные запроса не прошли валидацию",
        { issues: validation.errors },
      );
    }

    return this.store(validation.value, registration.handler, this.queryStore);
  }

  get(operationId: string): OperationDescriptor | undefined {
    return this.commandStore.get(operationId) ?? this.queryStore.get(operationId);
  }

  getCommand(operationId: string): OperationDescriptor | undefined {
    return this.commandStore.get(operationId);
  }

  getQuery(operationId: string): OperationDescriptor | undefined {
    return this.queryStore.get(operationId);
  }

  has(operationId: string): boolean {
    return this.operationIds.has(operationId);
  }

  list(): readonly OperationDescriptor[] {
    return [...this.commandStore.list(), ...this.queryStore.list()];
  }

  /** Удаляет операцию из реестра, например при деактивации плагина. */
  unregister(operationId: string): boolean {
    const removed = this.commandStore.remove(operationId) || this.queryStore.remove(operationId);

    if (removed) {
      this.operationIds.delete(operationId);
    }

    return removed;
  }

  /** @internal Возвращает запись с обработчиком для шины выполнения. */
  resolve(operationId: string): RegisteredOperation | undefined {
    return this.commandStore.resolve(operationId) ?? this.queryStore.resolve(operationId);
  }

  private assertHandler(handler: unknown): asserts handler is OperationHandler {
    if (typeof handler !== "function") {
      throw registrationError(
        "INVALID_OPERATION_HANDLER",
        "Обработчик операции должен быть функцией",
      );
    }
  }

  private store(
    metadata: OperationMetadata,
    handler: OperationHandler,
    target: TypedOperationStore,
  ): OperationDescriptor {
    const extraIssues = exposureIssues(metadata);

    if (extraIssues.length > 0) {
      throw registrationError(
        "INVALID_OPERATION_METADATA",
        "Метаданные операции содержат неизвестные каналы публикации",
        {
          operationId: metadata.id,
          issues: extraIssues,
        },
      );
    }

    if (this.operationIds.has(metadata.id)) {
      throw registrationError(
        "DUPLICATE_OPERATION_ID",
        "Операция с таким ID уже зарегистрирована",
        {
          operationId: metadata.id,
        },
      );
    }

    const operation: RegisteredOperation = Object.freeze({
      id: metadata.id,
      kind: metadata.kind,
      pluginId: pluginIdOf(metadata.id),
      metadata,
      exposure: resolveExposure(metadata.exposure),
      handler,
      inputValidator: createOperationInputValidator(metadata),
      outputValidator: createOperationOutputValidator(metadata),
    });

    target.add(operation);
    this.operationIds.add(metadata.id);

    return descriptorOf(operation);
  }
}
