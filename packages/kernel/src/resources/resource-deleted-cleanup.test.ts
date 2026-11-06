import { describe, expect, it } from "vitest";

import type { EventEnvelope, LogFields, PluginLogger, ResourceRef } from "@kanbaner/plugin-sdk";

import { EventBus } from "../events/index.ts";
import { InMemoryLinkStore } from "./in-memory-link-store.ts";
import { LinkService } from "./link-service.ts";
import {
  createResourceDeletedHandler,
  isResourceDeletedEvent,
  subscribeResourceDeletedCleanup,
} from "./resource-deleted-cleanup.ts";

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

const SOURCE: ResourceRef = "acme.widgets:widget:01JWIDGET0000000000000001";
const TARGET: ResourceRef = "acme.gadgets:gadget:01JGADGET0000000000000001";
const OTHER: ResourceRef = "acme.widgets:widget:01JWIDGET0000000000000002";
const RELATION = "acme.links.relates";
const SECRET = "SUPERSECRET-CLEANUP-VALUE";

function createEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: "01KEVENT000000000000000001",
    type: "acme.gadgets.gadget.deleted",
    contractVersion: 1,
    source: "acme.gadgets",
    occurredAt: "2026-11-06T12:00:00Z",
    resource: TARGET,
    payload: {},
    ...overrides,
  };
}

describe("resource deleted cleanup", () => {
  it("распознаёт контрактное действие deleted без доменных типов", () => {
    expect(isResourceDeletedEvent("acme.gadgets.gadget.deleted")).toBe(true);
    expect(isResourceDeletedEvent("acme.gadgets.gadget.updated")).toBe(false);
  });

  it("удаляет связи ресурса по событию удаления через wildcard-подписку", async () => {
    const logger = new RecordingLogger();
    const bus = new EventBus({ logger });
    const store = new InMemoryLinkStore();
    const links = new LinkService({ store });

    await links.link(SOURCE, TARGET, RELATION);
    await links.link(OTHER, SOURCE, RELATION);

    subscribeResourceDeletedCleanup(bus, links, ["acme.*"], { pluginId: "kanbaner.kernel" });

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-deleted" });

    await expect(links.list(TARGET)).resolves.toEqual([]);
    expect(store.size()).toBe(1);
  });

  it("не очищает связи на событие другого действия", async () => {
    const logger = new RecordingLogger();
    const bus = new EventBus({ logger });
    const store = new InMemoryLinkStore();
    const links = new LinkService({ store });

    await links.link(SOURCE, TARGET, RELATION);

    subscribeResourceDeletedCleanup(bus, links, ["acme.*"], { pluginId: "kanbaner.kernel" });

    await bus.publishAfterCommit(
      createEnvelope({
        type: "acme.gadgets.gadget.updated",
        eventId: "01KEVENT000000000000000002",
      }),
      { traceId: "trace-updated" },
    );

    expect(store.size()).toBe(1);
  });

  it("изолирует ошибку очистки и не мешает другим подписчикам", async () => {
    const logger = new RecordingLogger();
    const bus = new EventBus({ logger });
    let otherCalls = 0;

    bus.subscribe(
      "acme.gadgets.gadget.deleted",
      () => {
        otherCalls += 1;
      },
      { pluginId: "kanbaner.search" },
    );
    bus.subscribe(
      "acme.gadgets.gadget.deleted",
      createResourceDeletedHandler({
        cleanup: () => {
          throw new Error(SECRET);
        },
      }),
      { pluginId: "kanbaner.kernel" },
    );

    const result = await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-failed" });

    expect(otherCalls).toBe(1);
    expect(result).toMatchObject({ status: "accepted", failedSubscribers: 1 });
    expect(logger.entries[0]?.fields).toMatchObject({
      eventId: "01KEVENT000000000000000001",
      pluginId: "kanbaner.kernel",
      traceId: "trace-failed",
    });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("откатывает уже созданные подписки при ошибке шаблона", async () => {
    const logger = new RecordingLogger();
    const bus = new EventBus({ logger });
    const store = new InMemoryLinkStore();
    const links = new LinkService({ store });

    await links.link(SOURCE, TARGET, RELATION);

    expect(() =>
      subscribeResourceDeletedCleanup(bus, links, ["acme.*", "bad*"], {
        pluginId: "kanbaner.kernel",
      }),
    ).toThrow(TypeError);

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-rollback" });

    expect(store.size()).toBe(1);

    const unsubscribe = subscribeResourceDeletedCleanup(bus, links, ["acme.*"], {
      pluginId: "kanbaner.kernel",
    });

    await bus.publishAfterCommit(createEnvelope({ eventId: "01KEVENT000000000000000002" }), {
      traceId: "trace-reinstall",
    });

    expect(store.size()).toBe(0);
    unsubscribe();
  });

  it("идемпотентно снимает wildcard-подписки", () => {
    const logger = new RecordingLogger();
    const bus = new EventBus({ logger });
    const links = new LinkService({ store: new InMemoryLinkStore() });
    const unsubscribe = subscribeResourceDeletedCleanup(bus, links, ["acme.*", "other.*"], {
      pluginId: "kanbaner.kernel",
    });

    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);
  });
});
