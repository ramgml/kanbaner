import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, ResourceRefSchema } from "@kanbaner/plugin-sdk";

import { TaskPrioritySchema, TaskSchema, TaskStatusSchema } from "../model.ts";
import {
  ConfirmSchema,
  CreateExpectedVersionSchema,
  DeleteOutputSchema,
  DescriptionMarkdownSchema,
  EntityIdSchema,
  ExpectedVersionSchema,
  NullableUtcTimestampSchema,
  PositionSchema,
  RawTagsSchema,
  TitleSchema,
  type DeleteOutput,
} from "./common.ts";

/**
 * Вход команды `task.create`.
 *
 * `columnId` и `status` необязательны. Если задана колонка, её статус
 * используется как совместимое зеркало; если задан только `status`, выбирается
 * первая колонка проекта с этим статусом. Оба поля обязаны быть согласованы.
 * Отсутствие обоих сохраняет прежнее поведение: `status = todo`.
 *
 * `position` задаёт порядок в области `(projectId, columnId)` и не зависит от
 * `parentTaskId`; отсутствие поля означает атомарный append. Непрерывность
 * позиций не требуется.
 *
 * `tags` принимаются в сыром виде: дубликаты и trim допустимы, а лимиты
 * `MAX_TAGS`/`MAX_TAG_LENGTH` применяются после доменной нормализации.
 */
export const TaskCreateInputSchema = Type.Object(
  {
    projectId: EntityIdSchema,
    parentTaskId: Type.Optional(Type.Union([EntityIdSchema, Type.Null()])),
    columnId: Type.Optional(EntityIdSchema),
    title: TitleSchema,
    descriptionMarkdown: Type.Optional(DescriptionMarkdownSchema),
    status: Type.Optional(TaskStatusSchema),
    priority: Type.Optional(TaskPrioritySchema),
    dueAt: Type.Optional(NullableUtcTimestampSchema),
    position: Type.Optional(PositionSchema),
    tags: Type.Optional(RawTagsSchema),
    expectedVersion: Type.Optional(CreateExpectedVersionSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskCreateInput = Static<typeof TaskCreateInputSchema>;

/**
 * Вход команды `task.update`: текстовые поля, приоритет, срок и теги.
 *
 * `tags` принимаются сырыми: trim и дедупликация выполняются доменным
 * валидатором, а не JSON Schema.
 */
export const TaskUpdateInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    title: Type.Optional(TitleSchema),
    descriptionMarkdown: Type.Optional(DescriptionMarkdownSchema),
    priority: Type.Optional(TaskPrioritySchema),
    dueAt: Type.Optional(NullableUtcTimestampSchema),
    tags: Type.Optional(RawTagsSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type TaskUpdateInput = Static<typeof TaskUpdateInputSchema>;

/**
 * Вход команды `task.move`: смена колонки/статуса и позиции.
 *
 * Обязательно хотя бы одно из `columnId` и `status`. Если задана колонка, она
 * определяет статус и область позиции; `status` без `columnId` выбирает первую
 * колонку проекта с этим статусом (legacy-совместимость). Если заданы оба
 * поля, они обязаны совпадать. Новая позиция проверяется в области
 * `(projectId, columnId)`; `parentTaskId` на область не влияет.
 */
export const TaskMoveInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    columnId: Type.Optional(EntityIdSchema),
    status: Type.Optional(TaskStatusSchema),
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

/**
 * Результат `task.delete`.
 *
 * `deleted = true` содержит `eventId` и дескрипторы последних версий удалённых
 * задач; `deleted = false` — идемпотентный no-op без события.
 */
export const TaskDeleteOutputSchema = DeleteOutputSchema;

export type TaskDeleteOutput = DeleteOutput;
