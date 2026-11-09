import { describe, expect, it } from "vitest";

import { CORE_NAV_ITEMS, isActivePath } from "./nav-items";

describe("core navigation", () => {
  it("не содержит администрирование в рабочей навигации", () => {
    expect(CORE_NAV_ITEMS.map((item) => item.href)).not.toContain("/plugins");
    expect(CORE_NAV_ITEMS.map((item) => item.href)).not.toContain("/settings");
  });
});

describe("isActivePath", () => {
  it("игнорирует query и hash навигационного вклада", () => {
    expect(isActivePath("/view/projects", "/view/projects?entry=1")).toBe(true);
    expect(isActivePath("/view/projects", "/view/projects#top")).toBe(true);
    expect(isActivePath("/view/kanban", "/view/projects?entry=1")).toBe(false);
  });

  it("сохраняет прежнее поведение для core routes", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/plugins", "/")).toBe(false);
    expect(isActivePath("/plugins/example", "/plugins")).toBe(true);
  });
});
