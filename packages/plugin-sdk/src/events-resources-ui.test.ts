import { describe, expect, it, expectTypeOf } from "vitest";

import {
  CORE_UI_SLOTS,
  EventEnvelopeSchema,
  UI_CONTRACT_VERSION,
  formatResourceRef,
  isEventSubscription,
  isEventType,
  isResourceRef,
  matchesEventSubscription,
  parseResourceRef,
  validateEventEnvelope,
  validateEventSubscription,
  validateRelation,
  validateResourceDescriptor,
  validateResourceLink,
  validateResourceRef,
  validateUiContribution,
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
