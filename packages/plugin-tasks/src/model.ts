import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, UtcTimestampSchema } from "@kanbaner/plugin-sdk";

import {
  DescriptionMarkdownSchema,
  EntityIdSchema,
  NullableUtcTimestampSchema,
  PositionSchema,
  TagsSchema,
  TitleSchema,
} from "./schemas/common.ts";

/** Фиксированные статусы задачи. */
export const TASK_STATUSES = ["backlog", "todo", "in_progress", "done"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskStatusSchema = Type.Union(TASK_STATUSES.map((status) => Type.Literal(status)));

/** Фиксированные приоритеты задачи. */
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TaskPrioritySchema = Type.Union(
  TASK_PRIORITIES.map((priority) => Type.Literal(priority)),
);

/** Допустимые поля сортировки задач. */
export const TASK_SORT_FIELDS = ["position", "createdAt", "updatedAt", "dueAt", "title"] as const;

export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const TaskSortFieldSchema = Type.Union(TASK_SORT_FIELDS.map((field) => Type.Literal(field)));

/** Направление сортировки. */
export const SORT_DIRECTIONS = ["asc", "desc"] as const;

export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const SortDirectionSchema = Type.Union(
  SORT_DIRECTIONS.map((direction) => Type.Literal(direction)),
);

/** Сортировка списка задач. */
export const TaskSortSchema = Type.Object(
  {
    field: TaskSortFieldSchema,
    direction: SortDirectionSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskSort = Static<typeof TaskSortSchema>;

/** Проект — контейнер задач. */
export const ProjectSchema = Type.Object(
  {
    id: EntityIdSchema,
    title: TitleSchema,
    descriptionMarkdown: DescriptionMarkdownSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type Project = Static<typeof ProjectSchema>;

/**
 * Задача.
 *
 * `parentTaskId` ссылается только на корневую задачу того же проекта.
 * `position` уникальна и задаёт порядок в области `(projectId, status)`;
 * `parentTaskId` на эту область не влияет, а непрерывность `0…N-1` не
 * требуется. `completedAt` заполнен тогда и только тогда, когда
 * `status = done`.
 */
export const TaskSchema = Type.Object(
  {
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    parentTaskId: Type.Union([EntityIdSchema, Type.Null()]),
    title: TitleSchema,
    descriptionMarkdown: DescriptionMarkdownSchema,
    status: TaskStatusSchema,
    priority: TaskPrioritySchema,
    dueAt: NullableUtcTimestampSchema,
    position: PositionSchema,
    tags: TagsSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    completedAt: NullableUtcTimestampSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type Task = Static<typeof TaskSchema>;
