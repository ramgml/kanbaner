import { describe, expect, it } from "vitest";

import { SEARCH_ROUTE } from "./constants.ts";
import { searchUiContributions } from "./metadata.ts";

describe("metadata UI-вкладов глобального поиска", () => {
  it("публикует view и navigation на одном маршруте", () => {
    const view = searchUiContributions.find(
      (contribution) => contribution.id === "kanbaner.search.view",
    );
    const navigation = searchUiContributions.find(
      (contribution) => contribution.id === "kanbaner.search.navigation",
    );

    expect(view).toMatchObject({
      slot: "app.main",
      kind: "view",
      title: "Поиск",
      route: SEARCH_ROUTE,
    });
    expect(navigation).toMatchObject({
      slot: "app.sidebar",
      kind: "navigation",
      title: "Поиск",
      route: SEARCH_ROUTE,
      icon: "search",
    });
    expect(
      searchUiContributions.filter((contribution) => contribution.icon !== undefined),
    ).toHaveLength(1);
  });

  it("не объявляет resource-opener: открытие принадлежит доменам", () => {
    expect(
      searchUiContributions.some((contribution) => contribution.kind === "resource-opener"),
    ).toBe(false);
  });
});
