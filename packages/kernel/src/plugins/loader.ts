import { pathToFileURL } from "node:url";

import type {
  PluginActivationContext,
  PluginDeactivationContext,
  PluginServerModule,
} from "../lifecycle/index.ts";

export type PluginModuleLoadResult =
  | { readonly ok: true; readonly module: PluginServerModule }
  | { readonly ok: false; readonly reason: "import_failed" | "invalid_module" };

type Activate = (context: PluginActivationContext) => void | Promise<void>;
type Deactivate = (context: PluginDeactivationContext) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickFunctions(value: unknown): PluginServerModule {
  if (!isRecord(value)) {
    return {};
  }

  const serverModule: {
    activate?: Activate;
    deactivate?: Deactivate;
  } = {};

  if (typeof value.activate === "function") {
    serverModule.activate = value.activate as Activate;
  }

  if (typeof value.deactivate === "function") {
    serverModule.deactivate = value.deactivate as Deactivate;
  }

  return serverModule.activate === undefined && serverModule.deactivate === undefined
    ? {}
    : serverModule;
}

function mergeModules(
  primary: PluginServerModule,
  fallback: PluginServerModule,
): PluginServerModule {
  const serverModule: {
    activate?: Activate;
    deactivate?: Deactivate;
  } = {};

  if (primary.activate !== undefined) {
    serverModule.activate = primary.activate;
  } else if (fallback.activate !== undefined) {
    serverModule.activate = fallback.activate;
  }

  if (primary.deactivate !== undefined) {
    serverModule.deactivate = primary.deactivate;
  } else if (fallback.deactivate !== undefined) {
    serverModule.deactivate = fallback.deactivate;
  }

  return serverModule.activate === undefined && serverModule.deactivate === undefined
    ? {}
    : serverModule;
}

/**
 * Приводит namespace динамического импорта к структурному контракту плагина.
 *
 * Поддерживаются именованные `activate`/`deactivate`, объект по умолчанию и
 * функция по умолчанию как `activate`.
 */
export function resolvePluginServerModule(namespace: unknown): PluginServerModule | null {
  try {
    return resolvePluginServerModuleUnsafe(namespace);
  } catch {
    // Proxy, throwing getter или иной враждебный namespace не должны
    // выбрасывать исключение за пределы загрузчика.
    return null;
  }
}

function resolvePluginServerModuleUnsafe(namespace: unknown): PluginServerModule | null {
  if (typeof namespace === "function") {
    return { activate: namespace as Activate };
  }

  if (!isRecord(namespace)) {
    return null;
  }

  const defaultExport = namespace.default;
  const fromDefault =
    typeof defaultExport === "function"
      ? { activate: defaultExport as Activate }
      : pickFunctions(defaultExport);
  const fromNamed = pickFunctions(namespace);
  const serverModule = mergeModules(fromDefault, fromNamed);

  return serverModule.activate === undefined && serverModule.deactivate === undefined
    ? null
    : serverModule;
}

/**
 * Загружает локальный серверный entrypoint через dynamic import.
 *
 * Путь уже разрешён и проверен как локальный файл внутри каталога плагина.
 * Удалённый код не загружается.
 */
export async function loadPluginServerModule(
  entrypointPath: string,
): Promise<PluginModuleLoadResult> {
  const url = pathToFileURL(entrypointPath).href;
  let namespace: unknown;

  try {
    namespace = await import(/* @vite-ignore */ url);
  } catch {
    return { ok: false, reason: "import_failed" };
  }

  let serverModule: PluginServerModule | null;

  try {
    serverModule = resolvePluginServerModule(namespace);
  } catch {
    return { ok: false, reason: "invalid_module" };
  }

  return serverModule === null
    ? { ok: false, reason: "invalid_module" }
    : { ok: true, module: serverModule };
}
