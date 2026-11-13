import type { ComponentType, ReactNode } from "react";

import { parseResourceRef } from "@kanbaner/plugin-sdk";
import type {
  JsonObject,
  ResourceRef,
  UiContribution,
  UiContributionKind,
  UiSlotId,
} from "@kanbaner/plugin-sdk";

import type { UiOperationInvoker } from "./operation-types";
import type { UiResourceOpenResult } from "./resource-open";

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

/**
 * Рендер опубликованного плагином слота вместе с сериализуемым контекстом.
 *
 * Возвращает React-элемент, а не вызывает hooks: контекст и вклады
 * разрешаются внутри вложенного `UiSlot`.
 */
export type UiSlotRenderer = (slot: UiSlotId, context?: JsonObject) => ReactNode;

export type UiComponent = ComponentType<{
  readonly contribution: RegisteredUiContribution;
  /** Вызов публичной операции через общий OperationBus. */
  readonly invoke: UiOperationInvoker;
  /** Текущий pathname App Router; shell передаёт его в слоты. */
  readonly pathname?: string | undefined;
  /** Текущая query string App Router; нужна для синхронизации состояния. */
  readonly search?: string | undefined;
  /** Поддерживаемое обновление query string через App Router. */
  readonly replaceSearch?: ((search: string) => void) | undefined;
  /**
   * Сериализуемый контекст вложенного слота.
   *
   * Вклад не получает DOM или React-объекты родителя: только JSON-значения
   * вроде `{ resourceRef: "kanbaner.tasks:task:<id>" }`.
   */
  readonly context?: JsonObject | undefined;
  /**
   * Открывает `ResourceRef` через зарегистрированный resource-opener.
   *
   * Возвращает безопасный результат: неизвестный или отключённый ресурс не
   * бросает исключение и не роняет shell.
   */
  readonly openResource?: ((ref: ResourceRef) => UiResourceOpenResult) | undefined;
  /** Рендерит вклад в опубликованный слот с JSON-контекстом. */
  readonly renderSlot?: UiSlotRenderer | undefined;
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
  /**
   * Находит resource-opener для `ResourceRef`.
   *
   * Совпадение строится по `pluginId` и `resourceType` из ссылки. Для вкладов
   * другого домена используется явное поле `resourcePluginId`.
   */
  resolveResourceOpener(ref: ResourceRef): RegisteredUiContribution | null;
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

  if (value.resourcePluginId !== undefined) {
    assertNonEmptyString(value.resourcePluginId, "resourcePluginId");
  }

  if (value.route !== undefined) {
    assertNonEmptyString(value.route, "route");
    normalizeUiViewRoute(value.route);
  }

  if (value.kind === "navigation") {
    assertNonEmptyString(value.title, "title");
    assertNonEmptyString(value.route, "route");
  }

  if (value.kind === "resource-opener") {
    assertNonEmptyString(value.resourceType, "resourceType");
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

/**
 * Сравнивает metadata по значению.
 *
 * `syncPlugin` вызывается на каждый рендер серверного layout и получает
 * новые объекты, даже если содержимое не изменилось. Без структурного
 * сравнения реестр инкрементировал бы версию и будил подписчиков на каждом
 * таком вызове.
 */
function contributionEquals(left: UiContribution, right: UiContribution): boolean {
  return (
    left.id === right.id &&
    left.slot === right.slot &&
    left.kind === right.kind &&
    left.priority === right.priority &&
    left.title === right.title &&
    left.description === right.description &&
    left.route === right.route &&
    left.commandId === right.commandId &&
    left.resourceType === right.resourceType &&
    left.resourcePluginId === right.resourcePluginId
  );
}

interface BoundRenderer {
  readonly pluginId: string;
  readonly render: UiComponent;
}

interface PreparedRegistration {
  readonly entry: RegisteredUiContribution;
  readonly fallback: UiComponent;
}

class UiContributionRegistryImpl implements UiContributionRegistry {
  private readonly entries = new Map<string, RegisteredUiContribution>();
  private readonly routes = new Map<string, RegisteredUiContribution>();
  /** Реальные рендереры, привязанные composition-модулем по ID вклада. */
  private readonly boundRenderers = new Map<string, BoundRenderer>();
  /** Рендерер по умолчанию, который вернётся при снятии привязки. */
  private readonly fallbackRenderers = new Map<string, UiComponent>();
  /**
   * Поколение (token) активной регистрации каждого вклада.
   *
   * Cleanup старого batch/sync не должен удалять вклады, которые уже
   * заменило следующее поколение. Token сравнивается до любых изменений.
   */
  private readonly entryTokens = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private tokenSequence = 0;
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
    const prepared: PreparedRegistration[] = [];

    // Сначала валидируем весь batch, ничего не записывая. Внутренние дубликаты
    // ID и маршрутов тоже проверяются здесь, до единственного state update.
    // Привязка рендерера чужого плагина отклоняется до изменения состояния.
    for (const registration of contributions) {
      assertRenderer(registration.render);

      const metadata = assertContribution(registration.metadata);

      if (this.entries.has(metadata.id) || seenIds.has(metadata.id)) {
        throw new UiRegistryError(
          "DUPLICATE_CONTRIBUTION_ID",
          `UI-вклад с ID ${metadata.id} уже зарегистрирован`,
        );
      }

      const bound = this.boundRenderers.get(metadata.id);

      if (bound !== undefined && bound.pluginId !== pluginId) {
        throw new UiRegistryError(
          "INVALID_RENDERER",
          `Рендерер вклада ${metadata.id} принадлежит другому плагину`,
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
        entry: {
          pluginId,
          // Оригинальный route сохраняется: навигационный вклад может нести
          // служебную query (`?entry=1`). Нормализованный путь ниже служит
          // только ключом `routes` и проверкой дубликатов.
          contribution: { ...metadata },
          render: bound?.render ?? registration.render,
        },
        fallback: registration.render,
      });
    }

    const token = ++this.tokenSequence;
    const added: RegisteredUiContribution[] = [];

    for (const { entry, fallback } of prepared) {
      this.entries.set(entry.contribution.id, entry);
      this.entryTokens.set(entry.contribution.id, token);
      this.fallbackRenderers.set(entry.contribution.id, fallback);
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

      if (this.removeEntries(added, token, true)) {
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

    const desired = new Map<string, PreparedRegistration>();
    const seenRoutes = new Set<string>();

    // Вся валидация, включая владение уже привязанным рендерером, выполняется
    // до удаления stale-вкладов и изменения entries/routes.
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

      const bound = this.boundRenderers.get(metadata.id);

      if (bound !== undefined && bound.pluginId !== pluginId) {
        throw new UiRegistryError(
          "INVALID_RENDERER",
          `Рендерер вклада ${metadata.id} принадлежит другому плагину`,
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
        entry: {
          pluginId,
          // См. registerBatch: query навигационного вклада не теряется.
          contribution: { ...metadata },
          render: bound?.render ?? registration.render,
        },
        fallback: registration.render,
      });
    }

    const stale = [...this.entries.values()].filter(
      (entry) => entry.pluginId === pluginId && !desired.has(entry.contribution.id),
    );
    let changed = this.removeEntries(stale);

    // Маршрут удаляется и при view→panel: вид вклада изменился, хотя
    // строка route осталась прежней. Иначе resolveRoute отдавал бы panel.
    for (const [route, entry] of [...this.routes]) {
      if (entry.pluginId !== pluginId) {
        continue;
      }

      const next = desired.get(entry.contribution.id);
      const nextRoute =
        next === undefined || !isRouteContribution(next.entry.contribution)
          ? null
          : next.entry.contribution.route;

      if (
        next === undefined ||
        nextRoute === undefined ||
        nextRoute === null ||
        normalizeUiViewRoute(nextRoute) !== route
      ) {
        this.routes.delete(route);
        changed = true;
      }
    }

    const token = ++this.tokenSequence;

    for (const [id, { entry, fallback }] of desired) {
      const previous = this.entries.get(id);
      const bound = this.boundRenderers.get(id);
      const render = bound?.render ?? entry.render;
      const sameContribution =
        previous !== undefined && contributionEquals(previous.contribution, entry.contribution);
      const sameRender = previous !== undefined && previous.render === render;
      const next: RegisteredUiContribution =
        previous !== undefined && sameContribution && sameRender
          ? previous
          : {
              pluginId,
              contribution:
                previous !== undefined && sameContribution
                  ? previous.contribution
                  : entry.contribution,
              render,
            };

      this.entryTokens.set(id, token);
      this.fallbackRenderers.set(id, fallback);

      if (previous !== next) {
        this.entries.set(id, next);
        changed = true;
      }

      const route = next.contribution.route;

      if (route !== undefined && isRouteContribution(next.contribution)) {
        const routeKey = normalizeUiViewRoute(route);

        if (this.routes.get(routeKey) !== next) {
          this.routes.set(routeKey, next);
          changed = true;
        }
      }
    }

    if (changed) {
      this.emit();
    }

    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;

      // Cleanup этого поколения не трогает вклады, которые уже заменил
      // следующий sync (token изменился).
      const removed = [...this.entries.values()].filter(
        (entry) =>
          entry.pluginId === pluginId && this.entryTokens.get(entry.contribution.id) === token,
      );

      if (this.removeEntries(removed, token)) {
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

      if (route !== undefined && isRouteContribution(entry.contribution)) {
        const routeKey = normalizeUiViewRoute(route);

        if (this.routes.get(routeKey) === entry) {
          this.routes.set(routeKey, next);
        }
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

        if (route !== undefined && isRouteContribution(current.contribution)) {
          const routeKey = normalizeUiViewRoute(route);

          if (this.routes.get(routeKey) === current) {
            this.routes.set(routeKey, restored);
          }
        }

        this.emit();
      }
    };
  }

  unregisterPlugin(pluginId: string): void {
    const removed = [...this.entries.values()].filter((entry) => entry.pluginId === pluginId);
    const changed = this.removeEntries(removed, undefined, true);

    // Привязка могла прийти до metadata; отключение плагина убирает и её,
    // чтобы следующий sync не получил рендерер отключённого плагина.
    for (const [id, bound] of [...this.boundRenderers]) {
      if (bound.pluginId === pluginId) {
        this.boundRenderers.delete(id);
        this.fallbackRenderers.delete(id);
      }
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
      return this.routes.get(normalizeUiViewRoute(pathname)) ?? null;
    } catch {
      return null;
    }
  }

  resolveResourceOpener(ref: ResourceRef): RegisteredUiContribution | null {
    let parts: ReturnType<typeof parseResourceRef>;

    try {
      parts = parseResourceRef(ref);
    } catch {
      return null;
    }

    // listAll уже отсортирован по приоритету; первый подходящий вклад
    // детерминирован при равных приоритетах благодаря сортировке по ID.
    return (
      this.listAll().find(
        (entry) =>
          entry.contribution.kind === "resource-opener" &&
          entry.contribution.resourceType === parts.resourceType &&
          (entry.contribution.resourcePluginId ?? entry.pluginId) === parts.pluginId,
      ) ?? null
    );
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
    token?: number,
    dropBoundRenderer = false,
  ): boolean {
    let changed = false;

    for (const entry of entries) {
      const id = entry.contribution.id;

      if (token !== undefined && this.entryTokens.get(id) !== token) {
        continue;
      }

      const current = this.entries.get(id);

      if (current === undefined) {
        continue;
      }

      this.entries.delete(id);
      this.entryTokens.delete(id);
      this.fallbackRenderers.delete(id);

      if (dropBoundRenderer && this.boundRenderers.get(id)?.pluginId === current.pluginId) {
        this.boundRenderers.delete(id);
      }

      const route = current.contribution.route;

      if (route !== undefined) {
        const normalized = normalizeUiViewRoute(route);

        if (this.routes.get(normalized) === current) {
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
