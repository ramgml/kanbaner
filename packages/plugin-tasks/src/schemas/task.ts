import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, ResourceRefSchema } from "@kanbaner/plugin-sdk";

import { TaskPrioritySchema, TaskSchema, TaskStatusSchema } from "../model.ts";
import {
  ConfirmSchema,
  CreateExpectedVersionSchema,
  DescriptionMarkdownSchema,
  EntityIdSchema,
  ExpectedVersionSchema,
  NullableUtcTimestampSchema,
  PositionSchema,
  TagsSchema,
  TitleSchema,
} from "./common.ts";

/**
 * Вход команды `task.create`.
 *
 * `position` задаёт порядок в области `(projectId, status)` и не зависит от
 * `parentTaskId`. Непрерывность позиций не требуется.
 */
export const TaskCreateInputSchema = Type.Object(
  {
    projectId: EntityIdSchema,
    parentTaskId: Type.Optional(Type.Union([EntityIdSchema, Type.Null()])),
    title: TitleSchema,
    descriptionMarkdown: Type.Optional(DescriptionMarkdownSchema),
    status: Type.Optional(TaskStatusSchema),
    priority: Type.Optional(TaskPrioritySchema),
    dueAt: Type.Optional(NullableUtcTimestampSchema),
    position: Type.Optional(PositionSchema),
    tags: Type.Optional(TagsSchema),
    expectedVersion: Type.Optional(CreateExpectedVersionSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskCreateInput = Static<typeof TaskCreateInputSchema>;

/** Вход команды `task.update`: текстовые поля, приоритет, срок и теги. */
export const TaskUpdateInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    title: Type.Optional(TitleSchema),
    descriptionMarkdown: Type.Optional(DescriptionMarkdownSchema),
    priority: Type.Optional(TaskPrioritySchema),
    dueAt: Type.Optional(NullableUtcTimestampSchema),
    tags: Type.Optional(TagsSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskUpdateInput = Static<typeof TaskUpdateInputSchema>;

/**
 * Вход команды `task.move`: смена статуса и позиции.
 *
 * Новая позиция проверяется в области `(projectId, status)` целевого статуса;
 * `parentTaskId` на область не влияет.
 */
export const TaskMoveInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    status: TaskStatusSchema,
    position: PositionSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskMoveInput = Static<typeof TaskMoveInputSchema>;

/** Вход команды `task.complete`: перевод задачи в `done`. */
export const TaskCompleteInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskCompleteInput = Static<typeof TaskCompleteInputSchema>;

/** Вход команды `task.delete`. */
export const TaskDeleteInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    confirm: ConfirmSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskDeleteInput = Static<typeof TaskDeleteInputSchema>;

/** Результат `task.create`, `task.update`, `task.move` и `task.complete`. */
export const TaskMutationOutputSchema = Type.Object(
  {
    task: TaskSchema,
    resource: ResourceRefSchema,
    eventId: Type.String({ minLength: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskMutationOutput = Static<typeof TaskMutationOutputSchema>;

/** Результат `task.delete` с каскадно удалёнными подзадачами. */
export const TaskDeleteOutputSchema = Type.Object(
  {
    deleted: Type.Boolean(),
    deletedTaskIds: Type.Array(EntityIdSchema),
    resource: ResourceRefSchema,
    eventId: Type.String({ minLength: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskDeleteOutput = Static<typeof TaskDeleteOutputSchema>;
