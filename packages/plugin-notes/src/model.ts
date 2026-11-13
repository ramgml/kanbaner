import type {
  ResourceDescriptor,
  ResourceLink,
  ResourceRef,
  SearchIndexStrategy,
  UtcTimestamp,
} from "@kanbaner/plugin-sdk";

export const NOTE_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type NoteAttachmentMimeType = (typeof NOTE_ATTACHMENT_MIME_TYPES)[number];

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly contentMarkdown: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly version: number;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface NoteActivity {
  readonly noteId: string;
  readonly favorite: boolean;
  readonly lastOpenedAt: UtcTimestamp | null;
  readonly updatedAt: UtcTimestamp;
}

export interface NoteAttachment {
  readonly id: string;
  readonly noteId: string;
  readonly mimeType: NoteAttachmentMimeType;
  readonly sizeBytes: number;
  readonly contentBase64: string;
  readonly createdAt: UtcTimestamp;
}

export type NoteAttachmentDescriptor = Omit<NoteAttachment, "contentBase64">;

export interface NoteView {
  readonly note: Note;
  readonly favorite: boolean;
  readonly lastOpenedAt: UtcTimestamp | null;
  readonly childCount: number;
}

export interface StorePage<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly nextOffset: number | null;
}

export type NoteListPage = StorePage<NoteView>;

export interface NoteDetails {
  readonly view: NoteView;
  readonly ancestors: readonly Note[];
  readonly attachments: readonly NoteAttachmentDescriptor[];
}

/** Свежий снимок поддерева для подтверждения каскадного удаления. */
export interface NoteSubtree {
  readonly noteId: string;
  /** Количество заметок в поддереве, включая корневую. */
  readonly noteCount: number;
  readonly attachmentCount: number;
}

export interface NoteDeleteSuccess {
  readonly deleted: true;
  readonly deletedNotes: readonly Note[];
  readonly deletedAttachmentIds: readonly string[];
  readonly deletedResourceRefs: readonly ResourceRef[];
}

export interface NoteDeleteNoop {
  readonly deleted: false;
}

export type NoteDeleteResult = NoteDeleteSuccess | NoteDeleteNoop;

export interface NoteMoveResult {
  readonly note: Note;
  readonly affectedNotes: readonly Note[];
}

export interface NoteSearchHit {
  readonly ref: ResourceRef;
  readonly noteId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly score: number;
  readonly strategy: SearchIndexStrategy;
  readonly parentId: string | null;
}

export interface NoteSearchPage {
  readonly items: readonly NoteSearchHit[];
  readonly nextOffset: number | null;
}

export interface ResolvedNoteLink {
  readonly link: ResourceLink;
  readonly source: ResourceDescriptor | null;
  readonly target: ResourceDescriptor | null;
}

export interface NoteExport {
  readonly fileName: string;
  readonly mediaType: "text/markdown";
  readonly content: string;
}
