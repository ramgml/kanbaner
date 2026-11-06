import { PLUGIN_CONTRACT_VERSION } from "@kanbaner/plugin-sdk";

/** Версия публичного API ядра. */
export const KERNEL_API_VERSION = 1 as const;

/** Минимальное описание ядра для composition root. */
export interface KernelDescriptor {
  readonly apiVersion: typeof KERNEL_API_VERSION;
  readonly pluginContractVersion: typeof PLUGIN_CONTRACT_VERSION;
}

/**
 * Возвращает описание ядра.
 *
 * Каркас KAN-001 не содержит реестров, Storage Provider, миграций
 * и доменной логики. Они добавляются последующими задачами.
 */
export function describeKernel(): KernelDescriptor {
  return {
    apiVersion: KERNEL_API_VERSION,
    pluginContractVersion: PLUGIN_CONTRACT_VERSION,
  };
}
