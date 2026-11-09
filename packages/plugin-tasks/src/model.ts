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

/**
 * Тип пользовательской колонки.
 *
 * `done` соответствует legacy-статусу `done`; любая открытая колонка хранит
 * один из открытых legacy-статусов. Новые пользовательские open-колонки
 * используют `in_progress`.
 */
export const TASK_COLUMN_TYPES = ["open", "done"] as const;

export type TaskColumnType = (typeof TASK_COLUMN_TYPES)[number];

export const TaskColumnTypeSchema = Type.Union(
  TASK_COLUMN_TYPES.map((columnType) => Type.Literal(columnType)),
);

/** Статус, с которым сохраняется пользовательская колонка указанного типа. */
export function columnStatusForType(columnType: TaskColumnType): TaskStatus {
  return columnType === "done" ? "done" : "in_progress";
}

/** Тип колонки по её legacy-статусу. */
export function columnTypeForStatus(status: TaskStatus): TaskColumnType {
  return status === "done" ? "done" : "open";
}

/**
 * Пользовательская колонка проекта.
 *
 * `position` уникальна и задаёт порядок в области `projectId`. `status` —
 * совместимое зеркало legacy-статуса: `done` соответствует типу Done,
 * остальные значения — open. Несколько колонок могут иметь одинаковый
 * open-статус (например, несколько `in_progress`).
 */
export const TaskColumnSchema = Type.Object(
  {
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    title: TitleSchema,
    status: TaskStatusSchema,
    position: PositionSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskColumn = Static<typeof TaskColumnSchema>;

const TASK_OBJECT_OPTIONS = { additionalProperties: false } as const;

const TaskBaseProperties = {
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  parentTaskId: Type.Union([EntityIdSchema, Type.Null()]),
  columnId: Type.Optional(EntityIdSchema),
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
 * `columnId` задаёт пользовательскую колонку и область уникальности позиции
 * `(projectId, columnId)`. Для старых документов без `columnId` действует
 * legacy fallback: Store определяет колонку по `status`. `parentTaskId` на
 * область не влияет, а непрерывность `0…N-1` не требуется.
 *
 * `status` остаётся совместимым зеркалом статуса колонки. Схема выражает
 * доменный инвариант `done ⇔ completedAt !== null`: задача в `done` обязана
 * иметь timestamp, остальные статусы — `null`.
 */
export const TaskSchema = Type.Union([DoneTaskSchema, OpenTaskSchema], DRAFT_2020_12);

export type Task = Static<typeof TaskSchema>;

/**
 * Вычисляет `resourceVersion` delete-события.
 *
 * В БД сохраняется только последняя версия сущности, tombstone не создаётся.
 * Event envelope использует следующую версию: update(v3) → delete event(v4).
 * Для каждой задачи каскада версия вычисляется от её собственной последней
 * сохранённой версии.
 */
export function deleteEventVersion(lastSavedVersion: number): number {
  if (!Number.isInteger(lastSavedVersion) || lastSavedVersion < 1) {
    throw new TypeError("Последняя сохранённая версия должна быть целым числом ≥ 1");
  }

  return lastSavedVersion + 1;
}

/**
 * Дескриптор удалённой задачи.
 *
 * `version` — последняя сохранённая версия до удаления. `eventVersion` —
 * значение для `resourceVersion` delete-события этой задачи
 * (`deleteEventVersion(version)`). Store не создаёт tombstone-версию.
 */
export interface DeletedTaskDescriptor {
  readonly id: string;
  readonly projectId: string;
  readonly resourceRef: ResourceRef;
  readonly version: number;
  readonly eventVersion: number;
}

/**
 * Дескриптор удалённой колонки.
 *
 * `version` — последняя сохранённая версия, `eventVersion` — значение
 * `resourceVersion` delete-события (`version + 1`). Tombstone не создаётся.
 */
export interface DeletedColumnDescriptor {
  readonly id: string;
  readonly projectId: string;
  readonly resourceRef: ResourceRef;
  readonly version: number;
  readonly eventVersion: number;
}
