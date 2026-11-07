import "@testing-library/jest-dom/vitest";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { UiContribution } from "@kanbaner/plugin-sdk";

import { BuiltinUiPlugins, builtinUiPlugins } from "./builtin-ui-plugins";
import { UiRegistryProvider } from "./provider";
import { createUiContributionRegistry } from "./registry";
import { ServerUiContributions } from "./server-contributions";

afterEach(() => {
  cleanup();
});

describe("composition встроенных UI-плагинов", () => {
  it("привязывает реальные рендереры к серверным metadata без дубликатов", async () => {
    const registry = createUiContributionRegistry();
    const plugin = builtinUiPlugins[0];
    const contributions = plugin.contributions.map((entry) => ({
      pluginId: plugin.id,
      contribution: entry.metadata as unknown as UiContribution,
    }));

    render(
      <UiRegistryProvider registry={registry}>
        <ServerUiContributions contributions={contributions} />
        <BuiltinUiPlugins />
      </UiRegistryProvider>,
    );

    // Эффекты регистрации metadata и привязки рендереров выполняются после
    // commit; даём React завершить оба эффекта перед проверкой реестра.
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    const route = registry.resolveRoute("/view/tasks");

    expect(route?.contribution.id).toBe("kanbaner.task-list.view");
    expect(route?.render).toBe(plugin.contributions[0]?.render);

    expect(registry.size()).toBe(plugin.contributions.length);
    expect(registry.list("app.main")).toHaveLength(1);
    expect(registry.list("app.details")).toHaveLength(1);
    expect(registry.list("app.overlays")).toHaveLength(1);
  });
});
