import type { UiContribution } from "@kanbaner/plugin-sdk";

import type { UiComponent, UiContributionRegistration, UiContributionRegistry } from "./registry";

export {
  createUiContributionRegistry,
  normalizeRoute,
  normalizeUiViewRoute,
  UiRegistryError,
  type RegisteredUiContribution,
  type UiComponent,
  type UiContributionRegistration,
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
 * Регистрирует все вклады плагина одним batch-ом.
 *
 * Весь набор валидируется до записи, state обновляется один раз, а
 * подписчики получают только полный snapshot.
 */
export function registerUiPlugin(
  registry: UiContributionRegistry,
  plugin: UiPluginDefinition,
): () => void {
  const registrations: UiContributionRegistration[] = plugin.contributions.map((contribution) => ({
    metadata: contribution.metadata,
    render: contribution.render,
  }));

  return registry.registerBatch(plugin.id, registrations);
}
