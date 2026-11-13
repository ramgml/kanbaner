import { describe, expect, it, vi } from "vitest";

import type { UiContribution } from "@kanbaner/plugin-sdk";

import { activate, type ProjectsActivationContext } from "./index.ts";
import {
  KANBAN_ROUTE,
  PROJECTS_OVERVIEW_ROUTE,
  PROJECTS_PLUGIN_ID,
  PROJECTS_UI_CONTRACT,
  TASK_LIST_ROUTE,
  projectsUiContributions,
} from "./metadata.ts";
import { projectsUiPlugin } from "./ui.tsx";

describe("регистрация kanbaner.projects", () => {
  it("activate регистрирует только UI-метаданные через публичный registrar", async () => {
    const register = vi.fn();
    const unregister = vi.fn();
    const context = {
      pluginId: PROJECTS_PLUGIN_ID,
      ui: { register, unregister },
    } as unknown as ProjectsActivationContext;

    await activate(context);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(projectsUiContributions);
    expect(unregister).not.toHaveBeenCalled();
  });

  it("отклоняет активацию с чужим Plugin ID", async () => {
    const context = {
      pluginId: "kanbaner.kanban",
      ui: { register: vi.fn(), unregister: vi.fn() },
    } as unknown as ProjectsActivationContext;

    await expect(activate(context)).rejects.toThrow("kanbaner.projects");
  });

  it("маршруты и рендереры совпадают с серверными metadata", () => {
    expect(KANBAN_ROUTE).toBe("/view/kanban");
    expect(TASK_LIST_ROUTE).toBe("/view/tasks");
    expect(PROJECTS_OVERVIEW_ROUTE).toBe("/view/projects");
    expect(PROJECTS_UI_CONTRACT).toBe("kanbaner.projects.ui.v1");
    expect(projectsUiPlugin.id).toBe(PROJECTS_PLUGIN_ID);
    expect(projectsUiPlugin.contributions).toHaveLength(projectsUiContributions.length);

    for (const metadata of projectsUiContributions) {
      const contribution = projectsUiPlugin.contributions.find(
        (entry) => entry.metadata.id === metadata.id,
      );

      expect(contribution).toBeDefined();
      expect(contribution?.metadata).toEqual(metadata);
      expect(typeof contribution?.render).toBe("function");
    }

    const views = projectsUiContributions.filter(
      (contribution) => contribution.kind === "view",
    ) as readonly UiContribution[];

    expect(views.map((view) => view.slot)).toEqual(["app.main", "app.main", "app.main"]);
    expect(views.map((view) => view.route)).toEqual([
      KANBAN_ROUTE,
      TASK_LIST_ROUTE,
      PROJECTS_OVERVIEW_ROUTE,
    ]);
    expect(projectsUiContributions.map((contribution) => contribution.slot)).toEqual([
      "app.main",
      "app.main",
      "app.main",
      "app.sidebar",
      "app.details",
      "app.overlays",
      "app.overlays",
      "app.overlays",
      "app.sidebar",
      "app.main",
      "app.main",
    ]);

    const openers = projectsUiContributions.filter(
      (contribution) => contribution.kind === "resource-opener",
    );

    expect(openers.map((contribution) => contribution.resourceType)).toEqual(["project", "task"]);
    expect(openers.map((contribution) => contribution.resourcePluginId)).toEqual([
      "kanbaner.tasks",
      "kanbaner.tasks",
    ]);
    expect(openers.map((contribution) => contribution.route)).toEqual([KANBAN_ROUTE, KANBAN_ROUTE]);

    expect(
      projectsUiContributions.find(
        (contribution) => contribution.id === "kanbaner.projects.navigation",
      ),
    ).toMatchObject({
      kind: "navigation",
      slot: "app.sidebar",
      title: "Проекты",
      route: "/view/projects?entry=1",
    });
  });
});
