import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12, ResourceRefSchema } from "@kanbaner/plugin-sdk";

import { ProjectSchema } from "../model.ts";
import {
  ConfirmSchema,
  CreateExpectedVersionSchema,
  DescriptionMarkdownSchema,
  EntityIdSchema,
  ExpectedVersionSchema,
  TitleSchema,
} from "./common.ts";

/** Вход команды `project.create`. */
export const ProjectCreateInputSchema = Type.Object(
  {
    title: TitleSchema,
    descriptionMarkdown: Type.Optional(DescriptionMarkdownSchema),
    expectedVersion: Type.Optional(CreateExpectedVersionSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectCreateInput = Static<typeof ProjectCreateInputSchema>;

/** Вход команды `project.update`. */
export const ProjectUpdateInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    title: Type.Optional(TitleSchema),
    descriptionMarkdown: Type.Optional(DescriptionMarkdownSchema),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectUpdateInput = Static<typeof ProjectUpdateInputSchema>;

/** Вход команды `project.delete`. */
export const ProjectDeleteInputSchema = Type.Object(
  {
    id: EntityIdSchema,
    expectedVersion: ExpectedVersionSchema,
    confirm: ConfirmSchema,
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectDeleteInput = Static<typeof ProjectDeleteInputSchema>;

/** Результат `project.create` и `project.update`. */
export const ProjectMutationOutputSchema = Type.Object(
  {
    project: ProjectSchema,
    resource: ResourceRefSchema,
    eventId: Type.String({ minLength: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectMutationOutput = Static<typeof ProjectMutationOutputSchema>;

/** Результат `project.delete` с каскадно удалёнными задачами. */
export const ProjectDeleteOutputSchema = Type.Object(
  {
    deleted: Type.Boolean(),
    deletedTaskIds: Type.Array(EntityIdSchema),
    resource: ResourceRefSchema,
    eventId: Type.String({ minLength: 1 }),
  },
  { ...DRAFT_2020_12, additionalProperties: false },
);

export type ProjectDeleteOutput = Static<typeof ProjectDeleteOutputSchema>;
