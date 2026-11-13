import { Type, type Static } from "@sinclair/typebox";

import { DRAFT_2020_12 } from "./contract.ts";
import { OperationIdSchema, PluginIdSchema } from "./plugin-id.ts";

/**
 * Базовые слоты ядра Plugin Contract v1.
 *
 * Плагин может публиковать собственные слоты; они используют тот же формат
 * идентификатора и не требуют импорта React или DOM.
 */
export const CORE_UI_SLOTS = [
  "app.sidebar",
  "app.main",
  "app.details",
  "app.settings",
  "app.overlays",
] as const;

export type CoreUiSlot = (typeof CORE_UI_SLOTS)[number];

/** Идентификатор слота, включая слоты, опубликованные плагинами. */
export type UiSlotId = string;

export const UI_SLOT_PATTERN = "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$";

export const UI_CONTRIBUTION_KINDS = [
  "view",
  "route",
  "navigation",
  "command",
  "panel",
  "settings",
  "resource-opener",
  "dialog",
  "notification",
] as const;

export type UiContributionKind = (typeof UI_CONTRIBUTION_KINDS)[number];

export const UiSlotSchema = Type.String({
  ...DRAFT_2020_12,
  minLength: 3,
  pattern: UI_SLOT_PATTERN,
});

export const UiContributionKindSchema = Type.Union(
  UI_CONTRIBUTION_KINDS.map((kind) => Type.Literal(kind)),
);

/**
 * Метаданные UI-вклада.
 *
 * Это только декларация для реестра ядра. SDK не содержит React-компонентов,
 * Tailwind-классов и обращений к DOM; рендерер подключается отдельно.
 */
export const UiContributionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    slot: UiSlotSchema,
    kind: UiContributionKindSchema,
    priority: Type.Integer(),
    title: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String()),
    route: Type.Optional(Type.String({ minLength: 1 })),
    commandId: Type.Optional(OperationIdSchema),
    resourceType: Type.Optional(Type.String({ minLength: 1 })),
    /**
     * Плагин-владелец открываемого ресурса.
     *
     * Для `resource-opener` по умолчанию совпадает с владельцем вклада.
     * Поле нужно, когда UI-плагин открывает ресурс другого домена: например,
     * рабочий стол проектов открывает `kanbaner.tasks:task:<id>`.
     */
    resourcePluginId: Type.Optional(PluginIdSchema),
  },
  DRAFT_2020_12,
);

export type UiContribution = Static<typeof UiContributionSchema>;
