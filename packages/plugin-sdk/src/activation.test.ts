import { describe, expect, it } from "vitest";

import {
  createPluginError,
  isEventOwnedByPlugin,
  isOperationResult,
  toErrorResult,
  toSuccessResult,
  type EventEnvelope,
} from "./index.ts";

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: "01K-activation-event",
    type: "kanbaner.fixture.item.created",
    contractVersion: 1,
    source: "kanbaner.fixture",
    occurredAt: "2026-11-07T00:00:00Z",
    resource: "kanbaner.fixture:item:one",
    resourceVersion: 1,
    payload: {},
    ...overrides,
  };
}

describe("isOperationResult", () => {
  it("принимает success и error, прошедшие validateOperationResult", () => {
    expect(isOperationResult(toSuccessResult({ id: "one" }))).toBe(true);
    expect(
      isOperationResult(toErrorResult(createPluginError("NOT_FOUND", "Ресурс не найден"))),
    ).toBe(true);
  });

  it("отклоняет malformed-значения", () => {
    for (const value of [
      null,
      undefined,
      "ok",
      1,
      {},
      { ok: true },
      { ok: false },
      { ok: false, error: {} },
      { ok: true, data: undefined },
      { ok: false, error: { code: "NOT_A_CODE", message: "x", retryable: false } },
    ]) {
      expect(isOperationResult(value)).toBe(false);
    }
  });
});

describe("isEventOwnedByPlugin", () => {
  it("требует совпадения source, type и владельца ResourceRef", () => {
    expect(isEventOwnedByPlugin(envelope(), "kanbaner.fixture")).toBe(true);
    expect(isEventOwnedByPlugin(envelope({ source: "kanbaner.other" }), "kanbaner.fixture")).toBe(
      false,
    );
    expect(
      isEventOwnedByPlugin(envelope({ type: "kanbaner.other.item.created" }), "kanbaner.fixture"),
    ).toBe(false);
    expect(
      isEventOwnedByPlugin(envelope({ resource: "kanbaner.other:item:one" }), "kanbaner.fixture"),
    ).toBe(false);
    expect(isEventOwnedByPlugin(envelope({ resource: "not-a-ref" }), "kanbaner.fixture")).toBe(
      false,
    );
  });
});
