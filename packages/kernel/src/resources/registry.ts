import {
  createPluginError,
  isPluginId,
  isResourceType,
  parseResourceRef,
  toErrorResult,
  toSuccessResult,
  validateResourceDescriptor,
  validateResourceRef,
  type ErrorResult,
  type LogFields,
  type OperationResult,
  type PluginId,
  type PluginLogger,
  type ResourceDescriptor,
  type ResourceRef,
  type ResourceType,
} from "@kanbaner/plugin-sdk";

import { ResourceRegistryError, ResourceServiceError, safeErrorName } from "./errors.ts";

/**
 * Адаптер плагина-владельца типа ресурса.
 *
 * `resolve` обязан быть чистым чтением. `null` или `undefined` означают, что
 * ресурс отсутствует; для удалённого ресурса сервис возвращает `NOT_FOUND`.
 */
export interface ResourceAdapter {
  resolve(
    ref: ResourceRef,
  ): Promise<ResourceDescriptor | null | undefined> | ResourceDescriptor | null | undefined;
  canOpen?(ref: ResourceRef): Promise<boolean> | boolean;
  open?(ref: ResourceRef): Promise<void> | void;
}

/** Регистрация владельца и его типов ресурсов. */
export interface ResourceRegistration {
  readonly pluginId: PluginId;
  readonly resourceTypes: readonly ResourceType[];
  readonly adapter: ResourceAdapter;
}

export interface ResourceRegistryOptions {
  /** Необязательный логгер безопасной диагностики ошибок адаптеров. */
  readonly logger?: PluginLogger;
}

/**
 * Реестр типов ресурсов по plugin ID владельца.
 *
 * Тип ресурса локален внутри plugin ID: разные плагины могут независимо
 * объявить `widget` и разрешаются каждый своим адаптером. Глобальной
 * уникальности типов нет.
 *
 * Один плагин регистрируется один раз и сразу объявляет все свои типы.
 * Дубликат plugin ID и некорректная регистрация отклоняются до изменения
 * состояния, поэтому неудачная регистрация не оставляет частичных записей.
 */
export class ResourceRegistry {
  readonly #logger: PluginLogger | undefined;
  readonly #owners = new Map<PluginId, RegisteredOwner>();

  constructor(options: ResourceRegistryOptions = {}) {
    this.#logger = options.logger;
  }

  /** Регистрирует владельца и его типы ресурсов. */
  register(registration: ResourceRegistration): void {
    if (!isPluginId(registration.pluginId)) {
      throw new ResourceRegistryError(
        "INVALID_REGISTRATION",
        "Регистрация содержит некорректный plugin ID",
      );
    }

    const resourceTypes = this.#validateResourceTypes(registration.resourceTypes);
    const { adapter } = registration;

    if (typeof adapter !== "object" || adapter === null || typeof adapter.resolve !== "function") {
      throw new ResourceRegistryError(
        "INVALID_REGISTRATION",
        "Адаптер ресурса должен реализовывать resolve",
      );
    }

    if (adapter.canOpen !== undefined && typeof adapter.canOpen !== "function") {
      throw new ResourceRegistryError(
        "INVALID_REGISTRATION",
        "Адаптер ресурса содержит некорректный canOpen",
      );
    }

    if (adapter.open !== undefined && typeof adapter.open !== "function") {
      throw new ResourceRegistryError(
        "INVALID_REGISTRATION",
        "Адаптер ресурса содержит некорректный open",
      );
    }

    if (this.#owners.has(registration.pluginId)) {
      throw new ResourceRegistryError("DUPLICATE_OWNER", "Владелец ресурсов уже зарегистрирован");
    }

    this.#owners.set(registration.pluginId, {
      pluginId: registration.pluginId,
      resourceTypes: new Set(resourceTypes),
      adapter,
    });
  }

  hasOwner(pluginId: PluginId): boolean {
    return this.#owners.has(pluginId);
  }

  /** Проверяет, объявил ли конкретный плагин этот тип ресурса. */
  owns(pluginId: PluginId, resourceType: ResourceType): boolean {
    return this.#owners.get(pluginId)?.resourceTypes.has(resourceType) === true;
  }

  /** Возвращает объявленные типы владельца в порядке регистрации. */
  resourceTypesOf(pluginId: PluginId): readonly ResourceType[] {
    const owner = this.#owners.get(pluginId);

    return owner === undefined ? [] : [...owner.resourceTypes];
  }

  /**
   * Разрешает ссылку только через зарегистрированного владельца.
   *
   * Метод не изменяет реестр и не вызывает `canOpen`/`open`. Неизвестный
   * plugin ID, незарегистрированный тип и отсутствующий ресурс дают
   * `NOT_FOUND`; некорректная строка ссылки — `VALIDATION_ERROR`.
   */
  async resolve(ref: ResourceRef): Promise<OperationResult<ResourceDescriptor>> {
    const resolved = await this.#resolveOwned(ref);

    return resolved.ok ? toSuccessResult(resolved.value.descriptor) : resolved.error;
  }

  /**
   * Проверяет, доступно ли открытие ресурса.
   *
   * Сначала выполняет чистый `resolve`: отсутствующий ресурс или ошибка
   * адаптера дают `false` без вызова `canOpen`. Любая ошибка или неизвестный
   * ресурс означают `false`: метод не бросает исключений и не должен ломать
   * страницу из-за недоступного адаптера.
   */
  async canOpen(ref: ResourceRef): Promise<boolean> {
    const resolved = await this.#resolveOwned(ref);

    if (!resolved.ok) {
      return false;
    }

    const { parts, owner } = resolved.value;

    if (owner.adapter.canOpen === undefined) {
      return typeof owner.adapter.open === "function";
    }

    try {
      return (await owner.adapter.canOpen(ref)) === true;
    } catch (error) {
      this.#logFailure("canOpen", parts.pluginId, parts.resourceType, error);

      return false;
    }
  }

  /**
   * Открывает ресурс через адаптер владельца.
   *
   * Сначала выполняет чистый `resolve`; стабильный код его ошибки
   * пробрасывается, а `open` адаптера не вызывается. При ошибке самого
   * `open` бросается `ResourceServiceError` с `INTERNAL_ERROR`.
   */
  async open(ref: ResourceRef): Promise<void> {
    const resolved = await this.#resolveOwned(ref);

    if (!resolved.ok) {
      throw new ResourceServiceError(resolved.error.error.code, resolved.error.error.message);
    }

    const { parts, owner } = resolved.value;
    const { open } = owner.adapter;

    if (open === undefined) {
      throw new ResourceServiceError(
        "PLUGIN_UNAVAILABLE",
        "Владелец ресурса не поддерживает открытие",
      );
    }

    try {
      await open.call(owner.adapter, ref);
    } catch (error) {
      this.#logFailure("open", parts.pluginId, parts.resourceType, error);

      throw new ResourceServiceError("INTERNAL_ERROR", "Не удалось открыть ресурс");
    }
  }

  #validateResourceTypes(resourceTypes: readonly ResourceType[]): readonly ResourceType[] {
    if (!Array.isArray(resourceTypes) || resourceTypes.length === 0) {
      throw new ResourceRegistryError(
        "INVALID_REGISTRATION",
        "Владелец должен объявить хотя бы один тип ресурса",
      );
    }

    const seen = new Set<ResourceType>();

    for (const resourceType of resourceTypes) {
      if (!isResourceType(resourceType)) {
        throw new ResourceRegistryError(
          "INVALID_REGISTRATION",
          "Регистрация содержит некорректный тип ресурса",
        );
      }

      if (seen.has(resourceType)) {
        throw new ResourceRegistryError(
          "INVALID_REGISTRATION",
          "Регистрация содержит повторяющийся тип ресурса",
        );
      }

      seen.add(resourceType);
    }

    return resourceTypes;
  }

  #lookup(ref: ResourceRef): LookupOutcome {
    const validation = validateResourceRef(ref);

    if (!validation.ok) {
      return {
        ok: false,
        error: toErrorResult(
          createPluginError("VALIDATION_ERROR", "Некорректная ссылка на ресурс"),
        ),
      };
    }

    let parts: ParsedRef;

    try {
      parts = parseResourceRef(validation.value);
    } catch {
      return {
        ok: false,
        error: toErrorResult(
          createPluginError("VALIDATION_ERROR", "Некорректная ссылка на ресурс"),
        ),
      };
    }

    const owner = this.#owners.get(parts.pluginId);

    if (owner === undefined || !owner.resourceTypes.has(parts.resourceType)) {
      return {
        ok: false,
        error: toErrorResult(createPluginError("NOT_FOUND", "Ресурс не найден")),
      };
    }

    return { ok: true, value: { parts, owner } };
  }

  async #resolveOwned(ref: ResourceRef): Promise<ResolveOutcome> {
    const lookup = this.#lookup(ref);

    if (!lookup.ok) {
      return lookup;
    }

    const { parts, owner } = lookup.value;
    let descriptor: ResourceDescriptor | null | undefined;

    try {
      descriptor = await owner.adapter.resolve(ref);
    } catch (error) {
      this.#logFailure("resolve", parts.pluginId, parts.resourceType, error);

      return {
        ok: false,
        error: toErrorResult(
          createPluginError("INTERNAL_ERROR", "Адаптер ресурса не смог разрешить ресурс"),
        ),
      };
    }

    if (descriptor === null || descriptor === undefined) {
      return {
        ok: false,
        error: toErrorResult(createPluginError("NOT_FOUND", "Ресурс не найден")),
      };
    }

    const validation = validateResourceDescriptor(descriptor);

    if (!validation.ok) {
      this.#logFailureReason("resolve", parts.pluginId, parts.resourceType, "invalid_descriptor");

      return {
        ok: false,
        error: toErrorResult(
          createPluginError("INTERNAL_ERROR", "Адаптер ресурса вернул некорректные метаданные"),
        ),
      };
    }

    const value = validation.value;

    if (value.ref !== ref || value.resourceType !== parts.resourceType) {
      this.#logFailureReason("resolve", parts.pluginId, parts.resourceType, "descriptor_mismatch");

      return {
        ok: false,
        error: toErrorResult(
          createPluginError("INTERNAL_ERROR", "Адаптер ресурса вернул метаданные другого ресурса"),
        ),
      };
    }

    return { ok: true, value: { parts, owner, descriptor: value } };
  }

  #logFailure(
    operation: "resolve" | "canOpen" | "open",
    pluginId: PluginId,
    resourceType: ResourceType,
    error: unknown,
  ): void {
    if (this.#logger === undefined) {
      return;
    }

    this.#logger.warn("resource.adapter_failed", {
      operation,
      pluginId,
      resourceType,
      errorName: safeErrorName(error),
    });
  }

  #logFailureReason(
    operation: "resolve",
    pluginId: PluginId,
    resourceType: ResourceType,
    reason: "invalid_descriptor" | "descriptor_mismatch",
  ): void {
    if (this.#logger === undefined) {
      return;
    }

    const fields: LogFields = { operation, pluginId, resourceType, reason };

    this.#logger.warn("resource.adapter_failed", fields);
  }
}

type LookupOutcome =
  | {
      readonly ok: true;
      readonly value: { readonly parts: ParsedRef; readonly owner: RegisteredOwner };
    }
  | { readonly ok: false; readonly error: ErrorResult };

type ResolveOutcome =
  | {
      readonly ok: true;
      readonly value: {
        readonly parts: ParsedRef;
        readonly owner: RegisteredOwner;
        readonly descriptor: ResourceDescriptor;
      };
    }
  | { readonly ok: false; readonly error: ErrorResult };

interface ParsedRef {
  readonly pluginId: PluginId;
  readonly resourceType: ResourceType;
  readonly opaqueId: string;
}

interface RegisteredOwner {
  readonly pluginId: PluginId;
  readonly resourceTypes: ReadonlySet<ResourceType>;
  readonly adapter: ResourceAdapter;
}
