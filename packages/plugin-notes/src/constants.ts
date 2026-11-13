export const NOTES_PLUGIN_ID = "kanbaner.notes" as const;
export const NOTES_CONTRACT_VERSION = 1 as const;
export const NOTES_COMMANDS_CONTRACT = "kanbaner.notes.commands.v1" as const;
export const NOTES_QUERIES_CONTRACT = "kanbaner.notes.queries.v1" as const;
export const NOTES_EVENTS_CONTRACT = "kanbaner.notes.events.v1" as const;
export const NOTES_UI_CONTRACT = "kanbaner.notes.ui.v1" as const;
export const NOTES_STORE_CONTRACT = "kanbaner.notes.store.v1" as const;

export const NOTE_RESOURCE_TYPE = "note" as const;
export const NOTES_RELATION = "kanbaner.notes.references" as const;
export const NOTES_ROUTE = "/view/notes" as const;

export const NOTE_COLLECTION = "notes" as const;
export const NOTE_ACTIVITY_COLLECTION = "note-activity" as const;
export const NOTE_ATTACHMENT_COLLECTION = "note-attachments" as const;
export const NOTES_IDEMPOTENCY_COLLECTION = "idempotency" as const;

export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_CONTENT_MAX_LENGTH = 2_000_000;
export const NOTE_MAX_TREE_DEPTH = 64;
export const NOTE_MAX_ATTACHMENTS = 40;
export const NOTE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const NOTE_DEFAULT_LIST_LIMIT = 50;
export const NOTE_MAX_LIST_LIMIT = 100;
export const NOTE_RECENT_LIMIT = 20;

export const NOTES_COMMAND_IDS = Object.freeze({
  create: "kanbaner.notes.note.create",
  update: "kanbaner.notes.note.update",
  move: "kanbaner.notes.note.move",
  delete: "kanbaner.notes.note.delete",
  favoriteSet: "kanbaner.notes.note.favorite.set",
  recordVisit: "kanbaner.notes.note.visit",
  link: "kanbaner.notes.note.link",
  unlink: "kanbaner.notes.note.unlink",
  attachmentCreate: "kanbaner.notes.note.attachment.create",
  attachmentDelete: "kanbaner.notes.note.attachment.delete",
} as const);

export const NOTES_QUERY_IDS = Object.freeze({
  get: "kanbaner.notes.note.get",
  subtree: "kanbaner.notes.note.subtree",
  list: "kanbaner.notes.note.list",
  search: "kanbaner.notes.note.search",
  links: "kanbaner.notes.note.links",
  attachmentGet: "kanbaner.notes.note.attachment.get",
  export: "kanbaner.notes.note.export",
} as const);

export const NOTES_EVENT_TYPES = Object.freeze({
  created: "kanbaner.notes.note.created",
  updated: "kanbaner.notes.note.updated",
  moved: "kanbaner.notes.note.moved",
  deleted: "kanbaner.notes.note.deleted",
} as const);

export type NotesEventType = (typeof NOTES_EVENT_TYPES)[keyof typeof NOTES_EVENT_TYPES];
