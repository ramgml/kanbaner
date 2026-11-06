import { describe, expect, it } from "vitest";

import type {
  LogFields,
  PluginLogger,
  ResourceDescriptor,
  ResourceRef,
} from "@kanbaner/plugin-sdk";

import { ResourceRegistryError, ResourceServiceError } from "./errors.ts";
import { ResourceRegistry, type ResourceAdapter, type ResourceRegistration } from "./registry.ts";

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

class RecordingLogger implements PluginLogger {
  readonly entries: LogEntry[] = [];

  debug(message: string, fields?: LogFields): void {
    this.#record("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#record("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#record("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#record("error", message, fields);
  }

  #record(level: string, message: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields });
  }
}

const WIDGET_REF: ResourceRef = "acme.widgets:widget:01JWIDGET0000000000000001";
const OTHER_REF: ResourceRef = "acme.gadgets:gadget:01JGADGET0000000000000001";
const SECRET = "SUPERSECRET-RESOURCE-VALUE";

function createDescriptor(ref: ResourceRef, resourceType = "widget"): ResourceDescriptor {
  return { ref, resourceType, title: "Example resource" };
}

function createAdapter(overrides: Partial<ResourceAdapter> = {}): ResourceAdapter {
  return {
    resolve: (ref) => createDescriptor(ref),
    ...overrides,
  };
}

function register(
  registry: ResourceRegistry,
  pluginId: string,
  resourceTypes: readonly string[],
  adapter: ResourceAdapter = createAdapter(),
): void {
  const registration: ResourceRegistration = { pluginId, resourceTypes, adapter };

  registry.register(registration);
}

describe("ResourceRegistry registration", () => {
  it("регистрирует владельца и его типы ресурсов", () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget", "widget-template"]);

    expect(registry.hasOwner("acme.widgets")).toBe(true);
    expect(registry.owns("acme.widgets", "widget")).toBe(true);
    expect(registry.owns("acme.widgets", "other")).toBe(false);
    expect(registry.resourceTypesOf("acme.widgets")).toEqual(["widget", "widget-template"]);
  });

  it("защищает от повторной регистрации владельца", () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget"]);

    expect(() => register(registry, "acme.widgets", ["gadget"])).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_OWNER" }),
    );
    expect(registry.owns("acme.widgets", "widget")).toBe(true);
    expect(registry.owns("acme.widgets", "gadget")).toBe(false);
  });

  it("допускает одинаковый тип ресурса у разных владельцев", async () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget"], {
      resolve: (ref) => ({ ref, resourceType: "widget", title: "Widget" }),
    });
    register(registry, "acme.gadgets", ["widget"], {
      resolve: (ref) => ({ ref, resourceType: "widget", title: "Gadget" }),
    });

    expect(registry.hasOwner("acme.gadgets")).toBe(true);
    expect(registry.owns("acme.widgets", "widget")).toBe(true);
    expect(registry.owns("acme.gadgets", "widget")).toBe(true);

    await expect(registry.resolve(WIDGET_REF)).resolves.toMatchObject({
      ok: true,
      data: { title: "Widget", resourceType: "widget" },
    });
    await expect(
      registry.resolve("acme.gadgets:widget:01JGADGET0000000000000001"),
    ).resolves.toMatchObject({
      ok: true,
      data: { title: "Gadget", resourceType: "widget" },
    });
  });

  it("отклоняет некорректную регистрацию без частичных записей", () => {
    const registry = new ResourceRegistry();

    expect(() => register(registry, "broken", ["widget"])).toThrow(ResourceRegistryError);
    expect(() => register(registry, "acme.widgets", [])).toThrow(ResourceRegistryError);
    expect(() => register(registry, "acme.widgets", ["widget", "widget"])).toThrow(
      ResourceRegistryError,
    );
    expect(() => register(registry, "acme.widgets", ["Widget"])).toThrow(ResourceRegistryError);
    expect(() =>
      register(registry, "acme.widgets", ["widget"], {} as unknown as ResourceAdapter),
    ).toThrow(ResourceRegistryError);

    expect(registry.hasOwner("acme.widgets")).toBe(false);
    expect(registry.owns("acme.widgets", "widget")).toBe(false);
  });

  it.each([
    { label: "canOpen не функция", invalid: { canOpen: "yes" } },
    { label: "open не функция", invalid: { open: "yes" } },
    { label: "canOpen равен null", invalid: { canOpen: null } },
    { label: "open равен null", invalid: { open: null } },
  ])("отклоняет адаптер: $label, без частичной регистрации", ({ invalid }) => {
    const registry = new ResourceRegistry();
    const adapter = {
      resolve: (ref: ResourceRef) => createDescriptor(ref),
      ...invalid,
    } as unknown as ResourceAdapter;

    expect(() => register(registry, "acme.widgets", ["widget"], adapter)).toThrowError(
      expect.objectContaining({ code: "INVALID_REGISTRATION" }),
    );
    expect(registry.hasOwner("acme.widgets")).toBe(false);
    expect(registry.owns("acme.widgets", "widget")).toBe(false);
  });
});

describe("ResourceRegistry.resolve", () => {
  it("разрешает ссылку через адаптер владельца", async () => {
    const registry = new ResourceRegistry();
    let received: ResourceRef | undefined;

    register(registry, "acme.widgets", ["widget"], {
      resolve: (ref) => {
        received = ref;

        return createDescriptor(ref);
      },
    });

    const result = await registry.resolve(WIDGET_REF);

    expect(received).toBe(WIDGET_REF);
    expect(result).toEqual({
      ok: true,
      data: { ref: WIDGET_REF, resourceType: "widget", title: "Example resource" },
    });
  });

  it("возвращает NOT_FOUND для неизвестного plugin ID, типа и ресурса", async () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget"]);
    register(registry, "acme.gadgets", ["gadget"], {
      resolve: () => null,
    });

    const unknownPlugin = await registry.resolve("acme.unknown:widget:01JUNKNOWN000000000000001");
    const unknownType = await registry.resolve("acme.widgets:unknown:01JUNKNOWN000000000000002");
    const missing = await registry.resolve(OTHER_REF);

    expect(unknownPlugin).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(unknownType).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("трактует undefined от адаптера как NOT_FOUND", async () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget"], {
      resolve: () => undefined,
    });

    await expect(registry.resolve(WIDGET_REF)).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("возвращает VALIDATION_ERROR для некорректной ссылки", async () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget"]);

    await expect(registry.resolve("not-a-resource-ref")).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("изолирует ошибку адаптера и не пишет секреты в журнал", async () => {
    const logger = new RecordingLogger();
    const registry = new ResourceRegistry({ logger });

    register(registry, "acme.widgets", ["widget"], {
      resolve: () => {
        throw new Error(`adapter failed with ${SECRET}`);
      },
    });

    const result = await registry.resolve(WIDGET_REF);

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.fields).toMatchObject({
      operation: "resolve",
      pluginId: "acme.widgets",
      resourceType: "widget",
      errorName: "Error",
    });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("не журналирует произвольный error.name", async () => {
    const logger = new RecordingLogger();
    const registry = new ResourceRegistry({ logger });
    const error = new Error("adapter failed");

    error.name = SECRET;

    register(registry, "acme.widgets", ["widget"], {
      resolve: () => {
        throw error;
      },
    });

    await registry.resolve(WIDGET_REF);

    expect(logger.entries[0]?.fields?.errorName).toBe("Error");
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("отклоняет некорректные или чужие метаданные адаптера", async () => {
    const logger = new RecordingLogger();
    const registry = new ResourceRegistry({ logger });

    register(registry, "acme.widgets", ["widget"], {
      resolve: (ref) => ({ ref, resourceType: "widget", title: "" }),
    });
    register(registry, "acme.gadgets", ["gadget"], {
      resolve: () => createDescriptor(WIDGET_REF, "widget"),
    });

    await expect(registry.resolve(WIDGET_REF)).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    await expect(registry.resolve(OTHER_REF)).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(logger.entries).toHaveLength(2);
    expect(logger.entries[0]?.fields?.reason).toBe("invalid_descriptor");
    expect(logger.entries[1]?.fields?.reason).toBe("descriptor_mismatch");
  });

  it("не изменяет состояние при resolve", async () => {
    const registry = new ResourceRegistry();
    const calls = { resolve: 0, canOpen: 0, open: 0 };
    const adapter: ResourceAdapter = {
      resolve: (ref) => {
        calls.resolve += 1;

        return createDescriptor(ref);
      },
      canOpen: () => {
        calls.canOpen += 1;

        return true;
      },
      open: () => {
        calls.open += 1;
      },
    };

    register(registry, "acme.widgets", ["widget"], adapter);

    const before = registry.resourceTypesOf("acme.widgets");
    const first = await registry.resolve(WIDGET_REF);
    const second = await registry.resolve(WIDGET_REF);

    expect(first).toEqual(second);
    expect(calls).toEqual({ resolve: 2, canOpen: 0, open: 0 });
    expect(registry.resourceTypesOf("acme.widgets")).toEqual(before);
    expect(registry.owns("acme.widgets", "widget")).toBe(true);
  });
});

describe("ResourceRegistry.canOpen и open", () => {
  it("возвращает canOpen адаптера и безопасный false при ошибке", async () => {
    const logger = new RecordingLogger();
    const registry = new ResourceRegistry({ logger });

    register(registry, "acme.widgets", ["widget"], {
      resolve: (ref) => createDescriptor(ref),
      canOpen: () => true,
      open: () => undefined,
    });
    register(registry, "acme.gadgets", ["gadget"], {
      resolve: (ref) => createDescriptor(ref, "gadget"),
      canOpen: () => {
        throw new Error(`canOpen failed ${SECRET}`);
      },
    });

    await expect(registry.canOpen(WIDGET_REF)).resolves.toBe(true);
    await expect(registry.canOpen(OTHER_REF)).resolves.toBe(false);
    await expect(registry.canOpen("acme.unknown:widget:x")).resolves.toBe(false);
    await expect(registry.canOpen("broken")).resolves.toBe(false);
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("не вызывает canOpen/open для отсутствующего ресурса", async () => {
    const registry = new ResourceRegistry();
    const calls = { canOpen: 0, open: 0 };

    register(registry, "acme.widgets", ["widget"], {
      resolve: () => null,
      canOpen: () => {
        calls.canOpen += 1;

        return true;
      },
      open: () => {
        calls.open += 1;
      },
    });

    await expect(registry.canOpen(WIDGET_REF)).resolves.toBe(false);
    await expect(registry.open(WIDGET_REF)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toEqual({ canOpen: 0, open: 0 });
  });

  it("по умолчанию разрешает открытие, если адаптер реализует open", async () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget"], {
      resolve: (ref) => createDescriptor(ref),
      open: () => undefined,
    });

    await expect(registry.canOpen(WIDGET_REF)).resolves.toBe(true);
  });

  it("открывает ресурс через адаптер владельца", async () => {
    const registry = new ResourceRegistry();
    let opened: ResourceRef | undefined;

    register(registry, "acme.widgets", ["widget"], {
      resolve: (ref) => createDescriptor(ref),
      open: (ref) => {
        opened = ref;
      },
    });

    await registry.open(WIDGET_REF);

    expect(opened).toBe(WIDGET_REF);
  });

  it("возвращает стабильные коды ошибок open", async () => {
    const registry = new ResourceRegistry();

    register(registry, "acme.widgets", ["widget"], {
      resolve: (ref) => createDescriptor(ref),
    });
    register(registry, "acme.gadgets", ["gadget"], {
      resolve: (ref) => createDescriptor(ref, "gadget"),
      open: () => {
        throw new Error(SECRET);
      },
    });

    await expect(registry.open("broken")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(registry.open("acme.unknown:widget:x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(registry.open(WIDGET_REF)).rejects.toMatchObject({ code: "PLUGIN_UNAVAILABLE" });
    await expect(registry.open(OTHER_REF)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("отдаёт ResourceServiceError с конвертом результата", () => {
    const error = new ResourceServiceError("NOT_FOUND", "Ресурс не найден");

    expect(error).toBeInstanceOf(Error);
    expect(error.toResult()).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", retryable: false },
    });
  });
});
