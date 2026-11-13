import { Type, type Static, type TProperties } from "@sinclair/typebox";
import {
  createJsonObjectSchema,
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

const INPUT_SCHEMA = { ...DRAFT_2020_12, additionalProperties: false } as const;

function InputObject<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, INPUT_SCHEMA);
}

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

export const NoteCreateInputSchema = InputObject({
  parentId: Type.Optional(Type.Union([Id, Type.Null()])),
  title: Type.Optional(Type.String({ maxLength: NOTE_TITLE_MAX_LENGTH })),
  contentMarkdown: Type.Optional(Type.String({ maxLength: NOTE_CONTENT_MAX_LENGTH })),
});

export const NoteUpdateInputSchema = InputObject({
  id: Id,
  expectedVersion: ExpectedVersion,
  title: Type.Optional(Type.String({ maxLength: NOTE_TITLE_MAX_LENGTH })),
  contentMarkdown: Type.Optional(Type.String({ maxLength: NOTE_CONTENT_MAX_LENGTH })),
});

export const NoteMoveInputSchema = InputObject({
  id: Id,
  expectedVersion: ExpectedVersion,
  parentId: Type.Union([Id, Type.Null()]),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const NoteDeleteInputSchema = InputObject({
  id: Id,
  expectedVersion: ExpectedVersion,
  /**
   * Размер поддерева из свежего preview (`note.subtree`).
   *
   * Необязателен для обратной совместимости: старый клиент удаляет ветку без
   * проверки размера. Новый клиент передаёт count и получает конфликт, если
   * дерево изменилось между preview и delete.
   */
  expectedDescendants: Type.Optional(Type.Integer({ minimum: 1 })),
  confirm: Type.Literal(true),
});

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
  { note: NoteSchema, affectedNotes: Type.Array(NoteSchema) },
  DRAFT_2020_12,
);

export const NoteFavoriteInputSchema = InputObject({
  id: Id,
  favorite: Type.Boolean(),
});

export const NoteVisitInputSchema = InputObject({ id: Id });
export const NoteGetInputSchema = InputObject({ id: Id });
export const NoteSubtreeInputSchema = InputObject({ id: Id });

export const NoteSubtreeOutputSchema = Type.Object(
  {
    noteId: Id,
    noteCount: Type.Integer({ minimum: 1 }),
    attachmentCount: Type.Integer({ minimum: 0 }),
  },
  DRAFT_2020_12,
);

export const NoteListInputSchema = InputObject({
  parentId: Type.Optional(Type.Union([Id, Type.Null()])),
  favorite: Type.Optional(Type.Boolean()),
  recent: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Limit),
  offset: Type.Optional(Offset),
});

export const NoteListOutputSchema = Type.Object(
  {
    items: Type.Array(NoteViewSchema),
    total: Type.Integer({ minimum: 0 }),
    nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  DRAFT_2020_12,
);

export const NoteSearchInputSchema = InputObject({
  text: Type.String({ minLength: 1, maxLength: 500 }),
  limit: Type.Optional(Limit),
  offset: Type.Optional(Offset),
});

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

export const NoteLinkInputSchema = InputObject({
  noteId: Id,
  targetRef: ResourceRefSchema,
});

/**
 * Удаление конкретной пары связи.
 *
 * `noteId` должен быть одним из участников (`sourceRef` или `targetRef`):
 * это позволяет снять входящую или исходящую связь с обеих сторон, но не
 * разрешает удалить чужую пару.
 */
export const NoteUnlinkInputSchema = InputObject({
  noteId: Id,
  sourceRef: ResourceRefSchema,
  targetRef: ResourceRefSchema,
});

export const NoteLinksInputSchema = InputObject({ ref: ResourceRefSchema });

/**
 * Descriptor с уникальным `$id` вложенной схемы `metadata`.
 *
 * Публичная схема `ResourceDescriptorSchema` содержит общий `JsonObjectSchema`
 * с фиксированным `$id`. Когда descriptor входит в одну схему дважды
 * (`source`/`target`), AJV отклоняет её с ошибкой «resolves to more than one
 * schema». Фабрика сохраняет форму descriptor из SDK, но даёт каждой копии
 * собственную схему метаданных.
 */
function createResolvedDescriptorSchema() {
  return Type.Object(
    {
      ...ResourceDescriptorSchema.properties,
      metadata: Type.Optional(createJsonObjectSchema()),
    },
    DRAFT_2020_12,
  );
}

export const ResolvedNoteLinkSchema = Type.Object(
  {
    link: ResourceLinkSchema,
    source: Type.Union([createResolvedDescriptorSchema(), Type.Null()]),
    target: Type.Union([createResolvedDescriptorSchema(), Type.Null()]),
  },
  DRAFT_2020_12,
);

export const NoteLinksOutputSchema = Type.Object(
  { items: Type.Array(ResolvedNoteLinkSchema) },
  DRAFT_2020_12,
);

export const NoteAttachmentCreateInputSchema = InputObject({
  noteId: Id,
  mimeType: NoteAttachmentMimeTypeSchema,
  contentBase64: Type.String({ minLength: 4 }),
});

export const NoteAttachmentGetInputSchema = InputObject({ id: Id });
export const NoteAttachmentDeleteInputSchema = InputObject({
  id: Id,
  confirm: Type.Literal(true),
});
export const NoteAttachmentOutputSchema = Type.Object(
  { attachment: NoteAttachmentDescriptorSchema },
  DRAFT_2020_12,
);
export const NoteAttachmentGetOutputSchema = Type.Object(
  { attachment: NoteAttachmentSchema },
  DRAFT_2020_12,
);
export const NoteExportInputSchema = InputObject({ id: Id });
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
export type NoteSubtreeInput = Static<typeof NoteSubtreeInputSchema>;
export type NoteListInput = Static<typeof NoteListInputSchema>;
export type NoteSearchInput = Static<typeof NoteSearchInputSchema>;
export type NoteLinkInput = Static<typeof NoteLinkInputSchema>;
export type NoteUnlinkInput = Static<typeof NoteUnlinkInputSchema>;
export type NoteLinksInput = Static<typeof NoteLinksInputSchema>;
export type NoteAttachmentCreateInput = Static<typeof NoteAttachmentCreateInputSchema>;
export type NoteAttachmentGetInput = Static<typeof NoteAttachmentGetInputSchema>;
export type NoteAttachmentDeleteInput = Static<typeof NoteAttachmentDeleteInputSchema>;
export type NoteExportInput = Static<typeof NoteExportInputSchema>;
