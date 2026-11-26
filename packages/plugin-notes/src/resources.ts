import { formatResourceRef, parseResourceRef, type ResourceRef } from "@kanbaner/plugin-sdk";

import { NOTE_RESOURCE_TYPE, NOTES_PLUGIN_ID } from "./constants.ts";

export function formatNoteRef(id: string): ResourceRef {
  return formatResourceRef({
    pluginId: NOTES_PLUGIN_ID,
    resourceType: NOTE_RESOURCE_TYPE,
    opaqueId: id,
  });
}

export function tryParseNoteRef(ref: ResourceRef): string | null {
  try {
    const parts = parseResourceRef(ref);
    return parts.pluginId === NOTES_PLUGIN_ID && parts.resourceType === NOTE_RESOURCE_TYPE
      ? parts.opaqueId
      : null;
  } catch {
    return null;
  }
}
