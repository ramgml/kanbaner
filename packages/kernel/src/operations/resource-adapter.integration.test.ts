import type { OperationResult, ResourceRef, ResourceService } from "@kanbaner/plugin-sdk";
import { describe, expect, it } from "vitest";

import {
  InMemoryLinkStore,
  KernelResourceService,
  LinkService,
  ResourceRegistry,
  ResourceServiceError,
  type ResourceAdapter,
} from "../resources/index.ts";
import { createOperationBus } from "./bus.ts";
import { OperationFailure } from "./errors.ts";
import { adaptResourceServiceErrors, type ResourceErrorMapper } from "./resource-adapter.ts";
import { commandMetadata } from "./test-fixtures.ts";

const WIDGET_REF: ResourceRef = "acme.widgets:widget:01JWIDGET0000000000000001";
const GADGET_REF: ResourceRef = "acme.gadgets:gadget:01JGADGET0000000000000001";
const MISSING_REF: ResourceRef = "acme.widgets:widget:missing";
const RELATION = "acme.links.relates";

const mapResourceError: ResourceErrorMapper = (error) =>
  error instanceof ResourceServiceError
    ? new OperationFailure(error.code, error.message, { retryable: error.retryable })
    : undefined;

function createKernelResourceService(): ResourceService {
  const registry = new ResourceRegistry();
  const widgetAdapter: ResourceAdapter = {
    resolve: (ref) =>
      ref === WIDGET_REF ? { ref, resourceType: "widget", title: "Widget" } : null,
  };
  const gadgetAdapter: ResourceAdapter = {
    resolve: (ref) => ({ ref, resourceType: "gadget", title: "Gadget" }),
    open: () => undefined,
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

  return new KernelResourceService({
    registry,
    links: new LinkService({ store: new InMemoryLinkStore() }),
  });
}

async function executeResourceAction(
  service: ResourceService,
  action: (resources: ResourceService) => Promise<unknown>,
): Promise<OperationResult<unknown>> {
  const bus = createOperationBus({
    resources: adaptResourceServiceErrors(service, mapResourceError),
  });

  bus.registerCommand({
    metadata: commandMetadata(),
    handler: async (_input, context) => {
      await action(context.resources);

      return {};
    },
  });

  return bus.executeCommand("test.tasks.create", { title: "x" });
}

describe("адаптер ошибок ResourceService для шины операций", () => {
  it("сохраняет успешный link через реальный KernelResourceService", async () => {
    const service = createKernelResourceService();

    const result = await executeResourceAction(service, (resources) =>
      resources.link(WIDGET_REF, GADGET_REF, RELATION),
    );

    expect(result).toEqual({ ok: true, data: {} });
  });

  it("преобразует VALIDATION_ERROR при неверной ссылке в link", async () => {
    const service = createKernelResourceService();

    const result = await executeResourceAction(service, (resources) =>
      resources.link("not-a-ref", GADGET_REF, RELATION),
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("преобразует NOT_FOUND при открытии отсутствующего ресурса", async () => {
    const service = createKernelResourceService();

    const result = await executeResourceAction(service, (resources) => resources.open(MISSING_REF));

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("преобразует PLUGIN_UNAVAILABLE при отсутствии open у адаптера", async () => {
    const service = createKernelResourceService();

    const result = await executeResourceAction(service, (resources) => resources.open(WIDGET_REF));

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("PLUGIN_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("сохраняет успешный open через реальный KernelResourceService", async () => {
    const service = createKernelResourceService();

    const result = await executeResourceAction(service, (resources) => resources.open(GADGET_REF));

    expect(result).toEqual({ ok: true, data: {} });
  });

  it("не доверяет структурным code/message произвольного исключения", async () => {
    const forged = { code: "NOT_FOUND", message: "forged /internal/path", retryable: false };
    const service: ResourceService = {
      link: () => Promise.reject(forged),
      unlink: () => Promise.reject(forged),
      list: () => Promise.reject(forged),
      resolve: () => Promise.reject(forged),
      canOpen: () => Promise.reject(forged),
      open: () => Promise.reject(forged),
    };

    const result = await executeResourceAction(service, (resources) =>
      resources.link(WIDGET_REF, GADGET_REF, RELATION),
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.message).toBe("Внутренняя ошибка операции");
    }

    expect(JSON.stringify(result)).not.toContain("forged");
    expect(JSON.stringify(result)).not.toContain("/internal/path");
  });
});
