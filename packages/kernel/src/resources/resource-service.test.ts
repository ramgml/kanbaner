import { describe, expect, it } from "vitest";

import type { ResourceDescriptor, ResourceRef, ResourceService } from "@kanbaner/plugin-sdk";

import { InMemoryLinkStore } from "./in-memory-link-store.ts";
import { LinkService } from "./link-service.ts";
import { KernelResourceService } from "./resource-service.ts";
import { ResourceRegistry, type ResourceAdapter } from "./registry.ts";

const WIDGET_REF: ResourceRef = "acme.widgets:widget:01JWIDGET0000000000000001";
const GADGET_REF: ResourceRef = "acme.gadgets:gadget:01JGADGET0000000000000001";
const RELATION = "acme.links.relates";

function createDescriptor(ref: ResourceRef, resourceType: string): ResourceDescriptor {
  return { ref, resourceType, title: "Example resource" };
}

describe("KernelResourceService", () => {
  it("реализует SDK ResourceService через реестр и LinkService", async () => {
    const registry = new ResourceRegistry();
    const widgetAdapter: ResourceAdapter = {
      resolve: (ref) => createDescriptor(ref, "widget"),
      canOpen: (ref) => ref === WIDGET_REF,
      open: () => undefined,
    };
    const gadgetAdapter: ResourceAdapter = {
      resolve: (ref) => createDescriptor(ref, "gadget"),
    };

    registry.register({
      pluginId: "acme.widgets",
      resourceTypes: ["widget"],
      adapter: widgetAdapter,
    });
    registry.register({
      pluginId: "acme.gadgets",
      resourceTypes: ["gadget"],
      adapter: gadgetAdapter,
    });

    const store = new InMemoryLinkStore();
    const links = new LinkService({ store });
    const service: ResourceService = new KernelResourceService({ registry, links });

    const link = await service.link(WIDGET_REF, GADGET_REF, RELATION);
    const listed = await service.list(WIDGET_REF);
    const resolved = await service.resolve(WIDGET_REF);

    expect(link.sourceRef).toBe(WIDGET_REF);
    expect(listed).toEqual([link]);
    expect(resolved).toEqual({
      ok: true,
      data: { ref: WIDGET_REF, resourceType: "widget", title: "Example resource" },
    });
    await expect(service.canOpen(WIDGET_REF)).resolves.toBe(true);
    await expect(service.canOpen(GADGET_REF)).resolves.toBe(false);
    await service.open(WIDGET_REF);
    await service.unlink(WIDGET_REF, GADGET_REF, RELATION);
    await expect(service.list(WIDGET_REF)).resolves.toEqual([]);
  });

  it("возвращает NOT_FOUND и очищает связи через cleanup", async () => {
    const registry = new ResourceRegistry();
    const adapter: ResourceAdapter = { resolve: (ref) => createDescriptor(ref, "widget") };

    registry.register({ pluginId: "acme.widgets", resourceTypes: ["widget"], adapter });

    const service = new KernelResourceService({
      registry,
      links: new LinkService({ store: new InMemoryLinkStore() }),
    });

    await expect(service.resolve("acme.unknown:widget:x")).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await service.link(WIDGET_REF, GADGET_REF, RELATION);
    await expect(service.cleanup(WIDGET_REF)).resolves.toBe(1);
    await expect(service.list(WIDGET_REF)).resolves.toEqual([]);
  });
});
