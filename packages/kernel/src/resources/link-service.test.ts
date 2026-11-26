import { describe, expect, it } from "vitest";

import type {
  LogFields,
  PluginLogger,
  Relation,
  ResourceLink,
  ResourceRef,
} from "@kanbaner/plugin-sdk";

import { ResourceServiceError } from "./errors.ts";
import { InMemoryLinkStore } from "./in-memory-link-store.ts";
import type { LinkStore, LinkStoreAddResult } from "./link-store.ts";
import { LinkService } from "./link-service.ts";

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
const RELATION: Relation = "acme.links.relates";
const OTHER_RELATION: Relation = "acme.links.mentions";
const SECRET = "SUPERSECRET-LINK-VALUE";
const CREATED_AT = "2026-11-06T12:00:00.000Z";

function createService(
  options: { store?: LinkStore; logger?: PluginLogger; now?: () => Date } = {},
): LinkService {
  return new LinkService({
    store: options.store ?? new InMemoryLinkStore(),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

class FailingLinkStore implements LinkStore {
  readonly #errorName: string;

  constructor(errorName = "Error") {
    this.#errorName = errorName;
  }

  async add(): Promise<LinkStoreAddResult> {
    throw this.#error();
  }

  async remove(): Promise<boolean> {
    throw this.#error();
  }

  async listByRef(): Promise<readonly ResourceLink[]> {
    throw this.#error();
  }

  async deleteByRef(): Promise<number> {
    throw this.#error();
  }

  #error(): Error {
    const error = new Error(SECRET);

    error.name = this.#errorName;

    return error;
  }
}

describe("LinkService", () => {
  it("создаёт связь с UTC createdAt через внедряемый store", async () => {
    const store = new InMemoryLinkStore();
    const service = createService({ store, now: () => new Date(CREATED_AT) });

    const link = await service.link(SOURCE, TARGET, RELATION);

    expect(link).toEqual({
      sourceRef: SOURCE,
      targetRef: TARGET,
      relation: RELATION,
      createdAt: CREATED_AT,
    });
    expect(store.size()).toBe(1);
  });

  it("идемпотентно возвращает существующую связь при повторе", async () => {
    const store = new InMemoryLinkStore();
    const times = [new Date(CREATED_AT), new Date("2026-11-06T13:00:00Z")];
    const service = createService({
      store,
      now: () => times.shift() ?? new Date(CREATED_AT),
    });

    const first = await service.link(SOURCE, TARGET, RELATION);
    const second = await service.link(SOURCE, TARGET, RELATION);

    expect(second).toEqual(first);
    expect(store.size()).toBe(1);
  });

  it("создаёт одну запись при одновременных одинаковых link", async () => {
    const store = new InMemoryLinkStore();
    const times = [new Date(CREATED_AT), new Date("2026-11-06T13:00:00Z")];
    const service = createService({
      store,
      now: () => times.shift() ?? new Date("2026-11-06T14:00:00Z"),
    });

    const [first, second] = await Promise.all([
      service.link(SOURCE, TARGET, RELATION),
      service.link(SOURCE, TARGET, RELATION),
    ]);

    expect(store.size()).toBe(1);
    expect(first.createdAt).toBe(CREATED_AT);
    expect(second).toEqual(first);
  });

  it("различает связи по relation и не считает дубликатом обратное направление", async () => {
    const store = new InMemoryLinkStore();
    const service = createService({ store });

    await service.link(SOURCE, TARGET, RELATION);
    await service.link(SOURCE, TARGET, OTHER_RELATION);
    await service.link(TARGET, SOURCE, RELATION);

    expect(store.size()).toBe(3);
  });

  it("возвращает связи по source и target и фильтрует по relation", async () => {
    const service = createService();

    await service.link(SOURCE, TARGET, RELATION);
    await service.link(SOURCE, OTHER, OTHER_RELATION);
    await service.link(TARGET, OTHER, RELATION);

    const bySource = await service.list(SOURCE);
    const byTarget = await service.list(TARGET, RELATION);

    expect(bySource).toHaveLength(2);
    expect(byTarget).toHaveLength(2);
    expect(byTarget.every((link) => link.relation === RELATION)).toBe(true);
  });

  it("идемпотентно удаляет связь", async () => {
    const store = new InMemoryLinkStore();
    const service = createService({ store });

    await service.link(SOURCE, TARGET, RELATION);
    await service.unlink(SOURCE, TARGET, RELATION);
    await service.unlink(SOURCE, TARGET, RELATION);

    expect(store.size()).toBe(0);
  });

  it("очищает связи удалённого ресурса с обеих сторон", async () => {
    const store = new InMemoryLinkStore();
    const service = createService({ store });

    await service.link(SOURCE, TARGET, RELATION);
    await service.link(TARGET, OTHER, OTHER_RELATION);
    await service.link(OTHER, SOURCE, RELATION);

    const removed = await service.cleanup(TARGET);

    expect(removed).toBe(2);
    expect(store.size()).toBe(1);
    await expect(service.list(TARGET)).resolves.toEqual([]);
    await expect(service.cleanup(TARGET)).resolves.toBe(0);
  });

  it("отклоняет некорректные ссылки и relation со стабильным кодом", async () => {
    const service = createService();

    await expect(service.link("broken", TARGET, RELATION)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.link(SOURCE, "broken", RELATION)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.link(SOURCE, TARGET, "single")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.list("broken")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.cleanup("broken")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("изолирует ошибку store и не пишет секреты в журнал", async () => {
    const logger = new RecordingLogger();
    const service = createService({ store: new FailingLinkStore(), logger });

    await expect(service.link(SOURCE, TARGET, RELATION)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.fields).toMatchObject({
      operation: "link",
      errorName: "Error",
    });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("не журналирует произвольный error.name store", async () => {
    const logger = new RecordingLogger();
    const service = createService({ store: new FailingLinkStore(SECRET), logger });

    await expect(service.link(SOURCE, TARGET, RELATION)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(logger.entries[0]?.fields?.errorName).toBe("Error");
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("проверяет время, полученное из now", async () => {
    const service = createService({ now: () => new Date(Number.NaN) });

    await expect(service.link(SOURCE, TARGET, RELATION)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("не разделяет состояние между экземплярами in-memory store", async () => {
    const first = createService();
    const second = createService();

    await first.link(SOURCE, TARGET, RELATION);

    await expect(second.list(SOURCE)).resolves.toEqual([]);
  });

  it("возвращает ResourceServiceError с retryable по коду", () => {
    const error = new ResourceServiceError("INTERNAL_ERROR", "Не удалось открыть ресурс");

    expect(error).toBeInstanceOf(ResourceServiceError);
    expect(error.retryable).toBe(false);
  });
});
