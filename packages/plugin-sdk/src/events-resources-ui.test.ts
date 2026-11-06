import { describe, expect, it, expectTypeOf } from "vitest";

import {
  CORE_UI_SLOTS,
  EventEnvelopeSchema,
  UI_CONTRACT_VERSION,
  createPluginError,
  formatResourceRef,
  isErrorResult,
  isEventSubscription,
  isEventType,
  isRelation,
  isResourceRef,
  isUtcTimestamp,
  matchesEventSubscription,
  parseResourceRef,
  toErrorResult,
  toSuccessResult,
  validateEventEnvelope,
  validateEventSubscription,
  validateRelation,
  validateResourceDescriptor,
  validateResourceLink,
  validateResourceRef,
  validateUiContribution,
  validateUtcTimestamp,
  type CommandInvoker,
  type ExecutionContext,
  type ResourceService,
  type UiContribution,
} from "./index.ts";

const validEvent = {
  eventId: "01K-event",
  type: "kanbaner.tasks.task.updated",
  contractVersion: 1,
  source: "kanbaner.tasks",
  occurredAt: "2026-11-06T12:00:00Z",
  resource: "kanbaner.tasks:task:01J-task",
  resourceVersion: 4,
  payload: { changed: ["title", "status"] },
};

describe("события и подписки", () => {
  it("принимает конверт события после коммита", () => {
    const result = validateEventEnvelope(validEvent);

    expect(result.ok).toBe(true);
    expect(EventEnvelopeSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("отклоняет wildcard в типе события и неверный UTC timestamp", () => {
    expect(validateEventEnvelope({ ...validEvent, type: "kanbaner.tasks.task.*" }).ok).toBe(false);
    expect(
      validateEventEnvelope({ ...validEvent, occurredAt: "2026-11-06T12:00:00+03:00" }).ok,
    ).toBe(false);
  });

  it("проверяет точные типы событий", () => {
    expect(isEventType("kanbaner.tasks.task.created")).toBe(true);
    expect(isEventType("kanbaner.tasks.task")).toBe(false);
    expect(isEventType("kanbaner.tasks.task.created.extra")).toBe(false);
  });

  it("разрешает wildcard только в конце сегментов", () => {
    for (const subscription of [
      "kanbaner.tasks.task.updated",
      "kanbaner.*",
      "kanbaner.tasks.*",
      "kanbaner.tasks.task.*",
    ]) {
      expect(validateEventSubscription(subscription).ok).toBe(true);
      expect(isEventSubscription(subscription)).toBe(true);
    }

    for (const subscription of [
      "*",
      "kanbaner.task*",
      "kanbaner.*.created",
      "kanbaner.tasks.*.created",
    ]) {
      expect(validateEventSubscription(subscription).ok).toBe(false);
      expect(isEventSubscription(subscription)).toBe(false);
    }
  });

  it("сопоставляет события подписке по границе сегментов", () => {
    expect(matchesEventSubscription("kanbaner.tasks.*", "kanbaner.tasks.task.created")).toBe(true);
    expect(matchesEventSubscription("kanbaner.*", "kanbaner.notes.note.updated")).toBe(true);
    expect(matchesEventSubscription("kanbaner.tasks.*", "kanbaner.task-list.task.created")).toBe(
      false,
    );
    expect(matchesEventSubscription("kanbaner.tasks.task.updated", validEvent.type)).toBe(true);
    expect(matchesEventSubscription("kanbaner.notes.*", validEvent.type)).toBe(false);
  });
});

describe("UTC timestamp", () => {
  it("принимает реальные UTC-даты с суффиксом Z", () => {
    for (const timestamp of [
      "2026-11-06T12:00:00Z",
      "2026-11-06T12:00:00.123Z",
      "2024-02-29T23:59:59Z",
    ]) {
      expect(isUtcTimestamp(timestamp)).toBe(true);
      expect(validateUtcTimestamp(timestamp).ok).toBe(true);
    }
  });

  it("отклоняет несуществующие даты и смещения от UTC одинаково везде", () => {
    for (const timestamp of [
      "2026-02-31T25:61:61Z",
      "2026-13-01T00:00:00Z",
      "2026-02-29T12:00:00Z",
      "2026-11-06T12:00:00+03:00",
      "2026-11-06T12:00:00",
      "2026-11-06 12:00:00Z",
    ]) {
      expect(isUtcTimestamp(timestamp)).toBe(false);
      expect(validateUtcTimestamp(timestamp).ok).toBe(false);
      expect(validateEventEnvelope({ ...validEvent, occurredAt: timestamp }).ok).toBe(false);
    }

    expect(isUtcTimestamp(42)).toBe(false);
    expect(validateUtcTimestamp(undefined).ok).toBe(false);
  });
});

describe("ResourceRef и связи", () => {
  it("разбирает и собирает ResourceRef, сохраняя opaque-id непрозрачным", () => {
    const ref = formatResourceRef({
      pluginId: "kanbaner.tasks",
      resourceType: "task",
      opaqueId: "01J-task/with/slashes",
    });

    expect(ref).toBe("kanbaner.tasks:task:01J-task/with/slashes");
    expect(parseResourceRef(ref)).toEqual({
      pluginId: "kanbaner.tasks",
      resourceType: "task",
      opaqueId: "01J-task/with/slashes",
    });
    expect(isResourceRef(ref)).toBe(true);
    expect(validateResourceRef(ref).ok).toBe(true);
  });

  it("не связывает opaque-id с ULID", () => {
    expect(
      formatResourceRef({
        pluginId: "acme.calendar",
        resourceType: "event",
        opaqueId: "произвольный-идентификатор",
      }),
    ).toBe("acme.calendar:event:произвольный-идентификатор");
  });

  it("отклоняет неверный формат ResourceRef", () => {
    for (const ref of [
      "kanbaner.tasks:task",
      "kanbaner.tasks:task:1:extra",
      "Kanbaner.tasks:task:1",
      "kanbaner.tasks::1",
      "kanbaner.tasks:task:",
      "kanbaner.tasks:task:with space",
    ]) {
      expect(isResourceRef(ref)).toBe(false);
      expect(validateResourceRef(ref).ok).toBe(false);
    }
  });

  it("бросает безопасную ошибку при разборе неверной ссылки", () => {
    expect(() => parseResourceRef("kanbaner.tasks:task")).toThrow(
      "ResourceRef должен иметь формат",
    );
    expect(() =>
      formatResourceRef({ pluginId: "kanbaner", resourceType: "task", opaqueId: "1" }),
    ).toThrow("plugin-id");
  });

  it("проверяет namespace-ированный relation", () => {
    expect(validateRelation("kanbaner.notes.references").ok).toBe(true);
    expect(validateRelation("kanbaner.references").ok).toBe(true);
    expect(validateRelation("references").ok).toBe(false);
    expect(validateRelation("kanbaner..references").ok).toBe(false);

    // Короткое валидное значение одинаково принимают Ajv и предикат.
    expect(validateRelation("a.b").ok).toBe(true);
    expect(isRelation("a.b")).toBe(true);
    expect(isRelation("a")).toBe(false);
    expect(isRelation(42)).toBe(false);
  });

  it("не пропускает нестроковые части ResourceRef в рантайме", () => {
    expect(() =>
      formatResourceRef({
        pluginId: "kanbaner.tasks",
        resourceType: "task",
        opaqueId: undefined as unknown as string,
      }),
    ).toThrow("opaque-id");
    expect(() =>
      formatResourceRef({
        pluginId: "kanbaner.tasks",
        resourceType: "task",
        opaqueId: 42 as unknown as string,
      }),
    ).toThrow("opaque-id");
    expect(() =>
      formatResourceRef({
        pluginId: undefined as unknown as string,
        resourceType: "task",
        opaqueId: "01J",
      }),
    ).toThrow("plugin-id");
    expect(() =>
      formatResourceRef({
        pluginId: "kanbaner.tasks",
        resourceType: 42 as unknown as string,
        opaqueId: "01J",
      }),
    ).toThrow("resource-type");

    expect(() => parseResourceRef(42 as unknown as string)).toThrow("строкой");
    expect(() => parseResourceRef(undefined as unknown as string)).toThrow("строкой");
  });

  it("возвращает NOT_FOUND из ResourceService.resolve вместо null", async () => {
    const missingRef = "kanbaner.tasks:task:missing";
    const service: ResourceService = {
      async link(sourceRef, targetRef, relation) {
        return { sourceRef, targetRef, relation };
      },
      async unlink() {},
      async list() {
        return [];
      },
      async resolve(ref) {
        if (ref === missingRef) {
          return toErrorResult(createPluginError("NOT_FOUND", "Ресурс не найден"));
        }

        return toSuccessResult({ ref, resourceType: "task", title: "Задача" });
      },
      async canOpen() {
        return false;
      },
      async open() {},
    };

    const missing = await service.resolve(missingRef);
    const found = await service.resolve("kanbaner.tasks:task:01J-task");

    expect(missing).not.toBeNull();
    expect(isErrorResult(missing)).toBe(true);
    if (isErrorResult(missing)) {
      expect(missing.error.code).toBe("NOT_FOUND");
    }
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.data.resourceType).toBe("task");
    }
  });

  it("валидирует связь и метаданные ресурса", () => {
    expect(
      validateResourceLink({
        sourceRef: "kanbaner.notes:note:01J-note",
        targetRef: "kanbaner.tasks:task:01J-task",
        relation: "kanbaner.notes.references",
        createdAt: "2026-11-06T12:00:00Z",
      }).ok,
    ).toBe(true);

    expect(
      validateResourceLink({
        sourceRef: "kanbaner.notes:note:01J-note",
        targetRef: "kanbaner.tasks:task:01J-task",
        relation: "references",
      }).ok,
    ).toBe(false);

    expect(
      validateResourceDescriptor({
        ref: "kanbaner.tasks:task:01J-task",
        resourceType: "task",
        title: "Подготовить релиз",
        state: "open",
        metadata: { projectId: "01J-project" },
      }).ok,
    ).toBe(true);
  });
});

describe("UI-вклады", () => {
  it("принимает вклад в базовый слот без React-зависимости", () => {
    const contribution: UiContribution = {
      id: "kanbaner.kanban.board",
      slot: "app.main",
      kind: "view",
      priority: 10,
      title: "Доска",
    };

    expect(validateUiContribution(contribution).ok).toBe(true);
    expect(CORE_UI_SLOTS).toContain("app.main");
    expect(UI_CONTRACT_VERSION).toBe("1");
  });

  it("принимает слот, опубликованный плагином", () => {
    expect(
      validateUiContribution({
        id: "acme.calendar.panel",
        slot: "acme.calendar.sidebar",
        kind: "panel",
        priority: 0,
      }).ok,
    ).toBe(true);
  });

  it("отклоняет неизвестный kind и неверный slot", () => {
    expect(
      validateUiContribution({
        id: "x",
        slot: "app.main",
        kind: "iframe",
        priority: 0,
      }).ok,
    ).toBe(false);
    expect(
      validateUiContribution({
        id: "x",
        slot: "main",
        kind: "view",
        priority: 0,
      }).ok,
    ).toBe(false);
  });
});

describe("типы контекста выполнения", () => {
  it("оставляет storage generic/unknown и не требует kernel-типов", () => {
    expectTypeOf<ExecutionContext["storage"]>().toEqualTypeOf<unknown>();
    expectTypeOf<ExecutionContext<{ readonly backend: "memory" }>["storage"]>().toEqualTypeOf<{
      readonly backend: "memory";
    }>();
    expectTypeOf<CommandInvoker["execute"]>().toBeFunction();
    expectTypeOf<ResourceService["link"]>().toBeFunction();
  });
});
