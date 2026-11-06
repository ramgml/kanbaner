import type { JsonValue, PluginManifest } from "@kanbaner/plugin-sdk";

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Минимальный структурный логгер runtime.
 *
 * Ядро не зависит от конкретной библиотеки логирования. Сообщения и детали
 * не содержат секретов и содержимого пользовательских данных.
 */
export interface PluginRuntimeLogger {
  log(
    level: PluginLogLevel,
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ): void | Promise<void>;
}

/** Контекст, который runtime передаёт серверному коду плагина. */
export interface PluginActivationContext {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly directory: string;
  readonly hostApiVersion: string;
  readonly logger: PluginRuntimeLogger;
}

/** Контекст деактивации серверного кода плагина. */
export type PluginDeactivationContext = PluginActivationContext;

/**
 * Структурный контракт серверной точки входа плагина.
 *
 * Плагин не обязан импортировать тип из ядра: достаточно экспортировать
 * функции `activate`/`deactivate` (именованно, объектом по умолчанию или
 * функцию по умолчанию как `activate`).
 */
export interface PluginServerModule {
  activate?(context: PluginActivationContext): void | Promise<void>;
  deactivate?(context: PluginDeactivationContext): void | Promise<void>;
}
