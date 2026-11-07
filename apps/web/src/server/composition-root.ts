import { describeKernel, type KernelDescriptor } from "@kanbaner/kernel";
import type { StorageProvider } from "@kanbaner/plugin-sdk";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "./application-composition";
import {
  createApplicationStorage,
  type ApplicationStorageOptions,
  type ApplicationStorageRuntime,
} from "./application-storage";

/**
 * Server composition root приложения.
 *
 * Composition создаёт Storage Provider, открывает его до плагинов, применяет
 * инфраструктурные миграции и собирает общие EventBus, ResourceRegistry,
 * LinkService, KernelResourceService, OperationBus и UI metadata registry.
 * Runtime плагинов получает эти же сервисы через `PluginHostServices`.
 */
export interface ApplicationComposition {
  readonly kernel: KernelDescriptor;
  readonly storageProvider: StorageProvider;
  readonly storage: ApplicationStorageRuntime;
  readonly pluginComposition: ApplicationPluginComposition;
  readonly plugins: readonly never[];
  close(): Promise<void>;
}

export interface ApplicationCompositionOptions {
  readonly storage?: ApplicationStorageOptions;
}

export async function createApplicationComposition(
  options: ApplicationCompositionOptions = {},
): Promise<ApplicationComposition> {
  const storage = await createApplicationStorage(options.storage);
  const pluginComposition = createApplicationPluginComposition({
    storage: storage.provider,
  });

  return {
    kernel: describeKernel(),
    storageProvider: storage.provider,
    storage,
    pluginComposition,
    plugins: [],
    async close(): Promise<void> {
      pluginComposition.dispose();
      await storage.registry.closeAll();
    },
  };
}
