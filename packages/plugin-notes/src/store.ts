import {
  isStorageErrorShape,
  type JsonValue,
  type PluginDocument,
  type PluginDocumentStore,
  type PluginStorage,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import {
  NOTE_ACTIVITY_COLLECTION,
  NOTE_ATTACHMENT_COLLECTION,
  NOTE_ATTACHMENT_MAX_BYTES,
  NOTE_COLLECTION,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_DEFAULT_LIST_LIMIT,
  NOTE_MAX_ATTACHMENTS,
  NOTE_MAX_LIST_LIMIT,
  NOTE_MAX_TREE_DEPTH,
  NOTE_TITLE_MAX_LENGTH,
  NOTES_PLUGIN_ID,
} from "./constants.ts";
import {
  attachmentIdFromUrl,
  extractAttachmentIds,
  markdownImageUrls,
  replaceMarkdownImageUrls,
} from "./markdown-attachments.ts";
import type {
  Note,
  NoteActivity,
  NoteAttachment,
  NoteAttachmentDescriptor,
  NoteAttachmentMimeType,
  NoteDeleteResult,
  NoteDetails,
  NoteExport,
  NoteListPage,
  NoteMoveResult,
  NoteView,
} from "./model.ts";
import { formatNoteRef } from "./resources.ts";
import type {
  NoteAttachmentCreateInput,
  NoteListInput,
  NoteMoveInput,
  NoteUpdateInput,
} from "./schemas.ts";

export class NotesValidationError extends Error {
  override readonly name = "NotesValidationError";
  constructor(
    message: string,
    readonly reason: string = "VALIDATION_ERROR",
  ) {
    super(message);
  }
}

export class NotesNotFoundError extends Error {
  override readonly name = "NotesNotFoundError";
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} не найден: ${id}`);
  }
}

export class NotesVersionConflictError extends Error {
  override readonly name = "NotesVersionConflictError";
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`Конфликт версий: ожидалась ${expectedVersion}, фактическая ${actualVersion}`);
  }
}

export interface NotesStore {
  createNote(input: {
    id: string;
    parentId?: string | null;
    title?: string;
    contentMarkdown?: string;
    createdAt: UtcTimestamp;
  }): Promise<NoteDetails>;
  updateNote(input: NoteUpdateInput & { updatedAt: UtcTimestamp }): Promise<NoteDetails>;
  moveNote(input: NoteMoveInput & { updatedAt: UtcTimestamp }): Promise<NoteMoveResult>;
  deleteNote(input: {
    id: string;
    expectedVersion: number;
    confirm: true;
  }): Promise<NoteDeleteResult>;
  getNote(id: string): Promise<NoteDetails | null>;
  listNotes(input: NoteListInput): Promise<NoteListPage>;
  listAllNotes(): Promise<readonly Note[]>;
  setFavorite(input: { id: string; favorite: boolean; updatedAt: UtcTimestamp }): Promise<NoteView>;
  recordVisit(input: { id: string; visitedAt: UtcTimestamp }): Promise<NoteView>;
  createAttachment(
    input: NoteAttachmentCreateInput & { id: string; createdAt: UtcTimestamp },
  ): Promise<NoteAttachment>;
  getAttachment(id: string): Promise<NoteAttachment | null>;
  deleteAttachment(input: { id: string; confirm: true }): Promise<boolean>;
  listAttachments(noteId: string): Promise<readonly NoteAttachment[]>;
  exportNote(id: string): Promise<NoteExport | null>;
}

export interface CreateNotesStoreOptions {
  readonly storage: PluginStorage;
}

function dataOf<T>(document: PluginDocument): T {
  if (typeof document.data !== "object" || document.data === null || Array.isArray(document.data)) {
    throw new NotesValidationError("Повреждён документ заметок", "STORE_VALIDATION");
  }
  return document.data as unknown as T;
}

function toNote(document: PluginDocument): Note {
  const note = dataOf<Note>(document);
  if (
    note.id !== document.id ||
    typeof note.title !== "string" ||
    typeof note.contentMarkdown !== "string" ||
    (typeof note.parentId !== "string" && note.parentId !== null) ||
    !Number.isInteger(note.position) ||
    note.version !== document.version ||
    typeof note.createdAt !== "string" ||
    typeof note.updatedAt !== "string"
  ) {
    throw new NotesValidationError("Повреждён документ заметки", "STORE_VALIDATION");
  }
  return note;
}

function toActivity(document: PluginDocument): NoteActivity {
  const activity = dataOf<NoteActivity>(document);
  if (
    activity.noteId !== document.id ||
    typeof activity.favorite !== "boolean" ||
    (typeof activity.lastOpenedAt !== "string" && activity.lastOpenedAt !== null) ||
    typeof activity.updatedAt !== "string"
  ) {
    throw new NotesValidationError("Повреждена активность заметки", "STORE_VALIDATION");
  }
  return activity;
}

function toAttachment(document: PluginDocument): NoteAttachment {
  const attachment = dataOf<NoteAttachment>(document);
  if (
    attachment.id !== document.id ||
    typeof attachment.noteId !== "string" ||
    typeof attachment.mimeType !== "string" ||
    !Number.isInteger(attachment.sizeBytes) ||
    typeof attachment.contentBase64 !== "string" ||
    typeof attachment.createdAt !== "string"
  ) {
    throw new NotesValidationError("Повреждено вложение заметки", "STORE_VALIDATION");
  }
  return attachment;
}

function descriptor(attachment: NoteAttachment): NoteAttachmentDescriptor {
  return {
    id: attachment.id,
    noteId: attachment.noteId,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt,
  };
}

function normalizeTitle(title: string | undefined): string {
  const normalized = (title ?? "Без названия").trim();
  if (normalized.length === 0) {
    return "Без названия";
  }
  if (normalized.length > NOTE_TITLE_MAX_LENGTH || /[\r\n]/.test(normalized)) {
    throw new NotesValidationError(
      "Заголовок заметки слишком длинный или содержит перевод строки",
      "INVALID_TITLE",
    );
  }
  return normalized;
}

function comparePosition(left: Note, right: Note): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function compareUpdated(left: Note, right: Note): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function page<T>(items: readonly T[], total: number, limit: number, offset: number) {
  const nextOffset = offset + limit < total ? offset + limit : null;
  return { items, total, nextOffset };
}

function decodeBase64(content: string): Uint8Array {
  if (content.length === 0 || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw new NotesValidationError("Изображение имеет некорректный base64", "INVALID_ATTACHMENT");
  }

  let binary: string;
  try {
    binary = globalThis.atob(content);
  } catch {
    throw new NotesValidationError("Изображение имеет некорректный base64", "INVALID_ATTACHMENT");
  }

  if (binary.length === 0 || binary.length > NOTE_ATTACHMENT_MAX_BYTES) {
    throw new NotesValidationError("Размер изображения превышает 5 MiB", "ATTACHMENT_TOO_LARGE");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function validateImageSignature(mimeType: NoteAttachmentMimeType, bytes: Uint8Array): void {
  const valid =
    mimeType === "image/png"
      ? hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : mimeType === "image/jpeg"
        ? hasPrefix(bytes, [0xff, 0xd8, 0xff])
        : mimeType === "image/gif"
          ? hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38]) && bytes[4] === 0x61
          : hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
            bytes[8] === 0x57 &&
            bytes[9] === 0x45 &&
            bytes[10] === 0x42 &&
            bytes[11] === 0x50;

  if (!valid) {
    throw new NotesValidationError(
      "Содержимое файла не соответствует формату изображения",
      "INVALID_ATTACHMENT",
    );
  }
}

async function validateContent(
  documents: PluginDocumentStore,
  noteId: string,
  content: string,
): Promise<void> {
  if (content.length > NOTE_CONTENT_MAX_LENGTH) {
    throw new NotesValidationError("Содержимое заметки слишком большое", "CONTENT_TOO_LARGE");
  }

  for (const url of markdownImageUrls(content)) {
    const attachmentId = attachmentIdFromUrl(url);
    if (attachmentId !== null) {
      const document = await documents.get(
        NOTES_PLUGIN_ID,
        NOTE_ATTACHMENT_COLLECTION,
        attachmentId,
      );
      const attachment = document === null ? null : toAttachment(document);
      if (attachment === null || attachment.noteId !== noteId) {
        throw new NotesValidationError(
          "Вложение не принадлежит этой заметке",
          "ATTACHMENT_NOT_FOUND",
        );
      }
      continue;
    }

    if (url.startsWith("attachment://") || url.startsWith("data:") || !/^https?:\/\//i.test(url)) {
      throw new NotesValidationError(
        "Изображение должно быть локальным вложением или HTTP(S) URL",
        "INVALID_IMAGE_URL",
      );
    }
  }
}

async function putNote(documents: PluginDocumentStore, note: Note): Promise<Note> {
  try {
    const document = await documents.put({
      pluginId: NOTES_PLUGIN_ID,
      collection: NOTE_COLLECTION,
      id: note.id,
      data: note as unknown as JsonValue,
      indexedFields: { parentId: note.parentId, updatedAt: note.updatedAt },
      expectedVersion: note.version - 1,
    });
    return toNote(document);
  } catch (error) {
    if (isStorageErrorShape(error) && error.code === "VERSION_CONFLICT") {
      throw new NotesVersionConflictError(note.version - 1, note.version);
    }
    throw error;
  }
}

async function allNotes(documents: PluginDocumentStore): Promise<Note[]> {
  return (await documents.list(NOTES_PLUGIN_ID, NOTE_COLLECTION)).map(toNote);
}

async function allActivities(documents: PluginDocumentStore): Promise<NoteActivity[]> {
  return (await documents.list(NOTES_PLUGIN_ID, NOTE_ACTIVITY_COLLECTION)).map(toActivity);
}

function viewOf(
  note: Note,
  activities: ReadonlyMap<string, NoteActivity>,
  notes: readonly Note[],
): NoteView {
  const activity = activities.get(note.id);
  return {
    note,
    favorite: activity?.favorite ?? false,
    lastOpenedAt: activity?.lastOpenedAt ?? null,
    childCount: notes.filter((candidate) => candidate.parentId === note.id).length,
  };
}

async function detailsOf(documents: PluginDocumentStore, note: Note): Promise<NoteDetails> {
  const [notes, activities, attachmentDocuments] = await Promise.all([
    allNotes(documents),
    allActivities(documents),
    documents.query({
      pluginId: NOTES_PLUGIN_ID,
      collection: NOTE_ATTACHMENT_COLLECTION,
      indexedFields: { noteId: note.id },
      sort: { field: "createdAt", direction: "asc" },
    }),
  ]);
  const byId = new Map(notes.map((candidate) => [candidate.id, candidate]));
  const ancestors: Note[] = [];
  const seen = new Set([note.id]);
  let parentId = note.parentId;

  while (parentId !== null) {
    if (seen.has(parentId)) {
      throw new NotesValidationError("Обнаружен цикл в дереве заметок", "STORE_VALIDATION");
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      throw new NotesNotFoundError("Родительская заметка", parentId);
    }
    ancestors.unshift(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }

  return {
    view: viewOf(note, new Map(activities.map((activity) => [activity.noteId, activity])), notes),
    ancestors,
    attachments: attachmentDocuments.map(toAttachment).map(descriptor),
  };
}

async function requiredNote(documents: PluginDocumentStore, id: string): Promise<Note> {
  const document = await documents.get(NOTES_PLUGIN_ID, NOTE_COLLECTION, id);
  if (document === null) {
    throw new NotesNotFoundError("Заметка", id);
  }
  return toNote(document);
}

async function putActivity(
  documents: PluginDocumentStore,
  activity: NoteActivity,
  expectedVersion: number,
): Promise<void> {
  await documents.put({
    pluginId: NOTES_PLUGIN_ID,
    collection: NOTE_ACTIVITY_COLLECTION,
    id: activity.noteId,
    data: activity as unknown as JsonValue,
    indexedFields: {
      favorite: activity.favorite,
      lastOpenedAt: activity.lastOpenedAt,
      updatedAt: activity.updatedAt,
    },
    expectedVersion,
  });
}

function descendantsOf(notes: readonly Note[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const note of notes) {
      if (note.parentId !== null && result.has(note.parentId) && !result.has(note.id)) {
        result.add(note.id);
        changed = true;
      }
    }
  }
  return result;
}

function ensureMoveDepth(notes: readonly Note[], moving: Note, parentId: string | null): void {
  const byId = new Map(notes.map((note) => [note.id, note]));
  let depth = 1;
  let cursor = parentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new NotesValidationError("Перемещение создаёт цикл", "NOTE_TREE_CYCLE");
    }
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (parent === undefined) {
      throw new NotesNotFoundError("Родительская заметка", cursor);
    }
    depth += 1;
    cursor = parent.parentId;
  }

  const subtree = descendantsOf(notes, moving.id);
  const children = new Map<string | null, Note[]>();
  for (const id of subtree) {
    const note = byId.get(id);
    if (note !== undefined) {
      const siblings = children.get(note.parentId) ?? [];
      siblings.push(note);
      children.set(note.parentId, siblings);
    }
  }
  const height = (id: string): number => {
    const nested = children.get(id) ?? [];
    return nested.length === 0 ? 1 : 1 + Math.max(...nested.map((note) => height(note.id)));
  };
  if (depth + height(moving.id) - 1 > NOTE_MAX_TREE_DEPTH) {
    throw new NotesValidationError("Превышена максимальная глубина дерева", "NOTE_TREE_TOO_DEEP");
  }
}

function exportFileName(title: string): string {
  const safe = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return `${safe.length === 0 ? "note" : safe.slice(0, 80)}.md`;
}

export function createNotesStore(options: CreateNotesStoreOptions): NotesStore {
  const { storage } = options;
  const documents = storage.documents;

  return {
    async createNote(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        const parentId = input.parentId ?? null;
        const notes = await allNotes(tx);
        if (parentId !== null && !notes.some((note) => note.id === parentId)) {
          throw new NotesNotFoundError("Родительская заметка", parentId);
        }
        const title = normalizeTitle(input.title);
        const contentMarkdown = input.contentMarkdown ?? "";
        await validateContent(tx, input.id, contentMarkdown);
        const parent = parentId === null ? null : notes.find((note) => note.id === parentId);
        if (parent !== null && parent !== undefined) {
          const parentDetails = await detailsOf(tx, parent);
          if (parentDetails.ancestors.length + 2 > NOTE_MAX_TREE_DEPTH) {
            throw new NotesValidationError(
              "Превышена максимальная глубина дерева",
              "NOTE_TREE_TOO_DEEP",
            );
          }
        }
        const siblings = notes.filter((note) => note.parentId === parentId);
        const position =
          siblings.length === 0 ? 0 : Math.max(...siblings.map((note) => note.position)) + 1;
        const note = await putNote(tx, {
          id: input.id,
          title,
          contentMarkdown,
          parentId,
          position,
          version: 1,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        });
        return detailsOf(tx, note);
      });
    },

    async updateNote(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        const current = await requiredNote(tx, input.id);
        if (current.version !== input.expectedVersion) {
          throw new NotesVersionConflictError(input.expectedVersion, current.version);
        }
        if (input.title === undefined && input.contentMarkdown === undefined) {
          throw new NotesValidationError("Передайте title или contentMarkdown", "EMPTY_PATCH");
        }
        const title = input.title === undefined ? current.title : normalizeTitle(input.title);
        const contentMarkdown = input.contentMarkdown ?? current.contentMarkdown;
        await validateContent(tx, current.id, contentMarkdown);
        if (title === current.title && contentMarkdown === current.contentMarkdown) {
          return detailsOf(tx, current);
        }
        const note = await putNote(tx, {
          ...current,
          title,
          contentMarkdown,
          version: current.version + 1,
          updatedAt: input.updatedAt,
        });
        return detailsOf(tx, note);
      });
    },

    async moveNote(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        const notes = await allNotes(tx);
        const current = notes.find((note) => note.id === input.id);
        if (current === undefined) {
          throw new NotesNotFoundError("Заметка", input.id);
        }
        if (current.version !== input.expectedVersion) {
          throw new NotesVersionConflictError(input.expectedVersion, current.version);
        }
        if (
          input.parentId === current.id ||
          descendantsOf(notes, current.id).has(input.parentId ?? "")
        ) {
          throw new NotesValidationError(
            "Нельзя переместить страницу внутрь самой себя",
            "NOTE_TREE_CYCLE",
          );
        }
        ensureMoveDepth(notes, current, input.parentId);

        const sameParent = current.parentId === input.parentId;
        const sourceSiblings = notes
          .filter((note) => note.parentId === current.parentId && note.id !== current.id)
          .sort(comparePosition);
        const targetSiblings = sameParent
          ? sourceSiblings
          : notes
              .filter((note) => note.parentId === input.parentId && note.id !== current.id)
              .sort(comparePosition);
        const index =
          input.position === undefined
            ? targetSiblings.length
            : Math.min(input.position, targetSiblings.length);
        targetSiblings.splice(index, 0, current);

        const updates = new Map<string, Note>();
        sourceSiblings.forEach((note, position) => {
          if (!sameParent && note.position !== position) {
            updates.set(note.id, {
              ...note,
              position,
              version: note.version + 1,
              updatedAt: input.updatedAt,
            });
          }
        });
        targetSiblings.forEach((note, position) => {
          const parentId = input.parentId;
          if (note.id === current.id || note.position !== position || note.parentId !== parentId) {
            updates.set(note.id, {
              ...note,
              parentId,
              position,
              version: note.version + 1,
              updatedAt: input.updatedAt,
            });
          }
        });

        const affectedNotes: Note[] = [];
        for (const note of updates.values()) {
          affectedNotes.push(await putNote(tx, note));
        }
        const moved = affectedNotes.find((note) => note.id === current.id);
        if (moved === undefined) {
          throw new NotesValidationError("Перемещение не изменило заметку", "STORE_VALIDATION");
        }
        return { note: moved, affectedNotes };
      });
    },

    async deleteNote(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        const notes = await allNotes(tx);
        const current = notes.find((note) => note.id === input.id);
        if (current === undefined) {
          return { deleted: false };
        }
        if (current.version !== input.expectedVersion) {
          throw new NotesVersionConflictError(input.expectedVersion, current.version);
        }
        const subtree = descendantsOf(notes, current.id);
        const deletedNotes = notes.filter((note) => subtree.has(note.id)).sort(comparePosition);
        const attachmentDocuments = await documents.query({
          pluginId: NOTES_PLUGIN_ID,
          collection: NOTE_ATTACHMENT_COLLECTION,
        });
        const deletedAttachments = attachmentDocuments
          .map(toAttachment)
          .filter((attachment) => subtree.has(attachment.noteId));

        for (const attachment of deletedAttachments) {
          await documents.delete(NOTES_PLUGIN_ID, NOTE_ATTACHMENT_COLLECTION, attachment.id);
        }
        for (const note of deletedNotes) {
          await documents.delete(NOTES_PLUGIN_ID, NOTE_ACTIVITY_COLLECTION, note.id);
          await documents.delete(NOTES_PLUGIN_ID, NOTE_COLLECTION, note.id, {
            expectedVersion: note.version,
          });
        }
        return {
          deleted: true,
          deletedNotes,
          deletedAttachmentIds: deletedAttachments.map((attachment) => attachment.id),
          deletedResourceRefs: deletedNotes.map((note) => formatNoteRef(note.id)),
        };
      });
    },

    async getNote(id) {
      const document = await documents.get(NOTES_PLUGIN_ID, NOTE_COLLECTION, id);
      return document === null ? null : detailsOf(documents, toNote(document));
    },

    async listNotes(input) {
      const limit = input.limit ?? NOTE_DEFAULT_LIST_LIMIT;
      const offset = input.offset ?? 0;
      if (limit < 1 || limit > NOTE_MAX_LIST_LIMIT || offset < 0) {
        throw new NotesValidationError("Некорректная пагинация", "INVALID_PAGINATION");
      }
      const [notes, activities] = await Promise.all([
        allNotes(documents),
        allActivities(documents),
      ]);
      const activityByNote = new Map(activities.map((activity) => [activity.noteId, activity]));
      const candidates = notes.filter((note) => {
        if (input.parentId !== undefined && note.parentId !== input.parentId) return false;
        if (input.favorite === true && activityByNote.get(note.id)?.favorite !== true) return false;
        if (input.recent === true && activityByNote.get(note.id)?.lastOpenedAt == null)
          return false;
        return true;
      });

      if (input.recent === true) {
        candidates.sort((left, right) => {
          const leftOpened = activityByNote.get(left.id)?.lastOpenedAt ?? "";
          const rightOpened = activityByNote.get(right.id)?.lastOpenedAt ?? "";
          return rightOpened.localeCompare(leftOpened) || left.id.localeCompare(right.id);
        });
      } else if (input.favorite === true || input.parentId === undefined) {
        candidates.sort(compareUpdated);
      } else {
        candidates.sort(comparePosition);
      }

      return page(
        candidates.slice(offset, offset + limit).map((note) => viewOf(note, activityByNote, notes)),
        candidates.length,
        limit,
        offset,
      );
    },

    async listAllNotes() {
      return allNotes(documents);
    },

    async setFavorite(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        const note = await requiredNote(tx, input.id);
        const existing = await tx.get(NOTES_PLUGIN_ID, NOTE_ACTIVITY_COLLECTION, input.id);
        const activity: NoteActivity = {
          noteId: input.id,
          favorite: input.favorite,
          lastOpenedAt: existing === null ? null : toActivity(existing).lastOpenedAt,
          updatedAt: input.updatedAt,
        };
        await putActivity(tx, activity, existing?.version ?? 0);
        const notes = await allNotes(tx);
        return viewOf(note, new Map([[input.id, activity]]), notes);
      });
    },

    async recordVisit(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        const note = await requiredNote(tx, input.id);
        const existing = await tx.get(NOTES_PLUGIN_ID, NOTE_ACTIVITY_COLLECTION, input.id);
        const activity: NoteActivity = {
          noteId: input.id,
          favorite: existing === null ? false : toActivity(existing).favorite,
          lastOpenedAt: input.visitedAt,
          updatedAt: input.visitedAt,
        };
        await putActivity(tx, activity, existing?.version ?? 0);
        const notes = await allNotes(tx);
        return viewOf(note, new Map([[input.id, activity]]), notes);
      });
    },

    async createAttachment(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        await requiredNote(tx, input.noteId);
        const existing = await tx.query({
          pluginId: NOTES_PLUGIN_ID,
          collection: NOTE_ATTACHMENT_COLLECTION,
          indexedFields: { noteId: input.noteId },
        });
        if (existing.length >= NOTE_MAX_ATTACHMENTS) {
          throw new NotesValidationError("Достигнут лимит вложений заметки", "ATTACHMENT_LIMIT");
        }
        const bytes = decodeBase64(input.contentBase64);
        validateImageSignature(input.mimeType, bytes);
        const attachment: NoteAttachment = {
          id: input.id,
          noteId: input.noteId,
          mimeType: input.mimeType,
          sizeBytes: bytes.length,
          contentBase64: input.contentBase64,
          createdAt: input.createdAt,
        };
        const document = await tx.put({
          pluginId: NOTES_PLUGIN_ID,
          collection: NOTE_ATTACHMENT_COLLECTION,
          id: input.id,
          data: attachment as unknown as JsonValue,
          indexedFields: { noteId: input.noteId, mimeType: input.mimeType },
          expectedVersion: 0,
        });
        return toAttachment(document);
      });
    },

    async getAttachment(id) {
      const document = await documents.get(NOTES_PLUGIN_ID, NOTE_ATTACHMENT_COLLECTION, id);
      return document === null ? null : toAttachment(document);
    },

    async deleteAttachment(input) {
      return storage.withTransaction(async ({ documents: tx }) => {
        const document = await tx.get(NOTES_PLUGIN_ID, NOTE_ATTACHMENT_COLLECTION, input.id);
        if (document === null) return false;
        const attachment = toAttachment(document);
        const note = await requiredNote(tx, attachment.noteId);
        if (extractAttachmentIds(note.contentMarkdown).includes(input.id)) {
          throw new NotesValidationError(
            "Сначала удалите изображение из содержимого",
            "ATTACHMENT_IN_USE",
          );
        }
        return tx.delete(NOTES_PLUGIN_ID, NOTE_ATTACHMENT_COLLECTION, input.id, {
          expectedVersion: document.version,
        });
      });
    },

    async listAttachments(noteId) {
      const result = await documents.query({
        pluginId: NOTES_PLUGIN_ID,
        collection: NOTE_ATTACHMENT_COLLECTION,
        indexedFields: { noteId },
        sort: { field: "createdAt", direction: "asc" },
      });
      return result.map(toAttachment);
    },

    async exportNote(id) {
      const noteDocument = await documents.get(NOTES_PLUGIN_ID, NOTE_COLLECTION, id);
      if (noteDocument === null) return null;
      const note = toNote(noteDocument);
      const attachments = await this.listAttachments(id);
      const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
      const content = replaceMarkdownImageUrls(note.contentMarkdown, (url) => {
        const attachmentId = attachmentIdFromUrl(url);
        const attachment = attachmentId === null ? undefined : byId.get(attachmentId);
        return attachment === undefined
          ? url
          : `data:${attachment.mimeType};base64,${attachment.contentBase64}`;
      });
      return {
        fileName: exportFileName(note.title),
        mediaType: "text/markdown",
        content: `# ${note.title}\n\n${content}`,
      };
    },
  };
}
