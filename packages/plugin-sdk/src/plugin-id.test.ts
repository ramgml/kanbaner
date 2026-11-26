import { describe, expect, it } from "vitest";

import { isOperationId, validateOperationId } from "./index.ts";

describe("operation id", () => {
  it("принимает camelCase действие после namespace и plugin ID", () => {
    expect(isOperationId("kanbaner.tasks.task.moveMany")).toBe(true);
    expect(isOperationId("kanbaner.tasks.task.deleteMany")).toBe(true);
    expect(validateOperationId("kanbaner.tasks.task.moveMany").ok).toBe(true);
  });

  it("по-прежнему требует нижний регистр в plugin ID и первом символе действия", () => {
    expect(isOperationId("Kanbaner.tasks.task.moveMany")).toBe(false);
    expect(isOperationId("kanbaner.tasks.Task.moveMany")).toBe(false);
    expect(isOperationId("kanbaner.tasks.task.move_many")).toBe(false);
  });
});
