import { describe, expect, it, vi } from "vitest";

import type { UiContribution } from "@kanbaner/plugin-sdk";

import { activate, type KanbanActivationContext } from "./index.ts";
import {
  KANBAN_PLUGIN_ID,
  KANBAN_ROUTE,
  KANBAN_UI_CONTRACT,
  kanbanUiContributions,
} from "./metadata.ts";
import { kanbanUiPlugin } from "./ui.tsx";

describe("регистрация kanbaner.kanban", () => {
  it("activate регистрирует только UI-метаданные через публичный registrar", async () => {
    const register = vi.fn();
    const unregister = vi.fn();
    const context = {
      pluginId: KANBAN_PLUGIN_ID,
      ui: { register, unregister },
    } as unknown as KanbanActivationContext;

    await activate(context);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(kanbanUiContributions);
    expect(unregister).not.toHaveBeenCalled();
  });

  it("отклоняет активацию с чужим Plugin ID", async () => {
    const context = {
      pluginId: "kanbaner.task-list",
      ui: { register: vi.fn(), unregister: vi.fn() },
    } as unknown as KanbanActivationContext;

    await expect(activate(context)).rejects.toThrow("kanbaner.kanban");
  });

  it("маршрут /view/kanban и рендереры совпадают с серверными metadata", () => {
    expect(KANBAN_ROUTE).toBe("/view/kanban");
    expect(KANBAN_UI_CONTRACT).toBe("kanbaner.kanban.ui.v1");
    expect(kanbanUiPlugin.id).toBe(KANBAN_PLUGIN_ID);
    expect(kanbanUiPlugin.contributions).toHaveLength(kanbanUiContributions.length);

    for (const metadata of kanbanUiContributions) {
      const contribution = kanbanUiPlugin.contributions.find(
        (entry) => entry.metadata.id === metadata.id,
      );

      expect(contribution).toBeDefined();
      expect(contribution?.metadata).toEqual(metadata);
      expect(typeof contribution?.render).toBe("function");
    }

    const view = kanbanUiContributions.find((contribution) => contribution.kind === "view") as
      UiContribution | undefined;

    expect(view?.slot).toBe("app.main");
    expect(view?.route).toBe(KANBAN_ROUTE);
    expect(kanbanUiContributions.map((contribution) => contribution.slot)).toEqual([
      "app.main",
      "app.sidebar",
      "app.overlays",
    ]);
  });
});
