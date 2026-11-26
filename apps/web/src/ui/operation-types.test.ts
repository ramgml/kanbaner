import { describe, expect, it } from "vitest";

import { sanitizeUiOperationOptions } from "./operation-types";

describe("опции UI-вызова", () => {
  it("сохраняет непустой Idempotency-Key", () => {
    expect(sanitizeUiOperationOptions({ idempotencyKey: "ui-key" })).toEqual({
      idempotencyKey: "ui-key",
    });
  });

  it("считает пустой, нестроковый и отсутствующий ключ отсутствующим", () => {
    expect(sanitizeUiOperationOptions({ idempotencyKey: "" })).toBeUndefined();
    expect(sanitizeUiOperationOptions({ idempotencyKey: 42 })).toBeUndefined();
    expect(sanitizeUiOperationOptions({ idempotencyKey: null })).toBeUndefined();
    expect(sanitizeUiOperationOptions({})).toBeUndefined();
  });

  it("безопасно принимает не-объект вместо опций", () => {
    expect(sanitizeUiOperationOptions(undefined)).toBeUndefined();
    expect(sanitizeUiOperationOptions(null)).toBeUndefined();
    expect(sanitizeUiOperationOptions("ui-key")).toBeUndefined();
    expect(sanitizeUiOperationOptions(["ui-key"])).toBeUndefined();
  });
});
