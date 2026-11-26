import { describe, expect, it } from "vitest";

import type { EventEnvelope, LogFields, PluginLogger } from "@kanbaner/plugin-sdk";

import { EventBus } from "./event-bus.ts";

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

function createEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: "01KEVENT000000000000000001",
    type: "acme.widgets.widget.created",
    contractVersion: 1,
    source: "acme.widgets",
    occurredAt: "2026-11-06T12:00:00Z",
    resource: "acme.widgets:widget:01JRESOURCE0000000000001",
    payload: { changed: ["title"] },
    ...overrides,
  };
}

function createBus(): { bus: EventBus; logger: RecordingLogger } {
  const logger = new RecordingLogger();

  return { bus: new EventBus({ logger }), logger };
}

describe("EventBus subscriptions", () => {
  it("доставляет событие точной подписке", async () => {
    const { bus } = createBus();
    const received: string[] = [];

    bus.subscribe(
      "acme.widgets.widget.created",
      (event) => {
        received.push(event.eventId);
      },
      { pluginId: "acme.consumer" },
    );

    const result = await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-1" });

    expect(received).toEqual(["01KEVENT000000000000000001"]);
    expect(result).toEqual({
      status: "accepted",
      eventId: "01KEVENT000000000000000001",
      matchedSubscribers: 1,
      failedSubscribers: 0,
    });
  });

  it("не вызывает подписчика при несовпадении типа", async () => {
    const { bus } = createBus();
    let calls = 0;

    bus.subscribe(
      "acme.widgets.widget.updated",
      () => {
        calls += 1;
      },
      { pluginId: "acme.consumer" },
    );

    const result = await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-1" });

    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: "accepted", matchedSubscribers: 0 });
  });

  it("поддерживает wildcard в конце сегментов и границу сегментов", async () => {
    const { bus } = createBus();
    const calls: string[] = [];

    bus.subscribe(
      "acme.*",
      () => {
        calls.push("namespace");
      },
      { pluginId: "acme.consumer" },
    );
    bus.subscribe(
      "acme.widgets.*",
      () => {
        calls.push("plugin");
      },
      { pluginId: "acme.consumer" },
    );
    bus.subscribe(
      "acme.widgets.widget.*",
      () => {
        calls.push("resource");
      },
      {
        pluginId: "acme.consumer",
      },
    );
    bus.subscribe(
      "acme.widget-list.*",
      () => {
        calls.push("wrong-prefix");
      },
      {
        pluginId: "acme.consumer",
      },
    );

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-1" });

    expect(calls.sort()).toEqual(["namespace", "plugin", "resource"]);
  });

  it("не принимает wildcard в середине, частичный wildcard и одиночный *", () => {
    const { bus } = createBus();

    expect(() =>
      bus.subscribe("acme.*.widget.created", () => undefined, {
        pluginId: "acme.consumer",
      }),
    ).toThrow(TypeError);
    expect(() =>
      bus.subscribe("acme.widget*", () => undefined, {
        pluginId: "acme.consumer",
      }),
    ).toThrow(TypeError);
    expect(() => bus.subscribe("*", () => undefined, { pluginId: "acme.consumer" })).toThrow(
      TypeError,
    );
  });

  it("разрешает подписку на неизвестный точный тип события", async () => {
    const { bus } = createBus();
    let calls = 0;

    expect(() =>
      bus.subscribe(
        "acme.unknown.thing.happened",
        () => {
          calls += 1;
        },
        { pluginId: "acme.consumer" },
      ),
    ).not.toThrow();

    await bus.publishAfterCommit(
      createEnvelope({
        eventId: "01KEVENT000000000000000002",
        type: "acme.unknown.thing.happened",
        source: "acme.unknown",
        resource: "acme.unknown:thing:01JRESOURCE0000000000002",
      }),
      { traceId: "trace-1" },
    );

    expect(calls).toBe(1);
  });

  it("проверяет plugin ID и обработчик подписки", () => {
    const { bus } = createBus();

    expect(() =>
      bus.subscribe("acme.widgets.widget.created", () => undefined, { pluginId: "broken" }),
    ).toThrow(TypeError);
    expect(() =>
      bus.subscribe("acme.widgets.widget.created", undefined as unknown as () => void, {
        pluginId: "acme.consumer",
      }),
    ).toThrow(TypeError);
  });

  it("идемпотентно отменяет подписку", async () => {
    const { bus } = createBus();
    let calls = 0;
    const unsubscribe = bus.subscribe(
      "acme.widgets.widget.created",
      () => {
        calls += 1;
      },
      { pluginId: "acme.consumer" },
    );

    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-1" });

    expect(calls).toBe(0);
  });

  it("не публикует событие автоматически при регистрации подписки", () => {
    const { bus } = createBus();
    let calls = 0;

    bus.subscribe(
      "acme.widgets.widget.created",
      () => {
        calls += 1;
      },
      { pluginId: "acme.consumer" },
    );

    expect(calls).toBe(0);
  });
});
