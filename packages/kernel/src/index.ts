import { PLUGIN_CONTRACT_VERSION } from "@kanbaner/plugin-sdk";

/** Версия публичного API ядра. */
export const KERNEL_API_VERSION = 1 as const;

/** Минимальное описание ядра для composition root. */
export interface KernelDescriptor {
  readonly apiVersion: typeof KERNEL_API_VERSION;
  readonly pluginContractVersion: typeof PLUGIN_CONTRACT_VERSION;
}

/** Возвращает описание ядра без раскрытия внутреннего состояния. */
export function describeKernel(): KernelDescriptor {
  return {
    apiVersion: KERNEL_API_VERSION,
    pluginContractVersion: PLUGIN_CONTRACT_VERSION,
  };
}

export * from "./lifecycle/index.ts";
export * from "./plugins/index.ts";
export * from "./operations/index.ts";
export * from "./events/index.ts";
export * from "./resources/index.ts";
export * from "./storage/index.ts";
