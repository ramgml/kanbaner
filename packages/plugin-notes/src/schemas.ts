import { Type, type Static } from "@sinclair/typebox";
import {
  DRAFT_2020_12,
  ResourceDescriptorSchema,
  ResourceLinkSchema,
  ResourceRefSchema,
  UtcTimestampSchema,
} from "@kanbaner/plugin-sdk";

import {
  NOTE_ATTACHMENT_MAX_BYTES,
  NOTE_CONTENT_MAX_LENGTH,
  NOTE_MAX_LIST_LIMIT,
  NOTE_TITLE_MAX_LENGTH,
} from "./constants.ts";
import { NOTE_ATTACHMENT_MIME_TYPES } from "./model.ts";

const Id = Type.String({ minLength: 1, maxLength: 160 });
const ExpectedVersion = Type.Integer({ minimum: 0 });
const Limit = Type.Integer({ minimum: 1, maximum: NOTE_MAX_LIST_LIMIT, default: 50 });
const Offset = Type.Integer({ minimum: 0, default: 0 });

export const NoteAttachmentMimeTypeSchema = Type.Union(
  NOTE_ATTACHMENT_MIME_TYPES.map((value) => Type.Literal(value)),
);

export const NoteSchema = Type.Object(
  {
    id: Id,
    title: Type.String({ minLength: 1, maxLength: NOTE_TITLE_MAX_LENGTH }),
    contentMarkdown: Type.String({ maxLength: NOTE_CONTENT_MAX_LENGTH }),
    parentId: Type.Union([Id, Type.Null()]),
    position: Type.Integer({ minimum: 0 }),
    version: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  DRAFT_2020_12,
);

export const NoteActivitySchema = Type.Object(
  {
    noteId: Id,
    favorite: Type.Boolean(),
    lastOpenedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    updatedAt: UtcTimestampSchema,
  },
  DRAFT_2020_12,
);

export const NoteAttachmentDescriptorSchema = Type.Object(
  {
    id: Id,
    noteId: Id,
    mimeType: NoteAttachmentMimeTypeSchema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: NOTE_ATTACHMENT_MAX_BYTES }),
    createdAt: UtcTimestampSchema,
  },
  DRAFT_2020_12,
);

export const NoteAttachmentSchema = Type.Object(
  {
    ...NoteAttachmentDescriptorSchema.properties,
    contentBase64: Type.String({ minLength: 4 }),
  },
  DRAFT_2020_12,
);

export const NoteViewSchema = Type.Object(
  {
    note: NoteSchema,
    favorite: Type.Boolean(),
    lastOpenedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    childCount: Type.Integer({ minimum: 0 }),
  },
  DRAFT_2020_12,
);

export const NoteDetailsSchema = Type.Object(
  {
    view: NoteViewSchema,
    ancestors: Type.Array(NoteSchema),
    attachments: Type.Array(NoteAttachmentDescriptorSchema),
  },
  DRAFT_2020_12,
);

export const NoteCreateInputSchema = Type.Object(
  {
    parentId: Type.Optional(Type.Union([Id, Type.Null()])),
    title: Type.Optional(Type.String({ maxLength: NOTE_TITLE_MAX_LENGTH })),
    contentMarkdown: Type.Optional(Type.String({ maxLength: NOTE_CONTENT_MAX_LENGTH })),
  },
  DRAFT_2020_12,
);

export const NoteUpdateInputSchema = Type.Object(
  {
    id: Id,
    expectedVersion: ExpectedVersion,
    title: Type.Optional(Type.String({ maxLength: NOTE_TITLE_MAX_LENGTH })),
    contentMarkdown: Type.Optional(Type.String({ maxLength: NOTE_CONTENT_MAX_LENGTH })),
  },
  DRAFT_2020_12,
);

export const NoteMoveInputSchema = Type.Object(
  {
    id: Id,
    expectedVersion: ExpectedVersion,
    parentId: Type.Union([Id, Type.Null()]),
    position: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  DRAFT_2020_12,
);

export const NoteDeleteInputSchema = Type.Object(
  {
    id: Id,
    expectedVersion: ExpectedVersion,
    confirm: Type.Literal(true),
  },
  DRAFT_2020_12,
);

export const NoteDeleteSuccessSchema = Type.Object(
  {
    deleted: Type.Literal(true),
    deletedNotes: Type.Array(NoteSchema),
    deletedAttachmentIds: Type.Array(Id),
    deletedResourceRefs: Type.Array(ResourceRefSchema),
  },
  DRAFT_2020_12,
);

export const NoteDeleteOutputSchema = Type.Union([
  NoteDeleteSuccessSchema,
  Type.Object({ deleted: Type.Literal(false) }, DRAFT_2020_12),
]);

export const NoteMoveOutputSchema = Type.Object(
  { view: NoteViewSchema, affectedNotes: Type.Array(NoteSchema) },
  DRAFT_2020_12,
);

export const NoteFavoriteInputSchema = Type.Object(
  { id: Id, favorite: Type.Boolean() },
  DRAFT_2020_12,
);

export const NoteVisitInputSchema = Type.Object({ id: Id }, DRAFT_2020_12);
export const NoteGetInputSchema = Type.Object({ id: Id }, DRAFT_2020_12);

export const NoteListInputSchema = Type.Object(
  {
    parentId: Type.Optional(Type.Union([Id, Type.Null()])),
    favorite: Type.Optional(Type.Boolean()),
    recent: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Limit),
    offset: Type.Optional(Offset),
  },
  DRAFT_2020_12,
);

export const NoteListOutputSchema = Type.Object(
  {
    items: Type.Array(NoteViewSchema),
    total: Type.Integer({ minimum: 0 }),
    nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  DRAFT_2020_12,
);

export const NoteSearchInputSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 500 }),
    limit: Type.Optional(Limit),
    offset: Type.Optional(Offset),
  },
  DRAFT_2020_12,
);

export const NoteSearchHitSchema = Type.Object(
  {
    ref: ResourceRefSchema,
    noteId: Id,
    title: Type.String({ minLength: 1 }),
    excerpt: Type.String(),
    score: Type.Number(),
    strategy: Type.Union([Type.Literal("full-text"), Type.Literal("substring")]),
    parentId: Type.Union([Id, Type.Null()]),
  },
  DRAFT_2020_12,
);

export const NoteSearchOutputSchema = Type.Object(
  {
    items: Type.Array(NoteSearchHitSchema),
    nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  DRAFT_2020_12,
);

export const NoteLinkInputSchema = Type.Object(
  { noteId: Id, targetRef: ResourceRefSchema },
  DRAFT_2020_12,
);

export const NoteLinksInputSchema = Type.Object({ ref: ResourceRefSchema }, DRAFT_2020_12);

export const ResolvedNoteLinkSchema = Type.Object(
  {
    link: ResourceLinkSchema,
    source: Type.Union([ResourceDescriptorSchema, Type.Null()]),
    target: Type.Union([ResourceDescriptorSchema, Type.Null()]),
  },
  DRAFT_2020_12,
);

export const NoteLinksOutputSchema = Type.Object(
  { items: Type.Array(ResolvedNoteLinkSchema) },
  DRAFT_2020_12,
);

export const NoteAttachmentCreateInputSchema = Type.Object(
  {
    noteId: Id,
    mimeType: NoteAttachmentMimeTypeSchema,
    contentBase64: Type.String({ minLength: 4 }),
  },
  DRAFT_2020_12,
);

export const NoteAttachmentGetInputSchema = Type.Object({ id: Id }, DRAFT_2020_12);
export const NoteAttachmentDeleteInputSchema = Type.Object(
  { id: Id, confirm: Type.Literal(true) },
  DRAFT_2020_12,
);
export const NoteAttachmentOutputSchema = Type.Object(
  { attachment: NoteAttachmentDescriptorSchema },
  DRAFT_2020_12,
);
export const NoteAttachmentGetOutputSchema = Type.Object(
  { attachment: NoteAttachmentSchema },
  DRAFT_2020_12,
);
export const NoteExportInputSchema = Type.Object({ id: Id }, DRAFT_2020_12);
export const NoteExportOutputSchema = Type.Object(
  {
    fileName: Type.String({ minLength: 1 }),
    mediaType: Type.Literal("text/markdown"),
    content: Type.String(),
  },
  DRAFT_2020_12,
);

export type NoteCreateInput = Static<typeof NoteCreateInputSchema>;
export type NoteUpdateInput = Static<typeof NoteUpdateInputSchema>;
export type NoteMoveInput = Static<typeof NoteMoveInputSchema>;
export type NoteDeleteInput = Static<typeof NoteDeleteInputSchema>;
export type NoteFavoriteInput = Static<typeof NoteFavoriteInputSchema>;
export type NoteVisitInput = Static<typeof NoteVisitInputSchema>;
export type NoteGetInput = Static<typeof NoteGetInputSchema>;
export type NoteListInput = Static<typeof NoteListInputSchema>;
export type NoteSearchInput = Static<typeof NoteSearchInputSchema>;
export type NoteLinkInput = Static<typeof NoteLinkInputSchema>;
export type NoteLinksInput = Static<typeof NoteLinksInputSchema>;
export type NoteAttachmentCreateInput = Static<typeof NoteAttachmentCreateInputSchema>;
export type NoteAttachmentGetInput = Static<typeof NoteAttachmentGetInputSchema>;
export type NoteAttachmentDeleteInput = Static<typeof NoteAttachmentDeleteInputSchema>;
export type NoteExportInput = Static<typeof NoteExportInputSchema>;
