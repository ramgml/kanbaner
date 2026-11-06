"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { UiSlotId } from "@kanbaner/plugin-sdk";

import {
  EMPTY_UI_PLUGIN_AVAILABILITY,
  type UiPluginAvailability,
} from "../lib/plugin-manager-types";
import type { RegisteredUiContribution, UiContributionRegistry } from "./registry";
import { createUiContributionRegistry } from "./registry";

const RegistryContext = createContext<UiContributionRegistry | null>(null);
const AvailabilityContext = createContext<UiPluginAvailability | null>(null);

export interface UiRegistryProviderProps {
  readonly children: ReactNode;
  readonly registry?: UiContributionRegistry;
  readonly availability?: UiPluginAvailability;
}

function isContributionAvailable(
  contribution: RegisteredUiContribution,
  availability: UiPluginAvailability,
): boolean {
  return !availability.unavailablePluginIds.includes(contribution.pluginId);
}

export function UiRegistryProvider({ children, registry, availability }: UiRegistryProviderProps) {
  const value = useMemo(() => registry ?? createUiContributionRegistry(), [registry]);
  const availabilityValue = availability ?? EMPTY_UI_PLUGIN_AVAILABILITY;

  return (
    <RegistryContext.Provider value={value}>
      <AvailabilityContext.Provider value={availabilityValue}>
        {children}
      </AvailabilityContext.Provider>
    </RegistryContext.Provider>
  );
}

export function useUiRegistry(): UiContributionRegistry {
  const registry = useContext(RegistryContext);

  if (registry === null) {
    throw new Error("UiRegistryProvider отсутствует в дереве компонентов");
  }

  return registry;
}

export function useUiAvailability(): UiPluginAvailability {
  return useContext(AvailabilityContext) ?? EMPTY_UI_PLUGIN_AVAILABILITY;
}

function useRegistryVersion(registry: UiContributionRegistry): number {
  const subscribe = useMemo(() => registry.subscribe.bind(registry), [registry]);
  const getVersion = useMemo(() => registry.getVersion.bind(registry), [registry]);

  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

export function useUiContributions(slot: UiSlotId): readonly RegisteredUiContribution[] {
  const registry = useUiRegistry();
  const availability = useUiAvailability();
  useRegistryVersion(registry);

  return registry
    .list(slot)
    .filter((contribution) => isContributionAvailable(contribution, availability));
}

export function useUiRoute(pathname: string): RegisteredUiContribution | null {
  const registry = useUiRegistry();
  const availability = useUiAvailability();
  useRegistryVersion(registry);

  const contribution = registry.resolveRoute(pathname);

  return contribution !== null && isContributionAvailable(contribution, availability)
    ? contribution
    : null;
}
