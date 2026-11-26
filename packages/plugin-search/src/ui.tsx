"use client";

import type { UiContribution } from "@kanbaner/plugin-sdk";

import { SEARCH_PLUGIN_ID, SEARCH_UI_CONTRACT } from "./constants.ts";
import { searchUiContributions } from "./metadata.ts";
import { SearchView } from "./ui/search-view.tsx";
import type { SearchUiRendererProps } from "./ui/runtime.ts";

export { SEARCH_PLUGIN_ID, SEARCH_ROUTE, SEARCH_UI_CONTRACT } from "./constants.ts";
export { searchUiContributions } from "./metadata.ts";
export { SearchView } from "./ui/search-view.tsx";
export type { SearchUiRendererProps } from "./ui/runtime.ts";

function contribution(id: string): UiContribution {
  const result = searchUiContributions.find((candidate) => candidate.id === id);

  if (result === undefined) {
    throw new Error(`Неизвестный UI-вклад ${id}`);
  }

  return result;
}

export const searchUiPlugin = {
  id: SEARCH_PLUGIN_ID,
  contract: SEARCH_UI_CONTRACT,
  contributions: [
    {
      metadata: contribution("kanbaner.search.view"),
      render: (props: SearchUiRendererProps) => <SearchView {...props} />,
    },
    {
      metadata: contribution("kanbaner.search.navigation"),
      render: () => null,
    },
  ],
} as const;
