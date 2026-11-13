import { describe, expect, it, vi } from "vitest";

import type { UiContribution } from "@kanbaner/plugin-sdk";

import {
  createUiContributionRegistry,
  normalizeRoute,
  normalizeUiViewRoute,
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

  it("не теряет query навигационного route, хотя ключ маршрута нормализован", () => {
    const registry = createUiContributionRegistry();

    registry.register(
      "example.test-ui",
      contribution({
        id: "navigation",
        kind: "navigation",
        slot: "app.sidebar",
        title: "Проекты",
        route: "/view/projects?entry=1",
      }),
      render,
    );

    // Shell строит href из contribution.route: служебный query обязан дойти.
    expect(registry.list("app.sidebar")[0]?.contribution.route).toBe("/view/projects?entry=1");
    // Навигация не занимает маршрут, поэтому resolveRoute остаётся пустым.
    expect(registry.resolveRoute("/view/projects")).toBeNull();
  });

  it("сохраняет query view-route вклада, а resolveRoute ищет по нормализованному пути", () => {
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

    expect(registry.list("app.main")[0]?.contribution.route).toBe("/view/example/?tab=1#section");
    expect(registry.resolveRoute("/view/example/")?.contribution.id).toBe("view-a");
    expect(registry.resolveRoute("/view/example?tab=2")?.contribution.id).toBe("view-a");
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

  it("допускает только маршруты /view и отклоняет core routes и /kanban", () => {
    const registry = createUiContributionRegistry();
    const rejectedRoutes = [
      "/kanban",
      "/plugins",
      "/settings",
      "/",
      "/view",
      "/view/",
      "/view//example",
      "/view/example/../settings",
      "/view/example/./",
    ];

    rejectedRoutes.forEach((route, index) => {
      expect(() => normalizeUiViewRoute(route)).toThrow(UiRegistryError);
      expectRegistryError(
        () =>
          registry.register(
            "example.test-ui",
            contribution({ id: `view-${String(index)}`, kind: "view", route }),
            render,
          ),
        "INVALID_ROUTE",
      );
    });

    expect(registry.size()).toBe(0);
  });

  it("валидирует весь batch до записи и не уведомляет о частичном результате", () => {
    const registry = createUiContributionRegistry();
    const listener = vi.fn();

    registry.subscribe(listener);

    const plugin = defineUiPlugin({
      id: "example.test-ui",
      contributions: [
        { metadata: contribution({ id: "first" }), render },
        { metadata: contribution({ id: "first" }), render },
      ],
    });

    expect(() => registerUiPlugin(registry, plugin)).toThrow(UiRegistryError);
    expect(registry.size()).toBe(0);
    expect(registry.getVersion()).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    const routePlugin = defineUiPlugin({
      id: "example.test-ui",
      contributions: [
        {
          metadata: contribution({ id: "route-one", kind: "view", route: "/view/same" }),
          render,
        },
        {
          metadata: contribution({ id: "route-two", kind: "view", route: "/view/same/" }),
          render,
        },
      ],
    });

    expect(() => registerUiPlugin(registry, routePlugin)).toThrow(UiRegistryError);
    expect(registry.size()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("уведомляет подписчиков один раз и только полным snapshot", () => {
    const registry = createUiContributionRegistry();
    const snapshots: Array<{ size: number; version: number; entries: number }> = [];

    registry.subscribe(() => {
      snapshots.push({
        size: registry.size(),
        version: registry.getVersion(),
        entries: registry.listAll().length,
      });
    });

    const plugin = defineUiPlugin({
      id: "example.test-ui",
      contributions: [
        { metadata: contribution({ id: "one" }), render },
        { metadata: contribution({ id: "two" }), render },
      ],
    });

    registerUiPlugin(registry, plugin);

    expect(snapshots).toEqual([{ size: 2, version: 1, entries: 2 }]);
    expect(registry.listAll()).toHaveLength(2);
  });

  it("изолирует ошибку слушателя и не мешает другим подписчикам", () => {
    const registry = createUiContributionRegistry();
    const throwing = vi.fn(() => {
      throw new Error("listener failure");
    });
    const observer = vi.fn();

    registry.subscribe(throwing);
    registry.subscribe(observer);

    const plugin = defineUiPlugin({
      id: "example.test-ui",
      contributions: [
        { metadata: contribution({ id: "one" }), render },
        { metadata: contribution({ id: "two" }), render },
      ],
    });

    expect(() => registerUiPlugin(registry, plugin)).not.toThrow();
    expect(registry.size()).toBe(2);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(registry.getVersion()).toBe(1);

    registry.register("other.plugin", contribution({ id: "three" }), render);

    expect(registry.size()).toBe(3);
    expect(throwing).toHaveBeenCalledTimes(2);
    expect(observer).toHaveBeenCalledTimes(2);
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

describe("синхронизация серверных metadata и привязка рендерера", () => {
  const viewMetadata: UiContribution = {
    id: "kanbaner.task-list.view",
    slot: "app.main",
    kind: "view",
    priority: 60,
    title: "Задачи",
    route: "/view/tasks",
  };

  const genericRender: UiComponent = () => null;
  const realRender: UiComponent = () => null;

  it("идемпотентно синхронизирует metadata без дубликатов", () => {
    const registry = createUiContributionRegistry();
    const registration = { metadata: viewMetadata, render: genericRender };

    registry.syncPlugin("kanbaner.task-list", [registration], genericRender);
    registry.syncPlugin("kanbaner.task-list", [registration], genericRender);

    expect(registry.size()).toBe(1);
    expect(registry.list("app.main")).toHaveLength(1);
    expect(registry.resolveRoute("/view/tasks")?.contribution.id).toBe("kanbaner.task-list.view");
  });

  it("не теряет query route вклада при повторном syncPlugin", () => {
    const registry = createUiContributionRegistry();
    const metadata = contribution({
      id: "view-query",
      kind: "view",
      route: "/view/example?tab=1",
    });
    const registration = { metadata, render: genericRender };

    registry.syncPlugin("kanbaner.task-list", [registration], genericRender);
    registry.syncPlugin("kanbaner.task-list", [registration], genericRender);

    expect(registry.list("app.main")[0]?.contribution.route).toBe("/view/example?tab=1");
    expect(registry.resolveRoute("/view/example/")?.contribution.id).toBe("view-query");
    expect(registry.size()).toBe(1);
  });

  it("привязывает реальный рендерер после metadata и заменяет его повтором", () => {
    const registry = createUiContributionRegistry();

    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );
    expect(registry.list("app.main")[0]?.render).toBe(genericRender);

    registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender);

    expect(registry.size()).toBe(1);
    expect(registry.list("app.main")[0]?.render).toBe(realRender);

    const version = registry.getVersion();
    registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender);

    // Повторная привязка того же рендерера ничего не дублирует и не
    // увеличивает версию.
    expect(registry.getVersion()).toBe(version);
    expect(registry.list("app.main")).toHaveLength(1);
  });

  it("применяет привязку, пришедшую до metadata", () => {
    const registry = createUiContributionRegistry();

    registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender);
    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );

    expect(registry.list("app.main")[0]?.render).toBe(realRender);
    expect(registry.size()).toBe(1);
  });

  it("удаляет вклад и маршрут, когда серверные metadata исчезли", () => {
    const registry = createUiContributionRegistry();

    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );
    registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender);

    registry.syncPlugin("kanbaner.task-list", [], genericRender);

    expect(registry.size()).toBe(0);
    expect(registry.list("app.main")).toEqual([]);
    expect(registry.resolveRoute("/view/tasks")).toBeNull();
  });

  it("не даёт привязать рендерер к вкладу другого плагина", () => {
    const registry = createUiContributionRegistry();

    registry.register("example.test-ui", viewMetadata, genericRender);

    expectRegistryError(
      () => registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender),
      "INVALID_RENDERER",
    );
  });

  it("удаляет маршрут при смене view на panel с прежним route", () => {
    const registry = createUiContributionRegistry();

    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );

    expect(registry.resolveRoute("/view/tasks")).not.toBeNull();

    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: { ...viewMetadata, kind: "panel" }, render: genericRender }],
      genericRender,
    );

    expect(registry.size()).toBe(1);
    expect(registry.list("app.main")[0]?.contribution.kind).toBe("panel");
    expect(registry.resolveRoute("/view/tasks")).toBeNull();
  });

  it("не увеличивает версию и не будит подписчиков при структурно том же sync", () => {
    const registry = createUiContributionRegistry();

    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );

    const listener = vi.fn();
    const version = registry.getVersion();
    const entry = registry.list("app.main")[0];

    registry.subscribe(listener);
    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: { ...viewMetadata }, render: genericRender }],
      genericRender,
    );

    expect(registry.getVersion()).toBe(version);
    expect(listener).not.toHaveBeenCalled();
    // Объект вклада переиспользован: подписчики не получают новый snapshot
    // без изменения данных.
    expect(registry.list("app.main")[0]).toBe(entry);
  });

  it("отклоняет чужой pre-bind до metadata без изменения состояния", () => {
    const registry = createUiContributionRegistry();

    registry.bindRenderer("other.plugin", viewMetadata.id, realRender);

    expectRegistryError(
      () =>
        registry.registerBatch("kanbaner.task-list", [
          { metadata: viewMetadata, render: genericRender },
        ]),
      "INVALID_RENDERER",
    );
    expect(registry.size()).toBe(0);
    expect(registry.getVersion()).toBe(0);
    expect(registry.resolveRoute("/view/tasks")).toBeNull();

    expectRegistryError(
      () =>
        registry.syncPlugin(
          "kanbaner.task-list",
          [{ metadata: viewMetadata, render: genericRender }],
          genericRender,
        ),
      "INVALID_RENDERER",
    );
    expect(registry.size()).toBe(0);
    expect(registry.getVersion()).toBe(0);
  });

  it("cleanup старого sync не удаляет вклады нового поколения", () => {
    const registry = createUiContributionRegistry();
    const first = registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );
    const second = registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: realRender }],
      genericRender,
    );

    first();

    expect(registry.size()).toBe(1);
    expect(registry.list("app.main")[0]?.render).toBe(realRender);

    second();

    expect(registry.size()).toBe(0);
    expect(registry.resolveRoute("/view/tasks")).toBeNull();
  });

  it("после register → bind cleanup снимает вклад вместе с привязкой", () => {
    const registry = createUiContributionRegistry();
    const cleanup = registry.register("kanbaner.task-list", viewMetadata, genericRender);

    registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender);
    cleanup();

    expect(registry.size()).toBe(0);
    expect(registry.list("app.main")).toEqual([]);
    expect(registry.resolveRoute("/view/tasks")).toBeNull();

    // Следующая регистрация не получает рендерер от уже снятого вклада.
    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );

    expect(registry.list("app.main")[0]?.render).toBe(genericRender);
  });

  it("после unregisterPlugin чужой sync не получает stale pre-bind", () => {
    const registry = createUiContributionRegistry();

    registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender);
    registry.unregisterPlugin("kanbaner.task-list");

    registry.syncPlugin(
      "other.plugin",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );

    expect(registry.list("app.main")[0]?.pluginId).toBe("other.plugin");
    expect(registry.list("app.main")[0]?.render).toBe(genericRender);
  });

  it("keep real renderer при повторном sync без изменений metadata", () => {
    const registry = createUiContributionRegistry();

    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: viewMetadata, render: genericRender }],
      genericRender,
    );
    registry.bindRenderer("kanbaner.task-list", viewMetadata.id, realRender);

    const version = registry.getVersion();

    registry.syncPlugin(
      "kanbaner.task-list",
      [{ metadata: { ...viewMetadata }, render: genericRender }],
      genericRender,
    );

    expect(registry.getVersion()).toBe(version);
    expect(registry.list("app.main")[0]?.render).toBe(realRender);
  });
});

describe("resource-opener в реестре", () => {
  const opener = contribution({
    id: "kanbaner.projects.resource-opener.task",
    kind: "resource-opener",
    resourcePluginId: "kanbaner.tasks",
    resourceType: "task",
    route: "/view/kanban",
  });

  it("находит opener по pluginId и resourceType из ResourceRef", () => {
    const registry = createUiContributionRegistry();

    registry.register("kanbaner.projects", opener, render);

    expect(registry.resolveResourceOpener("kanbaner.tasks:task:task-1")?.contribution.id).toBe(
      "kanbaner.projects.resource-opener.task",
    );
  });

  it("не подменяет opener при другом типе, плагине или неверной ссылке", () => {
    const registry = createUiContributionRegistry();

    registry.register("kanbaner.projects", opener, render);

    expect(registry.resolveResourceOpener("kanbaner.tasks:project:project-1")).toBeNull();
    expect(registry.resolveResourceOpener("kanbaner.notes:task:note-1")).toBeNull();
    expect(registry.resolveResourceOpener("not-a-ref")).toBeNull();
  });

  it("по умолчанию считает владельцем ресурса владельца вклада", () => {
    const registry = createUiContributionRegistry();
    const ownOpener = contribution({
      id: "kanbaner.notes.resource-opener.note",
      kind: "resource-opener",
      resourceType: "note",
      route: "/view/notes",
    });

    registry.register("kanbaner.notes", ownOpener, render);

    expect(registry.resolveResourceOpener("kanbaner.notes:note:note-1")?.contribution.id).toBe(
      "kanbaner.notes.resource-opener.note",
    );
  });

  it("требует route и resourceType у resource-opener", () => {
    const registry = createUiContributionRegistry();

    expectRegistryError(
      () =>
        registry.register(
          "kanbaner.projects",
          contribution({
            id: "missing-route",
            kind: "resource-opener",
            resourceType: "task",
          }),
          render,
        ),
      "INVALID_CONTRIBUTION",
    );

    expectRegistryError(
      () =>
        registry.register(
          "kanbaner.projects",
          contribution({
            id: "missing-type",
            kind: "resource-opener",
            route: "/view/kanban",
          }),
          render,
        ),
      "INVALID_CONTRIBUTION",
    );
  });
});
