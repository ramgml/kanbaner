import { describe, expect, it } from "vitest";

import { createPluginError, PluginOperationError } from "./errors.ts";

describe("PluginOperationError", () => {
  it("создаёт публичную ожидаемую ошибку с конвертом PluginError", () => {
    const error = new PluginOperationError("VERSION_CONFLICT", "Задача изменена", {
      details: { expectedVersion: 3, actualVersion: 4 },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PluginOperationError");
    expect(error.message).toBe("Задача изменена");
    expect(error.error).toEqual({
      code: "VERSION_CONFLICT",
      message: "Задача изменена",
      retryable: false,
      details: { expectedVersion: 3, actualVersion: 4 },
    });
  });

  it("восстанавливает ошибку из готового PluginError с retryable и details", () => {
    const pluginError = createPluginError("DEPENDENCY_UNAVAILABLE", "Сервис недоступен", {
      details: { service: "search" },
    });
    const error = PluginOperationError.from(pluginError);

    expect(error).toBeInstanceOf(PluginOperationError);
    expect(error.error).toEqual(pluginError);
  });
});
