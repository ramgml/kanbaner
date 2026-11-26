import type { PluginActivationServices, PluginId } from "@kanbaner/plugin-sdk";

import { OPENCODE_PLUGIN_ID } from "./metadata.ts";
import { opencodeUiContributions } from "./metadata.ts";

export interface OpenCodeActivationContext extends PluginActivationServices {
  readonly pluginId: PluginId;
}

export async function activate(context: OpenCodeActivationContext): Promise<void> {
  if (context.pluginId !== OPENCODE_PLUGIN_ID) {
    throw new Error("Активация kanbaner.opencode получила другой Plugin ID");
  }
  context.ui.register(opencodeUiContributions);
}
