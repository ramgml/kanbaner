import type { PluginManifest } from "@kanbaner/plugin-sdk";

import type { PluginDiagnostic } from "./diagnostics.ts";
import type { PluginActivationContext, PluginDeactivationContext } from "./module.ts";

export type MaybePromise<T> = T | Promise<T>;

/** Базовый контекст lifecycle hook. */
export interface PluginLifecycleContext {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly directory: string;
  readonly hostApiVersion: string;
}

/**
 * Контекст будущего runner-а миграций.
 *
 * KAN-003 не выполняет миграции и не обращается к хранилищу. Hook даёт
 * точке интеграции всё необходимое, чтобы следующий этап применил миграции
 * до серверной активации.
 */
export interface PluginMigrationContext extends PluginLifecycleContext {
  readonly manifestVersion: string;
  readonly migrationsPath: string | null;
}

/**
 * Lifecycle hooks ядра.
 *
 * Ошибка hook изолируется и переводит только связанный плагин в `failed`.
 */
export interface PluginLifecycleHooks {
  migrate?(context: PluginMigrationContext): MaybePromise<void>;
  beforeActivate?(context: PluginActivationContext): MaybePromise<void>;
  afterActivate?(context: PluginActivationContext): MaybePromise<void>;
  beforeDeactivate?(context: PluginDeactivationContext): MaybePromise<void>;
  afterDeactivate?(context: PluginDeactivationContext): MaybePromise<void>;
  onDiagnostic?(diagnostic: PluginDiagnostic): MaybePromise<void>;
}
