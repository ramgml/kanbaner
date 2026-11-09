import { describe, expect, it } from "vitest";

import { isActivePath } from "./nav-items";

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
