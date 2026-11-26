import { Type, type Static } from "@sinclair/typebox";
import { createJsonObjectSchema, DRAFT_2020_12 } from "@kanbaner/plugin-sdk";

import {
  SEARCH_MAX_FILTERS,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_OFFSET,
  SEARCH_MAX_TEXT_LENGTH,
} from "./constants.ts";

const INPUT_SCHEMA = { ...DRAFT_2020_12, additionalProperties: false } as const;

export const SearchFilterSchema = Type.Object(
  {
    field: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z][A-Za-z0-9_]*$",
    }),
    operator: Type.Union([Type.Literal("eq"), Type.Literal("contains")]),
    value: Type.String({ minLength: 1, maxLength: 200 }),
  },
  INPUT_SCHEMA,
);

export const SearchQueryInputSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: SEARCH_MAX_TEXT_LENGTH }),
    kinds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20 }),
    ),
    filters: Type.Optional(Type.Array(SearchFilterSchema, { maxItems: SEARCH_MAX_FILTERS })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_LIMIT })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: SEARCH_MAX_OFFSET })),
  },
  INPUT_SCHEMA,
);

export const SearchHitSchema = Type.Object(
  {
    ref: Type.String({ minLength: 1 }),
    title: Type.String(),
    excerpt: Type.String(),
    score: Type.Number(),
    strategy: Type.Union([Type.Literal("full-text"), Type.Literal("substring")]),
    kind: Type.Optional(Type.String({ minLength: 1 })),
    metadata: Type.Optional(createJsonObjectSchema()),
  },
  DRAFT_2020_12,
);

export const SearchWarningSchema = Type.Object(
  {
    providerId: Type.String({ minLength: 1 }),
    code: Type.Union([Type.Literal("provider_failed"), Type.Literal("foreign_ref")]),
  },
  DRAFT_2020_12,
);

export const SearchQueryOutputSchema = Type.Object(
  {
    hits: Type.Array(SearchHitSchema),
    hasMore: Type.Boolean(),
    warnings: Type.Array(SearchWarningSchema),
  },
  DRAFT_2020_12,
);

export const SearchKindSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
  },
  DRAFT_2020_12,
);

export const SearchFacetValueSchema = Type.Object(
  {
    value: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
  },
  DRAFT_2020_12,
);

export const SearchFacetSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    operators: Type.Array(Type.Union([Type.Literal("eq"), Type.Literal("contains")])),
    values: Type.Array(SearchFacetValueSchema),
  },
  DRAFT_2020_12,
);

export const SearchFiltersOutputSchema = Type.Object(
  {
    kinds: Type.Array(SearchKindSchema),
    facets: Type.Array(SearchFacetSchema),
    warnings: Type.Array(SearchWarningSchema),
  },
  DRAFT_2020_12,
);

/** Пустой вход `filters`: запрос не принимает параметров. */
export const SearchFiltersInputSchema = Type.Object({}, INPUT_SCHEMA);

export type SearchFilterInput = Static<typeof SearchFilterSchema>;
export type SearchQueryInput = Static<typeof SearchQueryInputSchema>;
export type SearchHitResult = Static<typeof SearchHitSchema>;
export type SearchWarning = Static<typeof SearchWarningSchema>;
export type SearchQueryOutput = Static<typeof SearchQueryOutputSchema>;
export type SearchKind = Static<typeof SearchKindSchema>;
export type SearchFacetValue = Static<typeof SearchFacetValueSchema>;
export type SearchFacet = Static<typeof SearchFacetSchema>;
export type SearchFiltersOutput = Static<typeof SearchFiltersOutputSchema>;
