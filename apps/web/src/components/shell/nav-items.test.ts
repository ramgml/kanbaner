import { describe, expect, it } from "vitest";

import { Flag, FolderKanban, NotebookTabs } from "lucide-react";

import {
  CORE_NAV_ITEMS,
  FALLBACK_PLUGIN_NAV_ICON,
  isActivePath,
  resolvePluginNavIcon,
} from "./nav-items";

describe("core navigation", () => {
  it("не содержит администрирование в рабочей навигации", () => {
    expect(CORE_NAV_ITEMS.map((item) => item.href)).not.toContain("/plugins");
    expect(CORE_NAV_ITEMS.map((item) => item.href)).not.toContain("/settings");
  });
});

describe("иконки навигации плагинов", () => {
  it("сопоставляет известные идентификаторы со статическим allowlist", () => {
    expect(resolvePluginNavIcon("notebook-tabs")).toBe(NotebookTabs);
    expect(resolvePluginNavIcon("folder-kanban")).toBe(FolderKanban);
  });

  it("возвращает прежний Flag для отсутствующего или неизвестного icon", () => {
    expect(FALLBACK_PLUGIN_NAV_ICON).toBe(Flag);
    expect(resolvePluginNavIcon(undefined)).toBe(Flag);
    expect(resolvePluginNavIcon("unknown-icon")).toBe(Flag);
  });

  it("не разрешает прототипные свойства объекта как иконки", () => {
    for (const icon of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(resolvePluginNavIcon(icon)).toBe(Flag);
    }
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
