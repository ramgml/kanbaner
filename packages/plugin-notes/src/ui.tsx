"use client";

import { NOTES_PLUGIN_ID, NOTES_UI_CONTRACT } from "./constants.ts";

export { NOTES_PLUGIN_ID, NOTES_ROUTE, NOTES_UI_CONTRACT } from "./constants.ts";

/** UI-вклады подключаются после доменной активации и редактора. */
export const notesUiPlugin = {
  id: NOTES_PLUGIN_ID,
  contract: NOTES_UI_CONTRACT,
  contributions: [],
} as const;
