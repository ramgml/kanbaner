import type { UiContribution } from "@kanbaner/plugin-sdk";

export const OPENCODE_PLUGIN_ID = "kanbaner.opencode" as const;
export const OPENCODE_AGENT_ID = "kanbaner" as const;
export const OPENCODE_UI_CONTRACT = "kanbaner.opencode.ui.v1" as const;
export const OPENCODE_ASSISTANT_SLOT = "app.assistant" as const;

export const opencodeUiContributions: readonly UiContribution[] = Object.freeze([
  {
    id: "kanbaner.opencode.assistant",
    slot: OPENCODE_ASSISTANT_SLOT,
    kind: "panel",
    priority: 100,
    title: "OpenCode",
    description: "Чат с моделями и провайдерами OpenCode",
  },
]);
