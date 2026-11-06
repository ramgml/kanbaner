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

const SECRET = "SUPERSECRET-PAYLOAD-VALUE";

function createEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: "01KEVENT000000000000000001",
    type: "acme.widgets.widget.updated",
    contractVersion: 1,
    source: "acme.widgets",
    occurredAt: "2026-11-06T12:00:00Z",
    resource: "acme.widgets:widget:01JRESOURCE0000000000001",
    payload: { changed: ["title"] },
    ...overrides,
  };
}

function createBus(maxTrackedEventIds?: number): { bus: EventBus; logger: RecordingLogger } {
  const logger = new RecordingLogger();
  const bus =
    maxTrackedEventIds === undefined
      ? new EventBus({ logger })
      : new EventBus({ logger, maxTrackedEventIds });

  return { bus, logger };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

describe("EventBus.publishAfterCommit", () => {
  it("передаёт конверт и traceId подписчику только после явного вызова", async () => {
    const { bus } = createBus();
    const received: { event: EventEnvelope; traceId: string }[] = [];

    bus.subscribe(
      "acme.widgets.widget.updated",
      (event, context) => {
        received.push({ event, traceId: context.traceId });
      },
      { pluginId: "acme.consumer" },
    );

    expect(received).toHaveLength(0);

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-explicit" });

    expect(received).toHaveLength(1);
    expect(received[0]?.event.type).toBe("acme.widgets.widget.updated");
    expect(received[0]?.traceId).toBe("trace-explicit");
  });

  it("дожидается асинхронных подписчиков", async () => {
    const { bus } = createBus();
    let completed = false;

    bus.subscribe(
      "acme.widgets.widget.updated",
      async () => {
        await Promise.resolve();
        completed = true;
      },
      { pluginId: "acme.consumer" },
    );

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-async" });

    expect(completed).toBe(true);
  });

  it("отклоняет некорректный конверт без доставки и без payload в журнале", async () => {
    const { bus, logger } = createBus();
    let calls = 0;

    bus.subscribe(
      "acme.widgets.widget.updated",
      () => {
        calls += 1;
      },
      { pluginId: "acme.consumer" },
    );

    const invalid = {
      ...createEnvelope(),
      type: "not-an-event-type",
      payload: { secret: SECRET },
    } as unknown as EventEnvelope;

    const result = await bus.publishAfterCommit(invalid, { traceId: "trace-invalid" });

    expect(result.status).toBe("invalid");
    expect(calls).toBe(0);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: "warn",
      message: "event.envelope_invalid",
      fields: { traceId: "trace-invalid" },
    });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("не доставляет повторный eventId и сообщает duplicate", async () => {
    const { bus } = createBus();
    let calls = 0;

    bus.subscribe(
      "acme.widgets.widget.updated",
      () => {
        calls += 1;
      },
      { pluginId: "acme.consumer" },
    );

    const event = createEnvelope();

    const first = await bus.publishAfterCommit(event, { traceId: "trace-1" });
    const second = await bus.publishAfterCommit(event, { traceId: "trace-1" });

    expect(first.status).toBe("accepted");
    expect(second).toEqual({ status: "duplicate", eventId: event.eventId });
    expect(calls).toBe(1);
  });

  it("доставляет события с разными eventId независимо", async () => {
    const { bus } = createBus();
    let calls = 0;

    bus.subscribe(
      "acme.widgets.*",
      () => {
        calls += 1;
      },
      { pluginId: "acme.consumer" },
    );

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-1" });
    await bus.publishAfterCommit(createEnvelope({ eventId: "01KEVENT000000000000000002" }), {
      traceId: "trace-1",
    });

    expect(calls).toBe(2);
  });

  it("изолирует ошибку подписчика, продолжает доставку и пишет безопасные поля", async () => {
    const { bus, logger } = createBus();
    let healthyCalls = 0;
    const event = createEnvelope({ payload: { secret: SECRET } });

    bus.subscribe(
      "acme.widgets.widget.updated",
      () => {
        throw new Error(`сломалось на ${SECRET}`);
      },
      { pluginId: "acme.consumer" },
    );

    bus.subscribe(
      "acme.widgets.widget.updated",
      () => {
        healthyCalls += 1;
      },
      { pluginId: "acme.observer" },
    );

    const result = await bus.publishAfterCommit(event, { traceId: "trace-errors" });

    expect(result).toEqual({
      status: "accepted",
      eventId: event.eventId,
      matchedSubscribers: 2,
      failedSubscribers: 1,
    });
    expect(healthyCalls).toBe(1);

    const errorEntry = logger.entries.find((entry) => entry.message === "event.subscriber_failed");

    expect(errorEntry?.level).toBe("error");
    expect(errorEntry?.fields).toMatchObject({
      eventId: event.eventId,
      eventType: event.type,
      pluginId: "acme.consumer",
      traceId: "trace-errors",
    });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
    expect(JSON.stringify(logger.entries)).not.toContain("payload");
  });

  it("изолирует синхронное исключение и ошибку не-Error значения", async () => {
    const { bus, logger } = createBus();

    bus.subscribe(
      "acme.widgets.widget.updated",
      () => {
        throw "не Error";
      },
      { pluginId: "acme.consumer" },
    );

    const result = await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-1" });

    expect(result).toMatchObject({ status: "accepted", failedSubscribers: 1 });
    expect(logger.entries[0]?.fields?.errorName).toBe("UnknownError");
  });

  it("не журналирует произвольный error.name", async () => {
    const { bus, logger } = createBus();
    const error = new Error("boom");

    error.name = SECRET;

    bus.subscribe(
      "acme.widgets.widget.updated",
      () => {
        throw error;
      },
      { pluginId: "acme.consumer" },
    );

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-name" });

    expect(logger.entries[0]?.fields?.errorName).toBe("Error");
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("дедуплицирует два одновременных publishAfterCommit", async () => {
    const { bus } = createBus();
    const gate = createDeferred();
    const event = createEnvelope();
    let calls = 0;

    bus.subscribe(
      "acme.widgets.widget.updated",
      async () => {
        calls += 1;
        await gate.promise;
      },
      { pluginId: "acme.consumer" },
    );

    const first = bus.publishAfterCommit(event, { traceId: "trace-race" });
    const second = bus.publishAfterCommit(event, { traceId: "trace-race" });
    const secondResult = await second;

    expect(secondResult).toEqual({ status: "duplicate", eventId: event.eventId });
    expect(calls).toBe(1);

    gate.resolve();

    await expect(first).resolves.toMatchObject({ status: "accepted", matchedSubscribers: 1 });
    expect(calls).toBe(1);
  });

  it("не удаляет новую подписку старым unsubscribe", async () => {
    const { bus } = createBus();
    let calls = 0;
    const handler = (): void => {
      calls += 1;
    };

    const oldUnsubscribe = bus.subscribe("acme.widgets.widget.updated", handler, {
      pluginId: "acme.consumer",
    });

    bus.subscribe("acme.widgets.widget.updated", handler, { pluginId: "acme.consumer" });

    expect(oldUnsubscribe()).toBe(true);

    await bus.publishAfterCommit(createEnvelope(), { traceId: "trace-resubscribe" });

    expect(calls).toBe(1);
  });

  it("требует непустой traceId", async () => {
    const { bus } = createBus();

    await expect(bus.publishAfterCommit(createEnvelope(), { traceId: " " })).rejects.toThrow(
      TypeError,
    );
  });

  it("проверяет границу in-memory dedupe и очищает состояние через dispose", async () => {
    expect(() => createBus(0)).toThrow(TypeError);

    const { bus } = createBus(2);
    let calls = 0;

    bus.subscribe(
      "acme.widgets.*",
      () => {
        calls += 1;
      },
      { pluginId: "acme.consumer" },
    );

    const event = createEnvelope();

    await bus.publishAfterCommit(event, { traceId: "trace-1" });
    await bus.publishAfterCommit(createEnvelope({ eventId: "01KEVENT000000000000000002" }), {
      traceId: "trace-1",
    });
    await bus.publishAfterCommit(createEnvelope({ eventId: "01KEVENT000000000000000003" }), {
      traceId: "trace-1",
    });
    const replayed = await bus.publishAfterCommit(event, { traceId: "trace-1" });

    expect(replayed.status).toBe("accepted");
    expect(calls).toBe(4);

    bus.dispose();

    const afterDispose = await bus.publishAfterCommit(event, { traceId: "trace-1" });

    expect(afterDispose.status).toBe("accepted");
    expect(calls).toBe(4);
  });
});
