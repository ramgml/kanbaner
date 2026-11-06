import type { ComponentType } from "react";

import type { UiContribution, UiContributionKind, UiSlotId } from "@kanbaner/plugin-sdk";

/**
 * Клиентский реестр UI-вкладов Plugin Contract v1.
 *
 * Модуль не импортирует ядро, DOM другого плагина или конкретные доменные
 * плагины. Он работает только с метаданными SDK и React-рендерером,
 * который передаёт владелец вклада.
 */

const CONTRIBUTION_KINDS: readonly UiContributionKind[] = [
  "view",
  "route",
  "navigation",
  "command",
  "panel",
  "settings",
  "resource-opener",
  "dialog",
  "notification",
];

const SLOT_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export interface RegisteredUiContribution {
  readonly pluginId: string;
  readonly contribution: UiContribution;
  readonly render: UiComponent;
}

export type UiComponent = ComponentType<{
  readonly contribution: RegisteredUiContribution;
}>;

export interface UiContributionRegistry {
  register(pluginId: string, contribution: UiContribution, render: UiComponent): () => void;
  unregisterPlugin(pluginId: string): void;
  list(slot: UiSlotId): readonly RegisteredUiContribution[];
  listAll(): readonly RegisteredUiContribution[];
  resolveRoute(pathname: string): RegisteredUiContribution | null;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  size(): number;
}

export type UiRegistryErrorCode =
  | "INVALID_PLUGIN_ID"
  | "INVALID_CONTRIBUTION"
  | "DUPLICATE_CONTRIBUTION_ID"
  | "DUPLICATE_ROUTE"
  | "INVALID_RENDERER";

export class UiRegistryError extends Error {
  readonly code: UiRegistryErrorCode;

  constructor(code: UiRegistryErrorCode, message: string) {
    super(message);
    this.name = "UiRegistryError";
    this.code = code;
  }
}

/** Приводит путь к виду `/view/example`: без query, hash и хвостового слэша. */
export function normalizeRoute(route: string): string {
  if (typeof route !== "string" || route.length === 0) {
    throw new UiRegistryError(
      "INVALID_CONTRIBUTION",
      "Маршрут вклада должен быть непустой строкой",
    );
  }

  if (!route.startsWith("/")) {
    throw new UiRegistryError("INVALID_CONTRIBUTION", "Маршрут вклада должен начинаться с /");
  }

  if (/\s/.test(route)) {
    throw new UiRegistryError("INVALID_CONTRIBUTION", "Маршрут вклада не должен содержать пробелы");
  }

  const path = route.split("#")[0]?.split("?")[0] ?? route;

  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UiRegistryError("INVALID_CONTRIBUTION", `Поле ${field} должно быть непустой строкой`);
  }
}

function assertContribution(value: UiContribution): UiContribution {
  if (typeof value !== "object" || value === null) {
    throw new UiRegistryError("INVALID_CONTRIBUTION", "Метаданные вклада должны быть объектом");
  }

  assertNonEmptyString(value.id, "id");
  assertNonEmptyString(value.slot, "slot");

  if (!SLOT_PATTERN.test(value.slot)) {
    throw new UiRegistryError("INVALID_CONTRIBUTION", "Слот вклада имеет неверный формат");
  }

  if (!CONTRIBUTION_KINDS.includes(value.kind)) {
    throw new UiRegistryError("INVALID_CONTRIBUTION", "Неизвестный вид UI-вклада");
  }

  if (!Number.isInteger(value.priority)) {
    throw new UiRegistryError("INVALID_CONTRIBUTION", "Приоритет вклада должен быть целым числом");
  }

  if (value.title !== undefined) {
    assertNonEmptyString(value.title, "title");
  }

  if (value.description !== undefined && typeof value.description !== "string") {
    throw new UiRegistryError("INVALID_CONTRIBUTION", "Описание вклада должно быть строкой");
  }

  if (value.commandId !== undefined) {
    assertNonEmptyString(value.commandId, "commandId");
  }

  if (value.resourceType !== undefined) {
    assertNonEmptyString(value.resourceType, "resourceType");
  }

  if (value.route !== undefined) {
    assertNonEmptyString(value.route, "route");
    normalizeRoute(value.route);
  }

  if (value.kind === "navigation") {
    assertNonEmptyString(value.title, "title");
    assertNonEmptyString(value.route, "route");
  }

  return value;
}

function assertPluginId(pluginId: string): void {
  if (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new UiRegistryError(
      "INVALID_PLUGIN_ID",
      "Владелец вклада должен иметь Plugin ID в формате namespace.plugin",
    );
  }
}

function assertRenderer(render: UiComponent | undefined): asserts render is UiComponent {
  if (typeof render !== "function") {
    throw new UiRegistryError("INVALID_RENDERER", "UI-вклад должен иметь React-рендерер");
  }
}

function compareContributions(
  left: RegisteredUiContribution,
  right: RegisteredUiContribution,
): number {
  if (left.contribution.priority !== right.contribution.priority) {
    return right.contribution.priority - left.contribution.priority;
  }

  const byPlugin = left.pluginId.localeCompare(right.pluginId);

  return byPlugin !== 0 ? byPlugin : left.contribution.id.localeCompare(right.contribution.id);
}

function isRouteContribution(contribution: UiContribution): boolean {
  return (
    contribution.route !== undefined &&
    (contribution.kind === "view" || contribution.kind === "route")
  );
}

class UiContributionRegistryImpl implements UiContributionRegistry {
  private readonly entries = new Map<string, RegisteredUiContribution>();
  private readonly routes = new Map<string, RegisteredUiContribution>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  register(pluginId: string, contribution: UiContribution, render: UiComponent): () => void {
    assertPluginId(pluginId);
    assertRenderer(render);

    const metadata = assertContribution(contribution);

    if (this.entries.has(metadata.id)) {
      throw new UiRegistryError(
        "DUPLICATE_CONTRIBUTION_ID",
        `UI-вклад с ID ${metadata.id} уже зарегистрирован`,
      );
    }

    const normalizedRoute = metadata.route === undefined ? null : normalizeRoute(metadata.route);

    if (normalizedRoute !== null && isRouteContribution(metadata)) {
      const existing = this.routes.get(normalizedRoute);

      if (existing !== undefined) {
        throw new UiRegistryError(
          "DUPLICATE_ROUTE",
          `Маршрут ${normalizedRoute} уже занят вкладом ${existing.contribution.id}`,
        );
      }
    }

    const entry: RegisteredUiContribution = {
      pluginId,
      contribution: { ...metadata },
      render,
    };

    this.entries.set(metadata.id, entry);

    if (normalizedRoute !== null && isRouteContribution(metadata)) {
      this.routes.set(normalizedRoute, entry);
    }

    this.emit();

    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;

      if (this.removeEntry(entry)) {
        this.emit();
      }
    };
  }

  unregisterPlugin(pluginId: string): void {
    let changed = false;

    for (const entry of [...this.entries.values()]) {
      if (entry.pluginId !== pluginId) {
        continue;
      }

      changed = this.removeEntry(entry) || changed;
    }

    if (changed) {
      this.emit();
    }
  }

  list(slot: UiSlotId): readonly RegisteredUiContribution[] {
    return [...this.entries.values()]
      .filter((entry) => entry.contribution.slot === slot)
      .sort(compareContributions);
  }

  listAll(): readonly RegisteredUiContribution[] {
    return [...this.entries.values()].sort(compareContributions);
  }

  resolveRoute(pathname: string): RegisteredUiContribution | null {
    try {
      return this.routes.get(normalizeRoute(pathname)) ?? null;
    } catch {
      return null;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  size(): number {
    return this.entries.size;
  }

  private removeEntry(entry: RegisteredUiContribution): boolean {
    const current = this.entries.get(entry.contribution.id);

    if (current !== entry) {
      return false;
    }

    this.entries.delete(entry.contribution.id);

    const route = entry.contribution.route;

    if (route !== undefined && this.routes.get(normalizeRoute(route)) === entry) {
      this.routes.delete(normalizeRoute(route));
    }

    return true;
  }

  private emit(): void {
    this.version += 1;

    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Создаёт независимый клиентский реестр UI-вкладов. */
export function createUiContributionRegistry(): UiContributionRegistry {
  return new UiContributionRegistryImpl();
}
