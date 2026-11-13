import type { PluginActivationServices, PluginId } from "@kanbaner/plugin-sdk";

import { NOTES_PLUGIN_ID } from "./constants.ts";

export interface NotesActivationContext extends PluginActivationServices {
  readonly pluginId: PluginId;
}

/** Базовая заглушка composition; доменная регистрация добавляется отдельной задачей. */
export async function activate(context: NotesActivationContext): Promise<void> {
  if (context.pluginId !== NOTES_PLUGIN_ID) {
    throw new Error("Активация kanbaner.notes получила другой Plugin ID");
  }
}

export async function deactivate(): Promise<void> {
  // Намеренно пусто.
}
