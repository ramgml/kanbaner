import { describe, expect, it, vi } from "vitest";

import type { UiContribution } from "@kanbaner/plugin-sdk";

import {
  createUiContributionRegistry,
  normalizeRoute,
  UiRegistryError,
  type UiComponent,
} from "./registry";
import { defineUiPlugin, registerUiPlugin } from "./plugin-api";

const render: UiComponent = () => null;

function contribution(overrides: Partial<UiContribution> = {}): UiContribution {
  return {
    id: "example.test-ui.panel",
    slot: "app.main",
    kind: "panel",
    priority: 10,
    title: "Панель",
    ...overrides,
  };
}

function expectRegistryError(callback: () => void, code: string): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(UiRegistryError);
    expect((error as UiRegistryError).code).toBe(code);
    return;
  }

  throw new Error(`Ожидалась ошибка ${code}`);
}

describe("клиентский реестр UI-вкладов", () => {
  it("регистрирует вклад и отдаёт его в слоте", () => {
    const registry = createUiContributionRegistry();

    registry.register("example.test-ui", contribution(), render);

    expect(registry.size()).toBe(1);
    expect(registry.list("app.main")).toHaveLength(1);
    expect(registry.list("app.main")[0]?.pluginId).toBe("example.test-ui");
    expect(registry.list("app.sidebar")).toEqual([]);
  });

  it("сортирует вклады по убыванию приоритета и стабильно по ID", () => {
    const registry = createUiContributionRegistry();

    registry.register("example.test-ui", contribution({ id: "low", priority: 1 }), render);
    registry.register("example.test-ui", contribution({ id: "high", priority: 100 }), render);
    registry.register("example.test-ui", contribution({ id: "middle", priority: 50 }), render);

    expect(registry.list("app.main").map((entry) => entry.contribution.id)).toEqual([
      "high",
      "middle",
      "low",
    ]);
  });

  it("отклоняет повторный ID вклада в любом слоте", () => {
    const registry = createUiContributionRegistry();
    const metadata = contribution();

    registry.register("example.test-ui", metadata, render);

    expectRegistryError(
      () => registry.register("another.plugin", metadata, render),
      "DUPLICATE_CONTRIBUTION_ID",
    );
  });

  it("отклоняет занятый маршрут представления", () => {
    const registry = createUiContributionRegistry();

    registry.register(
      "example.test-ui",
      contribution({
        id: "view-a",
        kind: "view",
        route: "/view/example",
      }),
      render,
    );

    expectRegistryError(
      () =>
        registry.register(
          "example.test-ui",
          contribution({
            id: "view-b",
            kind: "view",
            route: "/view/example/",
          }),
          render,
        ),
      "DUPLICATE_ROUTE",
    );
  });

  it("нормализует маршрут и находит представление", () => {
    const registry = createUiContributionRegistry();

    registry.register(
      "example.test-ui",
      contribution({
        id: "view-a",
        kind: "view",
        route: "/view/example/?tab=1#section",
      }),
      render,
    );

    expect(normalizeRoute("/view/example/?tab=1#section")).toBe("/view/example");
    expect(registry.resolveRoute("/view/example/")?.contribution.id).toBe("view-a");
    expect(registry.resolveRoute("/view/other")).toBeNull();
  });

  it("валидирует Plugin ID, слот, вид, приоритет и навигацию", () => {
    const registry = createUiContributionRegistry();

    expectRegistryError(
      () => registry.register("INVALID", contribution(), render),
      "INVALID_PLUGIN_ID",
    );
    expectRegistryError(
      () => registry.register("example.test-ui", contribution({ slot: "main" }), render),
      "INVALID_CONTRIBUTION",
    );
    expectRegistryError(
      () =>
        registry.register(
          "example.test-ui",
          contribution({ kind: "unknown" as UiContribution["kind"] }),
          render,
        ),
      "INVALID_CONTRIBUTION",
    );
    expectRegistryError(
      () => registry.register("example.test-ui", contribution({ priority: 1.5 }), render),
      "INVALID_CONTRIBUTION",
    );
    expectRegistryError(
      () =>
        registry.register(
          "example.test-ui",
          contribution({ kind: "navigation", title: "Навигация" }),
          render,
        ),
      "INVALID_CONTRIBUTION",
    );
  });

  it("убирает вклады плагина и уведомляет подписчиков", () => {
    const registry = createUiContributionRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.register("example.test-ui", contribution({ id: "one" }), render);
    registry.register("example.test-ui", contribution({ id: "two" }), render);
    registry.register("other.plugin", contribution({ id: "three" }), render);

    expect(listener).toHaveBeenCalledTimes(3);

    registry.unregisterPlugin("example.test-ui");

    expect(registry.size()).toBe(1);
    expect(registry.listAll()[0]?.contribution.id).toBe("three");
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    registry.unregisterPlugin("other.plugin");

    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("откатывает частичную регистрацию плагина", () => {
    const registry = createUiContributionRegistry();

    registry.register("other.plugin", contribution({ id: "occupied" }), render);

    const plugin = defineUiPlugin({
      id: "example.test-ui",
      contributions: [
        { metadata: contribution({ id: "new-one" }), render },
        { metadata: contribution({ id: "occupied" }), render },
      ],
    });

    expect(() => registerUiPlugin(registry, plugin)).toThrow(UiRegistryError);
    expect(registry.size()).toBe(1);
    expect(registry.listAll()[0]?.contribution.id).toBe("occupied");
  });

  it("обновляет версию реестра при изменении", () => {
    const registry = createUiContributionRegistry();
    const version = registry.getVersion();

    registry.register("example.test-ui", contribution(), render);
    expect(registry.getVersion()).toBe(version + 1);

    registry.unregisterPlugin("example.test-ui");
    expect(registry.getVersion()).toBe(version + 2);
  });
});
