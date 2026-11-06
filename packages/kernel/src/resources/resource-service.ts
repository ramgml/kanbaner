import type {
  OperationResult,
  Relation,
  ResourceDescriptor,
  ResourceLink,
  ResourceRef,
  ResourceService,
} from "@kanbaner/plugin-sdk";

import type { LinkService } from "./link-service.ts";
import type { ResourceRegistry } from "./registry.ts";

export interface ResourceServiceOptions {
  readonly registry: ResourceRegistry;
  readonly links: LinkService;
}

/**
 * Реализация SDK `ResourceService` поверх реестра владельцев и LinkService.
 *
 * `resolve`, `canOpen` и `open` всегда идут только через адаптер плагина,
 * указанного в `ResourceRef`. Доменных типов сервис не содержит.
 */
export class KernelResourceService implements ResourceService {
  readonly #registry: ResourceRegistry;
  readonly #links: LinkService;

  constructor(options: ResourceServiceOptions) {
    this.#registry = options.registry;
    this.#links = options.links;
  }

  link(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<ResourceLink> {
    return this.#links.link(sourceRef, targetRef, relation);
  }

  unlink(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): Promise<void> {
    return this.#links.unlink(sourceRef, targetRef, relation);
  }

  list(ref: ResourceRef, relation?: Relation): Promise<readonly ResourceLink[]> {
    return this.#links.list(ref, relation);
  }

  resolve(ref: ResourceRef): Promise<OperationResult<ResourceDescriptor>> {
    return this.#registry.resolve(ref);
  }

  canOpen(ref: ResourceRef): Promise<boolean> {
    return this.#registry.canOpen(ref);
  }

  open(ref: ResourceRef): Promise<void> {
    return this.#registry.open(ref);
  }

  /** Удаляет все связи ресурса; вызывается подписчиком на `*.deleted`. */
  cleanup(ref: ResourceRef): Promise<number> {
    return this.#links.cleanup(ref);
  }
}
