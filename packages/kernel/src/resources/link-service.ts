import {
  validateRelation,
  validateResourceRef,
  type LogFields,
  type PluginLogger,
  type Relation,
  type ResourceLink,
  type ResourceRef,
} from "@kanbaner/plugin-sdk";

import { ResourceServiceError, safeErrorName } from "./errors.ts";
import type { LinkStore } from "./link-store.ts";

export interface LinkServiceOptions {
  readonly store: LinkStore;
  /** Необязательный логгер безопасной диагностики ошибок store. */
  readonly logger?: PluginLogger;
  /** Источник времени UTC; в тестах можно подменить. */
  readonly now?: () => Date;
}

/**
 * Универсальные связи между `ResourceRef`.
 *
 * Сервис не знает доменных типов и не создаёт внешних ключей между данными
 * плагинов. Уникальность тройки source/target/relation обеспечивает store;
 * повторный `link` идемпотентно возвращает существующую связь. `unlink` и
 * `cleanup` идемпотентны.
 */
export class LinkService {
  readonly #store: LinkStore;
  readonly #logger: PluginLogger | undefined;
  readonly #now: () => Date;

  constructor(options: LinkServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  /** Создаёт связь или возвращает уже существующую. */
  async link(
    sourceRef: ResourceRef,
    targetRef: ResourceRef,
    relation: Relation,
  ): Promise<ResourceLink> {
    this.#assertRef(sourceRef);
    this.#assertRef(targetRef);
    this.#assertRelation(relation);

    const link: ResourceLink = {
      sourceRef,
      targetRef,
      relation,
      createdAt: this.#timestamp(),
    };

    try {
      const result = await this.#store.add(link);

      return result.link;
    } catch (error) {
      throw this.#storeError("link", error);
    }
  }

  /** Удаляет связь; отсутствующая связь не является ошибкой. */
  async unlink(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<void> {
    this.#assertRef(sourceRef);
    this.#assertRef(targetRef);
    this.#assertRelation(relation);

    try {
      await this.#store.remove(sourceRef, targetRef, relation);
    } catch (error) {
      throw this.#storeError("unlink", error);
    }
  }

  /** Возвращает связи, где ref является source или target. */
  async list(ref: ResourceRef, relation?: Relation): Promise<readonly ResourceLink[]> {
    this.#assertRef(ref);

    if (relation !== undefined) {
      this.#assertRelation(relation);
    }

    try {
      return await this.#store.listByRef(ref, relation);
    } catch (error) {
      throw this.#storeError("list", error);
    }
  }

  /**
   * Удаляет все связи с указанным ресурсом с обеих сторон.
   *
   * Возвращает количество удалённых связей. Используется подписчиком на
   * событие удаления ресурса; доменные типы не нужны.
   */
  async cleanup(ref: ResourceRef): Promise<number> {
    this.#assertRef(ref);

    try {
      return await this.#store.deleteByRef(ref);
    } catch (error) {
      throw this.#storeError("cleanup", error);
    }
  }

  #assertRef(ref: ResourceRef): void {
    if (!validateResourceRef(ref).ok) {
      throw new ResourceServiceError("VALIDATION_ERROR", "Некорректная ссылка на ресурс");
    }
  }

  #assertRelation(relation: Relation): void {
    if (!validateRelation(relation).ok) {
      throw new ResourceServiceError("VALIDATION_ERROR", "Некорректный тип связи");
    }
  }

  #timestamp(): string {
    const date = this.#now();

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new ResourceServiceError("INTERNAL_ERROR", "Не удалось получить время создания связи");
    }

    return date.toISOString();
  }

  #storeError(
    operation: "link" | "unlink" | "list" | "cleanup",
    error: unknown,
  ): ResourceServiceError {
    if (this.#logger !== undefined) {
      const fields: LogFields = {
        operation,
        errorName: safeErrorName(error),
      };

      this.#logger.error("resource.link_store_failed", fields);
    }

    return new ResourceServiceError("INTERNAL_ERROR", "Операция со связями не выполнена");
  }
}
