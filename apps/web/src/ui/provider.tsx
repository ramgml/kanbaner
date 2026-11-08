"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { UiSlotId } from "@kanbaner/plugin-sdk";

import type { UiPluginAvailability } from "../lib/plugin-manager-types";
import type { UiOperationInvoker } from "./operation-types";
import type { RegisteredUiContribution, UiContributionRegistry } from "./registry";
import { createUiContributionRegistry } from "./registry";

const RegistryContext = createContext<UiContributionRegistry | null>(null);
const AvailabilityContext = createContext<UiPluginAvailability | null | undefined>(undefined);
const InvokeContext = createContext<UiOperationInvoker | null>(null);

const UNAVAILABLE_INVOKER: UiOperationInvoker = async () => ({
  ok: false,
  error: {
    code: "PLUGIN_UNAVAILABLE",
    message: "Вызов операций не подключён к UI-рантайму",
    retryable: false,
  },
});

export interface UiRegistryProviderProps {
  readonly children: ReactNode;
  readonly registry?: UiContributionRegistry;
  readonly availability?: UiPluginAvailability;
  /** Реализация из layout/server action; в тестах можно передать заглушку. */
  readonly invoke?: UiOperationInvoker;
}

function isContributionAvailable(
  contribution: RegisteredUiContribution,
  availability: UiPluginAvailability | null | undefined,
): boolean {
  // Test-only режим без availability разрешает все вклады. В приложении
  // layout всегда передаёт allowlist активных плагинов, поэтому unknown,
  // removed и пустой список скрывают вклад.
  if (availability === null || availability === undefined) {
    return true;
  }

  return availability.activePluginIds.includes(contribution.pluginId);
}

export function UiRegistryProvider({
  children,
  registry,
  availability,
  invoke,
}: UiRegistryProviderProps) {
  const value = useMemo(() => registry ?? createUiContributionRegistry(), [registry]);

  return (
    <RegistryContext.Provider value={value}>
      <AvailabilityContext.Provider value={availability ?? null}>
        <InvokeContext.Provider value={invoke ?? UNAVAILABLE_INVOKER}>
          {children}
        </InvokeContext.Provider>
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

export function useUiAvailability(): UiPluginAvailability | null {
  return useContext(AvailabilityContext) ?? null;
}

export function useUiOperationInvoker(): UiOperationInvoker {
  return useContext(InvokeContext) ?? UNAVAILABLE_INVOKER;
}

function useRegistryVersion(registry: UiContributionRegistry): number {
  const subscribe = useMemo(() => registry.subscribe.bind(registry), [registry]);
  const getVersion = useMemo(() => registry.getVersion.bind(registry), [registry]);

  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

export function useUiContributions(
  slot: UiSlotId,
  pathname?: string,
): readonly RegisteredUiContribution[] {
  const registry = useUiRegistry();
  const availability = useUiAvailability();
  useRegistryVersion(registry);

  return registry
    .list(slot)
    .filter((contribution) => isContributionAvailable(contribution, availability))
    .filter((contribution) => {
      const route = contribution.contribution.route;

      return pathname === undefined || route === undefined || route === pathname;
    });
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
