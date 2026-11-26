import {
  createPluginError,
  toErrorResult,
  type ErrorResult,
  type JsonObject,
  type PluginErrorCode,
} from "@kanbaner/plugin-sdk";

export type CliExitCode = 2 | 3;

/** Внутренняя ошибка CLI, которая сериализуется в обычный ErrorResult. */
export class CliFailure extends Error {
  readonly result: ErrorResult;
  readonly exitCode: CliExitCode;

  constructor(
    code: PluginErrorCode,
    message: string,
    exitCode: CliExitCode,
    options: { readonly retryable?: boolean; readonly details?: JsonObject } = {},
  ) {
    super(message);
    this.name = "CliFailure";
    this.result = toErrorResult(createPluginError(code, message, options));
    this.exitCode = exitCode;
  }
}

export function usageError(message: string, details?: JsonObject): CliFailure {
  return new CliFailure("VALIDATION_ERROR", message, 2, {
    ...(details === undefined ? {} : { details }),
  });
}
