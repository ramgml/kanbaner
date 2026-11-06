import {
  createPluginError,
  toErrorResult,
  type ErrorResult,
  type PluginErrorCode,
} from "@kanbaner/plugin-sdk";

/** Стабильные коды ошибок регистрации типов ресурсов. */
export type ResourceRegistryErrorCode = "INVALID_REGISTRATION" | "DUPLICATE_OWNER";

const SAFE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/**
 * Возвращает безопасное имя ошибки для структурного журнала.
 *
 * Произвольный `error.name` может содержать данные плагина, поэтому в журнал
 * попадают только стандартные имена JavaScript-ошибок. Неизвестное имя
 * заменяется на `Error`, не-`Error` значение — на `UnknownError`.
 */
export function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UnknownError";
  }

  return SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
}

/**
 * Ошибка регистрации владельца или типа ресурса.
 *
 * Регистрация — операция жизненного цикла плагина, поэтому ошибка бросается
 * синхронно. Сообщения не содержат данных ресурсов и безопасны для журнала.
 */
export class ResourceRegistryError extends Error {
  readonly code: ResourceRegistryErrorCode;

  constructor(code: ResourceRegistryErrorCode, message: string) {
    super(message);
    this.name = "ResourceRegistryError";
    this.code = code;
  }
}

/**
 * Ошибка операций ресурсов, которые по SDK не возвращают `OperationResult`.
 *
 * `link`, `unlink`, `list` и `open` возвращают данные или `void`, поэтому
 * стабильный код передаётся через это исключение. `resolve` использует тот же
 * код внутри `OperationResult`.
 */
export class ResourceServiceError extends Error {
  readonly code: PluginErrorCode;
  readonly retryable: boolean;

  constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = "ResourceServiceError";
    this.code = code;
    this.retryable = createPluginError(code, message).retryable;
  }

  /** Преобразует ошибку в единый конверт `OperationResult`. */
  toResult(): ErrorResult {
    return toErrorResult(createPluginError(this.code, this.message));
  }
}
