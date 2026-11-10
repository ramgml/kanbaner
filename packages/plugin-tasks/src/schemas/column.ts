import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, ResourceRefSchema } from "@kanbaner/plugin-sdk";

import { TaskColumnSchema, TaskColumnTypeSchema, TaskSchema } from "../model.ts";
import {
  ConfirmSchema,
  CreateExpectedVersionSchema,
  EntityIdSchema,
  ExpectedVersionSchema,
  PositionSchema,
  TitleSchema,
} from "./common.ts";

/**
 * Вход команды `column.create`.
 *
 * `position` необязательна: отсутствие означает атомарный append в конец
 * порядка проекта. Новые open-колонки сохраняются со статусом `in_progress`,
 * колонки типа `done` — со статусом `done`.
 */
export const ColumnCreateInputSchema = Type.Object(
  {
    projectId: EntityIdSchema,
    title: TitleSchema,
    type: TaskColumnTypeSchema,
    position: Type.Optional(PositionSchema),
    expectedVersion: Type.Optional(CreateExpectedVersionSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ColumnCreateInput = Static<typeof ColumnCreateInputSchema>;

/** Вход команды `column.update`: переименование с проверкой версии. */
export const ColumnUpdateInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    title: TitleSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ColumnUpdateInput = Static<typeof ColumnUpdateInputSchema>;

/** Вход команды `column.move`: транзакционный reorder по position. */
export const ColumnMoveInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    position: PositionSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ColumnMoveInput = Static<typeof ColumnMoveInputSchema>;

/**
 * Вход команды `column.delete`.
 *
 * Удаление разрушительное: требует `confirm: true`, `expectedVersion` и
 * `targetColumnId`, в который атомарно переносятся все задачи колонки. Целевая
 * колонка обязана принадлежать тому же проекту и отличаться от удаляемой.
 */
export const ColumnDeleteInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    confirm: ConfirmSchema,
    targetColumnId: EntityIdSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ColumnDeleteInput = Static<typeof ColumnDeleteInputSchema>;

/** Результат `column.create`, `column.update` и `column.move`. */
export const ColumnMutationOutputSchema = Type.Object(
  {
    column: TaskColumnSchema,
    resource: ResourceRefSchema,
    eventId: Type.String({ minLength: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ColumnMutationOutput = Static<typeof ColumnMutationOutputSchema>;

/** Успешный ответ `column.delete` после переноса задач. */
export const ColumnDeleteSuccessOutputSchema = Type.Object(
  {
    deleted: Type.Literal(true),
    resource: ResourceRefSchema,
    version: Type.Integer({ minimum: 1 }),
    eventVersion: Type.Integer({ minimum: 2 }),
    targetColumnId: EntityIdSchema,
    movedTasks: Type.Array(TaskSchema),
    eventId: Type.String({ minLength: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

/** Идемпотентный no-op `column.delete`: колонка уже отсутствует. */
export const ColumnDeleteNoopOutputSchema = Type.Object(
  {
    deleted: Type.Literal(false),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

/** Дискриминированный результат `column.delete`. */
export const ColumnDeleteOutputSchema = Type.Union(
  [ColumnDeleteSuccessOutputSchema, ColumnDeleteNoopOutputSchema],
  DRAFT_2020_12,
);

export type ColumnDeleteOutput = Static<typeof ColumnDeleteOutputSchema>;
