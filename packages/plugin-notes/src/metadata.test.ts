import { describe, expect, it } from "vitest";

import { NOTES_ROUTE } from "./constants.ts";
import { notesUiContributions } from "./metadata.ts";

describe("metadata UI-вкладов заметок", () => {
  it("декларирует отдельную иконку только для navigation-вклада", () => {
    const navigation = notesUiContributions.find(
      (contribution) => contribution.id === "kanbaner.notes.navigation",
    );

    expect(navigation).toMatchObject({
      kind: "navigation",
      slot: "app.sidebar",
      title: "Заметки",
      route: NOTES_ROUTE,
      icon: "notebook-tabs",
    });
    expect(
      notesUiContributions.filter((contribution) => contribution.icon !== undefined),
    ).toHaveLength(1);
  });

  it("публикует дерево как отдельный panel-вклад глобального sidebar", () => {
    expect(
      notesUiContributions.find((contribution) => contribution.id === "kanbaner.notes.sidebar"),
    ).toMatchObject({
      slot: "app.sidebar",
      kind: "panel",
      priority: 20,
      title: "Заметки",
    });
  });
});
