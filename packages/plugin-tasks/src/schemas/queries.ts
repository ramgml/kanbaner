import { Type, type Static, type TSchema } from "@sinclair/typebox";

import { DRAFT_2020_12, UtcTimestampSchema } from "@kanbaner/plugin-sdk";

import { MAX_SEARCH_TEXT_LENGTH } from "../constants.ts";
import {
  ProjectSchema,
  TaskPrioritySchema,
  TaskSchema,
  TaskSortSchema,
  TaskStatusSchema,
} from "../model.ts";
import { EntityIdSchema, LimitSchema, OffsetSchema, RawTagSchema } from "./common.ts";

/**
 * Вход запроса `project.list`.
 *
 * Порядок фиксирован: `createdAt asc`, затем `id asc`.
 */
export const ProjectListInputSchema = Type.Object(
  {
    limit: Type.Optional(LimitSchema),
    offset: Type.Optional(OffsetSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectListInput = Static<typeof ProjectListInputSchema>;

/** Вход запроса `project.get`. */
export const ProjectGetInputSchema = Type.Object(
  {
    id: EntityIdSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectGetInput = Static<typeof ProjectGetInputSchema>;

/** Вход запроса `task.get`. */
export const TaskGetInputSchema = Type.Object(
  {
    id: EntityIdSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskGetInput = Static<typeof TaskGetInputSchema>;

/**
 * Вход запроса `task.list`.
 *
 * Все фильтры комбинируются по AND. `parentTaskId = null` выбирает корневые
 * задачи, отсутствие поля не ограничивает вложенность.
 *
 * `tag` принимается в сыром виде и нормализуется как теги задачи (trim, нижний
 * регистр, дедупликация, лимиты). `text` ищет подстроку без учёта регистра по
 * NFKC-нормализованным `title`/`descriptionMarkdown`. `dueBefore`/`dueAfter`
 * включают границу.
 *
 * Порядок: выбранное поле сортировки, затем `id asc`; `dueAt = null` всегда
 * последние независимо от направления; `title` сравнивается по code points,
 * без `localeCompare`.
 */
export const TaskListInputSchema = Type.Object(
  {
    projectId: Type.Optional(EntityIdSchema),
    status: Type.Optional(TaskStatusSchema),
    priority: Type.Optional(TaskPrioritySchema),
    tag: Type.Optional(RawTagSchema),
    parentTaskId: Type.Optional(Type.Union([EntityIdSchema, Type.Null()])),
    text: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_SEARCH_TEXT_LENGTH, pattern: "\\S" }),
    ),
    dueBefore: Type.Optional(UtcTimestampSchema),
    dueAfter: Type.Optional(UtcTimestampSchema),
    sort: Type.Optional(TaskSortSchema),
    limit: Type.Optional(LimitSchema),
    offset: Type.Optional(OffsetSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskListInput = Static<typeof TaskListInputSchema>;

/** Схема стабильной страницы списка. */
export function createPageSchema<Item extends TSchema>(item: Item) {
  return Type.Object(
    {
      items: Type.Array(item),
      total: Type.Integer({ minimum: 0 }),
      nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    },
    { ...DRAFT_2020_12, additionalProperties: false },
  );
}

/** Результат `project.list`. */
export const ProjectListOutputSchema = createPageSchema(ProjectSchema);

export type ProjectListOutput = Static<typeof ProjectListOutputSchema>;

/** Результат `project.get`. */
export const ProjectGetOutputSchema = Type.Object(
  {
    project: ProjectSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectGetOutput = Static<typeof ProjectGetOutputSchema>;

/** Результат `task.get`. */
export const TaskGetOutputSchema = Type.Object(
  {
    task: TaskSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskGetOutput = Static<typeof TaskGetOutputSchema>;

/** Результат `task.list`. */
export const TaskListOutputSchema = createPageSchema(TaskSchema);

export type TaskListOutput = Static<typeof TaskListOutputSchema>;

/** Счётчики задач проекта по фиксированным статусам. */
export const TaskStatusCountsSchema = Type.Object(
  {
    backlog: Type.Integer({ minimum: 0 }),
    todo: Type.Integer({ minimum: 0 }),
    in_progress: Type.Integer({ minimum: 0 }),
    done: Type.Integer({ minimum: 0 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskStatusCounts = Static<typeof TaskStatusCountsSchema>;

/**
 * Агрегированная сводка по набору проектов.
 *
 * `total` включает все задачи, `overdueCount` — только незавершённые задачи
 * со сроком раньше момента запроса.
 */
export const ProjectSummaryTotalsSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    counts: TaskStatusCountsSchema,
    overdueCount: Type.Integer({ minimum: 0 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectSummaryTotals = Static<typeof ProjectSummaryTotalsSchema>;

/** Сводка одного проекта: проект и точные счётчики по полным данным. */
export const ProjectSummarySchema = Type.Object(
  {
    project: ProjectSchema,
    total: Type.Integer({ minimum: 0 }),
    counts: TaskStatusCountsSchema,
    overdueCount: Type.Integer({ minimum: 0 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectSummary = Static<typeof ProjectSummarySchema>;

/**
 * Вход запроса `project.summary`.
 *
 * `projectId` ограничивает сводку одним проектом; отсутствие поля возвращает
 * все проекты стабильными страницами. `totals` всегда считается по всем
 * подходящим проектам, а не по текущей странице.
 */
export const ProjectSummaryInputSchema = Type.Object(
  {
    projectId: Type.Optional(EntityIdSchema),
    limit: Type.Optional(LimitSchema),
    offset: Type.Optional(OffsetSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectSummaryInput = Static<typeof ProjectSummaryInputSchema>;

/** Результат `project.summary`. */
export const ProjectSummaryOutputSchema = Type.Object(
  {
    items: Type.Array(ProjectSummarySchema),
    total: Type.Integer({ minimum: 0 }),
    nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    totals: ProjectSummaryTotalsSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectSummaryOutput = Static<typeof ProjectSummaryOutputSchema>;
