import { Type } from "@sinclair/typebox";

import { UtcTimestampSchema } from "@kanbaner/plugin-sdk";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_LIST_LIMIT,
  MAX_POSITION,
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

/** Один тег до нормализации. */
export const TagSchema = Type.String({
  minLength: 1,
  maxLength: MAX_TAG_LENGTH,
  pattern: "\\S",
});

/** Теги задачи. Дедупликация выполняется доменным валидатором. */
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
