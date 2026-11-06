import {
  createPluginError,
  toErrorResult,
  type ErrorResult,
  type JsonObject,
  type PluginError,
  type PluginErrorCode,
  type PluginErrorOptions,
  type ValidationIssue,
} from "@kanbaner/plugin-sdk";

/** Стабильные причины отказа регистрации операции. */
export type OperationRegistrationErrorCode =
  "DUPLICATE_OPERATION_ID" | "INVALID_OPERATION_METADATA" | "INVALID_OPERATION_HANDLER";

/**
 * Ошибка регистрации операции.
 *
 * Возникает при активации плагина и не является результатом выполнения
 * операции. Сообщение и issues не содержат значений входа и внутренних путей.
 */
export class OperationRegistrationError extends Error {
  readonly code: OperationRegistrationErrorCode;
  readonly operationId: string | undefined;
  readonly issues: readonly ValidationIssue[];

  constructor(
    code: OperationRegistrationErrorCode,
    message: string,
    options: {
      readonly operationId?: string;
      readonly issues?: readonly ValidationIssue[];
    } = {},
  ) {
    super(message);
    this.name = "OperationRegistrationError";
    this.code = code;
    this.operationId = options.operationId;
    this.issues = options.issues ?? [];
  }
}

/**
 * Ожидаемая ошибка выполнения операции.
 *
 * Обработчик должен использовать её для стабильных кодов Plugin Contract.
 * Любые другие исключения шина заменяет на безопасный `INTERNAL_ERROR`.
 */
export class OperationFailure extends Error {
  readonly error: PluginError;

  constructor(code: PluginErrorCode, message: string, options: PluginErrorOptions = {}) {
    super(message);
    this.name = "OperationFailure";
    this.error = createPluginError(code, message, options);
  }

  /** Создаёт ошибку из конверта `PluginError`, например из результата вложенного вызова. */
  static from(error: PluginError): OperationFailure {
    const options: PluginErrorOptions =
      error.details === undefined
        ? { retryable: error.retryable }
        : { retryable: error.retryable, details: error.details };

    return new OperationFailure(error.code, error.message, options);
  }
}

/** Стабильные причины превышения лимитов вложенных вызовов. */
export const OPERATION_LIMIT_REASONS = {
  maxDepth: "max_depth_exceeded",
  cycle: "operation_cycle",
} as const;

export type OperationLimitReason =
  (typeof OPERATION_LIMIT_REASONS)[keyof typeof OPERATION_LIMIT_REASONS];

function issueDetails(issues: readonly ValidationIssue[]): JsonObject {
  return {
    issues: issues.map((issue) => ({
      path: issue.path,
      schemaPath: issue.schemaPath,
      keyword: issue.keyword,
      message: issue.message,
    })),
  };
}

function errorResult(code: PluginErrorCode, message: string, details?: JsonObject): ErrorResult {
  return toErrorResult(
    details === undefined
      ? createPluginError(code, message)
      : createPluginError(code, message, { details }),
  );
}

/** Неверный вход операции; обработчик не вызывается. */
export function inputValidationError(
  operationId: string,
  issues: readonly ValidationIssue[],
): ErrorResult {
  return errorResult("VALIDATION_ERROR", "Аргументы операции не прошли валидацию", {
    operationId,
    ...issueDetails(issues),
  });
}

/** Неверный источник вызова. */
export function sourceValidationError(issues: readonly ValidationIssue[]): ErrorResult {
  return errorResult(
    "VALIDATION_ERROR",
    "Источник вызова не прошёл валидацию",
    issueDetails(issues),
  );
}

/** Неверная опция вызова. */
export function invalidOptionError(field: string): ErrorResult {
  return errorResult("VALIDATION_ERROR", "Параметр вызова операции имеет неверный формат", {
    field,
  });
}

/** Выход операции не соответствует объявленной схеме. */
export function invalidOutputError(
  operationId: string,
  issues: readonly ValidationIssue[],
): ErrorResult {
  return errorResult("INTERNAL_ERROR", "Результат операции не соответствует объявленной схеме", {
    reason: "invalid_output",
    operationId,
    ...issueDetails(issues),
  });
}

/** Операция с указанным ID не зарегистрирована в нужном реестре. */
export function notFoundError(operationId: string, kind: "mutation" | "query"): ErrorResult {
  return errorResult("NOT_FOUND", "Операция не найдена", {
    operationId,
    kind,
  });
}

/** Операция отменена внешним AbortSignal. */
export function cancelledError(): ErrorResult {
  return errorResult("CANCELLED", "Операция отменена");
}

/** Истёк deadline операции. */
export function timeoutError(): ErrorResult {
  return errorResult("TIMEOUT", "Истёк срок выполнения операции");
}

/** Внутренняя ошибка плагина без деталей исключения. */
export function internalError(): ErrorResult {
  return errorResult("INTERNAL_ERROR", "Внутренняя ошибка операции");
}

/** Цикл вложенных вызовов или превышение максимальной глубины. */
export function limitError(
  reason: OperationLimitReason,
  operationId: string,
  details: JsonObject = {},
): ErrorResult {
  return errorResult(
    "INTERNAL_ERROR",
    reason === OPERATION_LIMIT_REASONS.cycle
      ? "Обнаружен цикл вложенных вызовов операции"
      : "Превышена максимальная глубина вложенных вызовов операции",
    {
      reason,
      operationId,
      ...details,
    },
  );
}

/**
 * Преобразует исключение обработчика в безопасный конверт ошибки.
 *
 * Сообщение и стек произвольного `Error` наружу не передаются.
 */
export function mapThrownError(error: unknown): ErrorResult {
  return error instanceof OperationFailure ? toErrorResult(error.error) : internalError();
}
