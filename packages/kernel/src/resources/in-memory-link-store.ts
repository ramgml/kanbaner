import type { Relation, ResourceLink, ResourceRef } from "@kanbaner/plugin-sdk";

import type { LinkStore, LinkStoreAddResult } from "./link-store.ts";

/**
 * In-memory реализация порта связей для тестов и локальной разработки.
 *
 * Данные живут только в памяти процесса и теряются при перезапуске. Это не
 * персистентное хранилище; Storage Provider реализует порт в KAN-006.
 */
export class InMemoryLinkStore implements LinkStore {
  readonly #links = new Map<string, ResourceLink>();

  async add(link: ResourceLink): Promise<LinkStoreAddResult> {
    const key = linkKey(link.sourceRef, link.targetRef, link.relation);
    const existing = this.#links.get(key);

    if (existing !== undefined) {
      return { inserted: false, link: cloneLink(existing) };
    }

    const stored = cloneLink(link);
    this.#links.set(key, stored);

    return { inserted: true, link: cloneLink(stored) };
  }

  async remove(
    sourceRef: ResourceRef,
    targetRef: ResourceRef,
    relation: Relation,
  ): Promise<boolean> {
    return this.#links.delete(linkKey(sourceRef, targetRef, relation));
  }

  async listByRef(ref: ResourceRef, relation?: Relation): Promise<readonly ResourceLink[]> {
    return [...this.#links.values()]
      .filter(
        (link) =>
          (link.sourceRef === ref || link.targetRef === ref) &&
          (relation === undefined || link.relation === relation),
      )
      .sort(compareLinks)
      .map(cloneLink);
  }

  async deleteByRef(ref: ResourceRef): Promise<number> {
    let removed = 0;

    for (const [key, link] of this.#links) {
      if (link.sourceRef === ref || link.targetRef === ref) {
        this.#links.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  /** Количество связей; удобно для проверок в тестах и диагностике. */
  size(): number {
    return this.#links.size;
  }
}

function linkKey(sourceRef: ResourceRef, targetRef: ResourceRef, relation: Relation): string {
  return JSON.stringify([sourceRef, targetRef, relation]);
}

function cloneLink(link: ResourceLink): ResourceLink {
  return link.createdAt === undefined
    ? {
        sourceRef: link.sourceRef,
        targetRef: link.targetRef,
        relation: link.relation,
      }
    : {
        sourceRef: link.sourceRef,
        targetRef: link.targetRef,
        relation: link.relation,
        createdAt: link.createdAt,
      };
}

function compareLinks(left: ResourceLink, right: ResourceLink): number {
  return (
    compareStrings(left.sourceRef, right.sourceRef) ||
    compareStrings(left.targetRef, right.targetRef) ||
    compareStrings(left.relation, right.relation)
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}
