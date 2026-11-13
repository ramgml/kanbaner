"use client";

import type { ResourceRef, UiContribution } from "@kanbaner/plugin-sdk";

import { NOTES_PLUGIN_ID, NOTES_UI_CONTRACT } from "./constants.ts";
import { notesUiContributions } from "./metadata.ts";
import { NotesView } from "./ui/notes-view.tsx";
import { RelatedNotesPanel } from "./ui/related-notes-panel.tsx";
import type { NotesUiRendererProps } from "./ui/runtime.ts";

export { NOTES_PLUGIN_ID, NOTES_ROUTE, NOTES_UI_CONTRACT } from "./constants.ts";
export { notesUiContributions } from "./metadata.ts";
export { NotesView } from "./ui/notes-view.tsx";
export { RelatedNotesPanel } from "./ui/related-notes-panel.tsx";
export type { NotesUiRendererProps } from "./ui/runtime.ts";

function contribution(id: string): UiContribution {
  const result = notesUiContributions.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`Неизвестный UI-вклад ${id}`);
  }
  return result;
}

export const notesUiPlugin = {
  id: NOTES_PLUGIN_ID,
  contract: NOTES_UI_CONTRACT,
  contributions: [
    {
      metadata: contribution("kanbaner.notes.view"),
      render: (props: NotesUiRendererProps) => <NotesView {...props} />,
    },
    {
      metadata: contribution("kanbaner.notes.navigation"),
      render: () => null,
    },
    {
      metadata: contribution("kanbaner.notes.open"),
      render: () => null,
    },
    {
      metadata: contribution("kanbaner.notes.task-related"),
      render: (props: NotesUiRendererProps) => {
        const resourceRef = props.context?.resourceRef;
        return typeof resourceRef === "string" ? (
          <RelatedNotesPanel
            resourceRef={resourceRef as ResourceRef}
            invoke={props.invoke}
            openResource={props.openResource}
          />
        ) : null;
      },
    },
  ],
} as const;
