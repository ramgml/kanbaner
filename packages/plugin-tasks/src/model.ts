import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, UtcTimestampSchema, type ResourceRef } from "@kanbaner/plugin-sdk";

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

/** Статусы, при которых задача не завершена. */
export const OPEN_TASK_STATUSES = ["backlog", "todo", "in_progress"] as const;

const OpenTaskStatusSchema = Type.Union(OPEN_TASK_STATUSES.map((status) => Type.Literal(status)));

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

const TASK_OBJECT_OPTIONS = { additionalProperties: false } as const;

const TaskBaseProperties = {
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  parentTaskId: Type.Union([EntityIdSchema, Type.Null()]),
  title: TitleSchema,
  descriptionMarkdown: DescriptionMarkdownSchema,
  priority: TaskPrioritySchema,
  dueAt: NullableUtcTimestampSchema,
  position: PositionSchema,
  tags: TagsSchema,
  version: Type.Integer({ minimum: 1 }),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
} as const;

const DoneTaskSchema = Type.Object(
  {
    ...TaskBaseProperties,
    status: Type.Literal("done"),
    completedAt: UtcTimestampSchema,
  },
  TASK_OBJECT_OPTIONS,
);

const OpenTaskSchema = Type.Object(
  {
    ...TaskBaseProperties,
    status: OpenTaskStatusSchema,
    completedAt: Type.Null(),
  },
  TASK_OBJECT_OPTIONS,
);

/**
 * Задача.
 *
 * `parentTaskId` ссылается только на корневую задачу того же проекта.
 * `position` уникальна и задаёт порядок в области `(projectId, status)`;
 * `parentTaskId` на эту область не влияет, а непрерывность `0…N-1` не
 * требуется.
 *
 * Схема выражает доменный инвариант `done ⇔ completedAt !== null`: задача в
 * `done` обязана иметь timestamp, остальные статусы — `null`.
 */
export const TaskSchema = Type.Union([DoneTaskSchema, OpenTaskSchema], DRAFT_2020_12);

export type Task = Static<typeof TaskSchema>;

/**
 * Дескриптор удалённой задачи.
 *
 * `version` — последняя сохранённая версия до удаления. Store не создаёт
 * tombstone-версию; события delete и очистка поиска используют это значение.
 */
export interface DeletedTaskDescriptor {
  readonly id: string;
  readonly projectId: string;
  readonly resourceRef: ResourceRef;
  readonly version: number;
}
