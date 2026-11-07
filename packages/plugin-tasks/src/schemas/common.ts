import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, ResourceRefSchema, UtcTimestampSchema } from "@kanbaner/plugin-sdk";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_LIST_LIMIT,
  MAX_POSITION,
  MAX_RAW_TAG_LENGTH,
  MAX_RAW_TAGS,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
} from "../constants.ts";

/** Opaque ID ресурса. Двоеточие и пробелы запрещены форматом ResourceRef. */
export const EntityIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[^:\\s]+$",
});

/** Заголовок с обязательным непробельным символом. */
export const TitleSchema = Type.String({
  minLength: 1,
  maxLength: MAX_TITLE_LENGTH,
  pattern: "\\S",
});

/** Markdown-описание; пустая строка допустима. */
export const DescriptionMarkdownSchema = Type.String({
  maxLength: MAX_DESCRIPTION_LENGTH,
});

/**
 * Один сырой тег команды до нормализации.
 *
 * Пробелы по краям и длина до `MAX_RAW_TAG_LENGTH` допустимы: trim, нижний
 * регистр, дедупликация и лимит `MAX_TAG_LENGTH` применяются доменным
 * валидатором после JSON Schema.
 */
export const RawTagSchema = Type.String({
  minLength: 1,
  maxLength: MAX_RAW_TAG_LENGTH,
  pattern: "\\S",
});

/** Сырые теги команды; дубликаты и более `MAX_TAGS` элементов допустимы. */
export const RawTagsSchema = Type.Array(RawTagSchema, { maxItems: MAX_RAW_TAGS });

/**
 * Один нормализованный тег в сохранённой задаче.
 *
 * Trim, нижний регистр и дедупликация уже выполнены доменом.
 */
export const TagSchema = Type.String({
  minLength: 1,
  maxLength: MAX_TAG_LENGTH,
  pattern: "\\S",
});

/** Нормализованные теги задачи: не более `MAX_TAGS` штук. */
export const TagsSchema = Type.Array(TagSchema, { maxItems: MAX_TAGS });

/** UTC timestamp или null. */
export const NullableUtcTimestampSchema = Type.Union([UtcTimestampSchema, Type.Null()]);

/**
 * Неотрицательная позиция задачи.
 *
 * Позиция уникальна и задаёт порядок в области `(projectId, status)`.
 * `parentTaskId` на область уникальности не влияет. Непрерывность `0…N-1` не
 * требуется: допустимы разреженные целые позиции, если уникальность и порядок
 * сохранены.
 */
export const PositionSchema = Type.Integer({ minimum: 0, maximum: MAX_POSITION });

/** Версия существующей сущности для update/move/complete/delete. */
export const ExpectedVersionSchema = Type.Integer({ minimum: 1 });

/** Версия создания: новая сущность всегда ожидает 0. */
export const CreateExpectedVersionSchema = Type.Literal(0);

/** Лимит страницы. */
export const LimitSchema = Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT });

/** Смещение страницы. */
export const OffsetSchema = Type.Integer({ minimum: 0 });

/** Явное подтверждение разрушительной операции. */
export const ConfirmSchema = Type.Literal(true);

/** Дескриптор задачи, удалённой каскадом. */
export const DeletedTaskDescriptorSchema = Type.Object(
  {
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    resourceRef: ResourceRefSchema,
    version: Type.Integer({ minimum: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

/** Успешный ответ удаления: событие публикуется только при `deleted = true`. */
export const DeleteSuccessOutputSchema = Type.Object(
  {
    deleted: Type.Literal(true),
    resource: ResourceRefSchema,
    version: Type.Integer({ minimum: 1 }),
    deletedResourceRefs: Type.Array(ResourceRefSchema),
    deletedTasks: Type.Array(DeletedTaskDescriptorSchema),
    eventId: Type.String({ minLength: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

/** Идемпотентный no-op удаления: сущность уже отсутствует, события нет. */
export const DeleteNoopOutputSchema = Type.Object(
  {
    deleted: Type.Literal(false),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

/**
 * Дискриминированный ответ удаления проекта или задачи.
 *
 * Ветка `deleted = true` содержит `eventId` и дескрипторы последних версий.
 * Ветка `deleted = false` не содержит `eventId`, потому что событие не
 * публиковалось.
 */
export const DeleteOutputSchema = Type.Union(
  [DeleteSuccessOutputSchema, DeleteNoopOutputSchema],
  DRAFT_2020_12,
);

export type DeleteOutput = Static<typeof DeleteOutputSchema>;
