import type {
  CommandMetadata,
  ExecutionContext,
  InvocationOptions,
  JsonSchemaValidator,
  OperationId,
  OperationMetadata,
  OperationSource,
  PluginLogger,
  QueryMetadata,
  ResolvedExposure,
  ResourceService,
} from "@kanbaner/plugin-sdk";

/** Два вида операций Plugin Contract: изменяющая и читающая. */
export type OperationKind = "mutation" | "query";

/**
 * Обработчик операции.
 *
 * Обработчик возвращает только данные результата. Шину оборачивает их в
 * единый `OperationResult`; для ожидаемых ошибок используется
 * `OperationFailure`.
 */
export type OperationHandler = (
  input: unknown,
  context: ExecutionContext,
) => unknown | Promise<unknown>;

/** Регистрация команды: метаданные и обработчик. */
export interface CommandRegistration {
  readonly metadata: CommandMetadata;
  readonly handler: OperationHandler;
}

/** Регистрация запроса: метаданные и обработчик. */
export interface QueryRegistration {
  readonly metadata: QueryMetadata;
  readonly handler: OperationHandler;
}

/** Публичное описание зарегистрированной операции без обработчика. */
export interface OperationDescriptor {
  readonly id: OperationId;
  readonly kind: OperationKind;
  readonly pluginId: string;
  readonly metadata: OperationMetadata;
  readonly exposure: ResolvedExposure;
}

/** Внутренняя запись реестра: описание, обработчик и валидаторы. */
export interface RegisteredOperation extends OperationDescriptor {
  readonly handler: OperationHandler;
  readonly inputValidator: JsonSchemaValidator<unknown>;
  readonly outputValidator: JsonSchemaValidator<unknown>;
}

/** Настройки шины операций. */
export interface OperationBusOptions {
  /** Максимальная глубина вложенных вызовов, включая верхний уровень. */
  readonly maxDepth?: number;
  /** Включает проверку выхода по `outputSchema` (test/strict mode). */
  readonly validateOutput?: boolean;
  readonly logger?: PluginLogger;
  readonly resources?: ResourceService;
  readonly storage?: unknown;
}

/** Параметры верхнего вызова операции. */
export interface ExecutionOptions extends InvocationOptions {
  /**
   * Источник вызова. Для вложенных вызовов игнорируется: плагин не может
   * подменить источник, полученный от ядра.
   */
  readonly source?: OperationSource;
}
