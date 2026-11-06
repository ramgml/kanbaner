import { describeKernel, type KernelDescriptor } from "@kanbaner/kernel";

/**
 * Server composition root приложения.
 *
 * KAN-001 создаёт только пустой каркас: Storage Provider не
 * зарегистрирован, доменные плагины отсутствуют. Регистрация
 * провайдера и плагинов добавляется в KAN-009 и последующих задачах.
 */
export interface ApplicationComposition {
  readonly kernel: KernelDescriptor;
  readonly storageProvider: null;
  readonly plugins: readonly never[];
}

export function createApplicationComposition(): ApplicationComposition {
  return {
    kernel: describeKernel(),
    storageProvider: null,
    plugins: [],
  };
}
