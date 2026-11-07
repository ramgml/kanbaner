import type { ComponentType } from "react";

import type { UiContribution, UiContributionKind, UiSlotId } from "@kanbaner/plugin-sdk";

import type { UiOperationInvoker } from "./operation-types";

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
const VIEW_ROUTE_PATTERN =
  /^\/view\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;

export interface RegisteredUiContribution {
  readonly pluginId: string;
  readonly contribution: UiContribution;
  readonly render: UiComponent;
}

export interface UiContributionRegistration {
  readonly metadata: UiContribution;
  readonly render: UiComponent;
}

export type UiComponent = ComponentType<{
  readonly contribution: RegisteredUiContribution;
  /** Вызов публичной операции через общий OperationBus. */
  readonly invoke: UiOperationInvoker;
}>;

export interface UiContributionRegistry {
  register(pluginId: string, contribution: UiContribution, render: UiComponent): () => void;
  registerBatch(pluginId: string, contributions: readonly UiContributionRegistration[]): () => void;
  /**
   * Идемпотентно синхронизирует серверные metadata плагина.
   *
   * Вклады с прежними ID обновляются, отсутствующие в новом наборе —
   * удаляются. Маршруты и счётчик реестра не создают дубликатов.
   */
  syncPlugin(
    pluginId: string,
    contributions: readonly UiContributionRegistration[],
    fallbackRender: UiComponent,
  ): () => void;
  /**
   * Привязывает реальный React-рендерер к metadata по ID вклада.
   *
   * Повторная привязка заменяет рендерер, не создавая второй вклад. Привязка
   * может прийти до metadata: она сохраняется и применяется при регистрации.
   */
  bindRenderer(pluginId: string, contributionId: string, render: UiComponent): () => void;
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
  | "INVALID_ROUTE"
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

  if (/\s/.test(route) || route.includes("\\")) {
    throw new UiRegistryError("INVALID_ROUTE", "Маршрут вклада содержит недопустимые символы");
  }

  const path = route.split("#")[0]?.split("?")[0] ?? route;

  if (path.includes("//")) {
    throw new UiRegistryError(
      "INVALID_ROUTE",
      "Маршрут вклада не должен содержать пустые сегменты",
    );
  }

  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new UiRegistryError("INVALID_ROUTE", "Маршрут вклада не должен содержать . или ..");
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * UI-плагинам разрешены только представления внутри `/view/`.
 * Core routes (`/plugins`, `/settings`, `/`) и произвольные разделы вроде
 * `/kanban` отклоняются, чтобы плагин не подменял навигацию shell-а.
 */
export function normalizeUiViewRoute(route: string): string {
  const normalized = normalizeRoute(route);

  if (!VIEW_ROUTE_PATTERN.test(normalized)) {
    throw new UiRegistryError(
      "INVALID_ROUTE",
      "Маршрут UI-вклада должен иметь вид /view/<name> и не пересекаться с core routes",
    );
  }

  return normalized;
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
    normalizeUiViewRoute(value.route);
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

interface BoundRenderer {
  readonly pluginId: string;
  readonly render: UiComponent;
}

class UiContributionRegistryImpl implements UiContributionRegistry {
  private readonly entries = new Map<string, RegisteredUiContribution>();
  private readonly routes = new Map<string, RegisteredUiContribution>();
  /** Реальные рендереры, привязанные composition-модулем по ID вклада. */
  private readonly boundRenderers = new Map<string, BoundRenderer>();
  /** Рендерер по умолчанию, который вернётся при снятии привязки. */
  private readonly fallbackRenderers = new Map<string, UiComponent>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  register(pluginId: string, contribution: UiContribution, render: UiComponent): () => void {
    return this.registerBatch(pluginId, [{ metadata: contribution, render }]);
  }

  registerBatch(
    pluginId: string,
    contributions: readonly UiContributionRegistration[],
  ): () => void {
    assertPluginId(pluginId);

    if (!Array.isArray(contributions)) {
      throw new UiRegistryError("INVALID_CONTRIBUTION", "Набор UI-вкладов должен быть массивом");
    }

    if (contributions.length === 0) {
      return () => undefined;
    }

    const seenIds = new Set<string>();
    const seenRoutes = new Set<string>();
    const prepared: RegisteredUiContribution[] = [];

    // Сначала валидируем весь batch, ничего не записывая. Внутренние дубликаты
    // ID и маршрутов тоже проверяются здесь, до единственного state update.
    for (const registration of contributions) {
      assertRenderer(registration.render);

      const metadata = assertContribution(registration.metadata);

      if (this.entries.has(metadata.id) || seenIds.has(metadata.id)) {
        throw new UiRegistryError(
          "DUPLICATE_CONTRIBUTION_ID",
          `UI-вклад с ID ${metadata.id} уже зарегистрирован`,
        );
      }

      seenIds.add(metadata.id);

      const normalizedRoute =
        metadata.route === undefined ? null : normalizeUiViewRoute(metadata.route);

      if (normalizedRoute !== null && isRouteContribution(metadata)) {
        if (this.routes.has(normalizedRoute) || seenRoutes.has(normalizedRoute)) {
          throw new UiRegistryError(
            "DUPLICATE_ROUTE",
            `Маршрут ${normalizedRoute} уже занят другим UI-вкладом`,
          );
        }

        seenRoutes.add(normalizedRoute);
      }

      prepared.push({
        pluginId,
        contribution:
          normalizedRoute === null ? { ...metadata } : { ...metadata, route: normalizedRoute },
        render: this.boundRenderers.get(metadata.id)?.render ?? registration.render,
      });
      this.fallbackRenderers.set(metadata.id, registration.render);
    }

    const added: RegisteredUiContribution[] = [];

    for (const entry of prepared) {
      this.entries.set(entry.contribution.id, entry);
      added.push(entry);

      if (isRouteContribution(entry.contribution)) {
        this.routes.set(normalizeUiViewRoute(entry.contribution.route as string), entry);
      }
    }

    this.emit();

    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;

      if (this.removeEntries(added)) {
        this.emit();
      }
    };
  }

  syncPlugin(
    pluginId: string,
    contributions: readonly UiContributionRegistration[],
    fallbackRender: UiComponent,
  ): () => void {
    assertPluginId(pluginId);
    assertRenderer(fallbackRender);

    if (!Array.isArray(contributions)) {
      throw new UiRegistryError("INVALID_CONTRIBUTION", "Набор UI-вкладов должен быть массивом");
    }

    const desired = new Map<string, RegisteredUiContribution>();
    const seenRoutes = new Set<string>();

    for (const registration of contributions) {
      assertRenderer(registration.render);

      const metadata = assertContribution(registration.metadata);
      const existing = this.entries.get(metadata.id);

      if (existing !== undefined && existing.pluginId !== pluginId) {
        throw new UiRegistryError(
          "DUPLICATE_CONTRIBUTION_ID",
          `UI-вклад с ID ${metadata.id} принадлежит другому плагину`,
        );
      }

      if (desired.has(metadata.id)) {
        throw new UiRegistryError(
          "DUPLICATE_CONTRIBUTION_ID",
          `UI-вклад с ID ${metadata.id} повторяется в наборе`,
        );
      }

      const normalizedRoute =
        metadata.route === undefined ? null : normalizeUiViewRoute(metadata.route);

      if (normalizedRoute !== null && isRouteContribution(metadata)) {
        const owner = this.routes.get(normalizedRoute);

        if (
          seenRoutes.has(normalizedRoute) ||
          (owner !== undefined && owner.pluginId !== pluginId)
        ) {
          throw new UiRegistryError(
            "DUPLICATE_ROUTE",
            `Маршрут ${normalizedRoute} уже занят другим UI-вкладом`,
          );
        }

        seenRoutes.add(normalizedRoute);
      }

      desired.set(metadata.id, {
        pluginId,
        contribution:
          normalizedRoute === null ? { ...metadata } : { ...metadata, route: normalizedRoute },
        render: this.boundRenderers.get(metadata.id)?.render ?? registration.render,
      });
    }

    const stale = [...this.entries.values()].filter(
      (entry) => entry.pluginId === pluginId && !desired.has(entry.contribution.id),
    );
    let changed = this.removeEntries(stale);

    for (const [route, entry] of [...this.routes]) {
      if (entry.pluginId !== pluginId) {
        continue;
      }

      const next = desired.get(entry.contribution.id);

      if (next === undefined || next.contribution.route !== route) {
        this.routes.delete(route);
        changed = true;
      }
    }

    for (const [id, entry] of desired) {
      const previous = this.entries.get(id);
      const render = this.boundRenderers.get(id)?.render ?? entry.render;
      const next = render === entry.render ? entry : { ...entry, render };

      this.fallbackRenderers.set(id, fallbackRender);

      if (
        previous === undefined ||
        previous.contribution !== next.contribution ||
        previous.render !== next.render
      ) {
        this.entries.set(id, next);
        changed = true;
      }

      const route = next.contribution.route;

      if (route !== undefined && isRouteContribution(next.contribution)) {
        if (this.routes.get(route) !== next) {
          this.routes.set(route, next);
          changed = true;
        }
      }
    }

    if (changed) {
      this.emit();
    }

    return () => {
      const removed = [...this.entries.values()].filter(
        (entry) => entry.pluginId === pluginId && desired.has(entry.contribution.id),
      );

      if (this.removeEntries(removed)) {
        this.emit();
      }
    };
  }

  bindRenderer(pluginId: string, contributionId: string, render: UiComponent): () => void {
    assertPluginId(pluginId);
    assertNonEmptyString(contributionId, "contributionId");
    assertRenderer(render);

    const previous = this.boundRenderers.get(contributionId);
    const existingEntry = this.entries.get(contributionId);

    if (
      (previous !== undefined && previous.pluginId !== pluginId) ||
      (existingEntry !== undefined && existingEntry.pluginId !== pluginId)
    ) {
      throw new UiRegistryError(
        "INVALID_RENDERER",
        `Рендерер вклада ${contributionId} принадлежит другому плагину`,
      );
    }

    if (previous?.render === render) {
      return () => undefined;
    }

    this.boundRenderers.set(contributionId, { pluginId, render });

    const entry = this.entries.get(contributionId);

    if (entry !== undefined && entry.pluginId === pluginId) {
      const next = { ...entry, render };

      this.entries.set(contributionId, next);

      const route = entry.contribution.route;

      if (route !== undefined && this.routes.get(route) === entry) {
        this.routes.set(route, next);
      }

      this.emit();
    }

    return () => {
      if (this.boundRenderers.get(contributionId)?.render !== render) {
        return;
      }

      this.boundRenderers.delete(contributionId);

      const fallback = this.fallbackRenderers.get(contributionId);
      const current = this.entries.get(contributionId);

      if (fallback !== undefined && current !== undefined && current.pluginId === pluginId) {
        const restored = { ...current, render: fallback };

        this.entries.set(contributionId, restored);

        const route = current.contribution.route;

        if (route !== undefined && this.routes.get(route) === current) {
          this.routes.set(route, restored);
        }

        this.emit();
      }
    };
  }

  unregisterPlugin(pluginId: string): void {
    const removed = [...this.entries.values()].filter((entry) => entry.pluginId === pluginId);

    if (removed.length > 0 && this.removeEntries(removed, true)) {
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
      return this.routes.get(normalizeUiViewRoute(pathname)) ?? null;
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

  private removeEntries(
    entries: readonly RegisteredUiContribution[],
    dropBoundRenderer = false,
  ): boolean {
    let changed = false;

    for (const entry of entries) {
      const current = this.entries.get(entry.contribution.id);

      if (current !== entry) {
        continue;
      }

      this.entries.delete(entry.contribution.id);
      this.fallbackRenderers.delete(entry.contribution.id);

      if (dropBoundRenderer) {
        this.boundRenderers.delete(entry.contribution.id);
      }

      const route = entry.contribution.route;

      if (route !== undefined) {
        const normalized = normalizeUiViewRoute(route);

        if (this.routes.get(normalized) === entry) {
          this.routes.delete(normalized);
        }
      }

      changed = true;
    }

    return changed;
  }

  /**
   * Listener-и не должны ломать регистрацию и друг друга. Ошибка одного
   * наблюдателя изолируется: состояние уже зафиксировано и остальные
   * слушатели получают полный snapshot.
   */
  private emit(): void {
    this.version += 1;

    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ошибка наблюдателя не откатывает и не дробит state update.
      }
    }
  }
}

/** Создаёт независимый клиентский реестр UI-вкладов. */
export function createUiContributionRegistry(): UiContributionRegistry {
  return new UiContributionRegistryImpl();
}
