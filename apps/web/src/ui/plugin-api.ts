import type { UiContribution } from "@kanbaner/plugin-sdk";

import type { UiComponent, UiContributionRegistry } from "./registry";

export {
  createUiContributionRegistry,
  normalizeRoute,
  UiRegistryError,
  type RegisteredUiContribution,
  type UiComponent,
  type UiContributionRegistry,
  type UiRegistryErrorCode,
} from "./registry";

export interface UiPluginContribution {
  readonly metadata: UiContribution;
  readonly render: UiComponent;
}

export interface UiPluginDefinition {
  readonly id: string;
  readonly contributions: readonly UiPluginContribution[];
}

/**
 * Публичная точка входа для UI-плагина.
 *
 * Плагин передаёт только метаданные SDK и собственный React-рендерер. Он не
 * получает доступ к внутренностям shell, чужим DOM-узлам или состоянию ядра.
 */
export function defineUiPlugin(definition: UiPluginDefinition): UiPluginDefinition {
  return definition;
}

/**
 * Регистрирует все вклады плагина атомарно: при ошибке уже добавленные
 * вклады откатываются, чтобы реестр не оставался частично изменённым.
 */
export function registerUiPlugin(
  registry: UiContributionRegistry,
  plugin: UiPluginDefinition,
): () => void {
  const unregisters: Array<() => void> = [];

  try {
    for (const contribution of plugin.contributions) {
      unregisters.push(registry.register(plugin.id, contribution.metadata, contribution.render));
    }
  } catch (error) {
    for (const unregister of unregisters.reverse()) {
      unregister();
    }

    throw error;
  }

  return () => {
    for (const unregister of unregisters.reverse()) {
      unregister();
    }
  };
}
