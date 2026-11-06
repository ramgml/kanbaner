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

import { ResourceRegistryError, ResourceServiceError } from "./errors.ts";

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
 * Один плагин регистрируется один раз и сразу объявляет все свои типы.
 * Дубликат plugin ID или типа ресурса отклоняется до изменения состояния,
 * поэтому неудачная регистрация не оставляет частичных записей.
 */
export class ResourceRegistry {
  readonly #logger: PluginLogger | undefined;
  readonly #owners = new Map<PluginId, RegisteredOwner>();
  readonly #typeOwners = new Map<ResourceType, PluginId>();

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

    if (this.#owners.has(registration.pluginId)) {
      throw new ResourceRegistryError("DUPLICATE_OWNER", "Владелец ресурсов уже зарегистрирован");
    }

    for (const resourceType of resourceTypes) {
      if (this.#typeOwners.has(resourceType)) {
        throw new ResourceRegistryError(
          "DUPLICATE_RESOURCE_TYPE",
          "Тип ресурса уже зарегистрирован другим владельцем",
        );
      }
    }

    this.#owners.set(registration.pluginId, {
      pluginId: registration.pluginId,
      resourceTypes: new Set(resourceTypes),
      adapter,
    });

    for (const resourceType of resourceTypes) {
      this.#typeOwners.set(resourceType, registration.pluginId);
    }
  }

  hasOwner(pluginId: PluginId): boolean {
    return this.#owners.has(pluginId);
  }

  owns(pluginId: PluginId, resourceType: ResourceType): boolean {
    return this.#owners.get(pluginId)?.resourceTypes.has(resourceType) === true;
  }

  /** Возвращает владельца типа ресурса или `undefined`. */
  ownerOf(resourceType: ResourceType): PluginId | undefined {
    return this.#typeOwners.get(resourceType);
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
    const lookup = this.#lookup(ref);

    if (!lookup.ok) {
      return lookup.error;
    }

    const { parts, owner } = lookup.value;
    let descriptor: ResourceDescriptor | null | undefined;

    try {
      descriptor = await owner.adapter.resolve(ref);
    } catch (error) {
      this.#logFailure("resolve", parts.pluginId, parts.resourceType, error);

      return toErrorResult(
        createPluginError("INTERNAL_ERROR", "Адаптер ресурса не смог разрешить ресурс"),
      );
    }

    if (descriptor === null || descriptor === undefined) {
      return toErrorResult(createPluginError("NOT_FOUND", "Ресурс не найден"));
    }

    const validation = validateResourceDescriptor(descriptor);

    if (!validation.ok) {
      this.#logFailureReason("resolve", parts.pluginId, parts.resourceType, "invalid_descriptor");

      return toErrorResult(
        createPluginError("INTERNAL_ERROR", "Адаптер ресурса вернул некорректные метаданные"),
      );
    }

    const value = validation.value;

    if (value.ref !== ref || value.resourceType !== parts.resourceType) {
      this.#logFailureReason("resolve", parts.pluginId, parts.resourceType, "descriptor_mismatch");

      return toErrorResult(
        createPluginError("INTERNAL_ERROR", "Адаптер ресурса вернул метаданные другого ресурса"),
      );
    }

    return toSuccessResult(value);
  }

  /**
   * Проверяет, доступно ли открытие ресурса.
   *
   * Любая ошибка или неизвестный ресурс означают `false`: метод не бросает
   * исключений и не должен ломать страницу из-за недоступного адаптера.
   */
  async canOpen(ref: ResourceRef): Promise<boolean> {
    const lookup = this.#lookup(ref);

    if (!lookup.ok) {
      return false;
    }

    const { parts, owner } = lookup.value;

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
   * При ошибке бросает `ResourceServiceError` со стабильным кодом SDK:
   * `VALIDATION_ERROR`, `NOT_FOUND`, `PLUGIN_UNAVAILABLE` или `INTERNAL_ERROR`.
   */
  async open(ref: ResourceRef): Promise<void> {
    const lookup = this.#lookup(ref);

    if (!lookup.ok) {
      throw new ResourceServiceError(lookup.error.error.code, lookup.error.error.message);
    }

    const { parts, owner } = lookup.value;
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

  #lookup(ref: ResourceRef):
    | {
        readonly ok: true;
        readonly value: { readonly parts: ParsedRef; readonly owner: RegisteredOwner };
      }
    | { readonly ok: false; readonly error: ErrorResult } {
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
      errorName: error instanceof Error ? error.name : "UnknownError",
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
