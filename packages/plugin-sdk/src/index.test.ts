import { describe, expect, it } from "vitest";

import { PLUGIN_CONTRACT_VERSION, type PluginId } from "./index.ts";

describe("@kanbaner/plugin-sdk", () => {
  it("экспортирует версию контракта", () => {
    expect(PLUGIN_CONTRACT_VERSION).toBe("1");
  });

  it("принимает идентификатор плагина как строку", () => {
    const pluginId: PluginId = "kanbaner.tasks";

    expect(pluginId).toBe("kanbaner.tasks");
  });
});
