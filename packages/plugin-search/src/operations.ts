import { type JsonObject, type QueryMetadata } from "@kanbaner/plugin-sdk";

import { SEARCH_CONTRACT_VERSION, SEARCH_QUERIES_CONTRACT, SEARCH_QUERY_IDS } from "./constants.ts";
import {
  SearchFiltersInputSchema,
  SearchFiltersOutputSchema,
  SearchQueryInputSchema,
  SearchQueryOutputSchema,
} from "./schemas.ts";

const asSchema = (schema: unknown): JsonObject => schema as JsonObject;

function query(
  id: string,
  inputSchema: unknown,
  outputSchema: unknown,
  description: string,
  mcp: boolean,
): QueryMetadata {
  return {
    id,
    contract: SEARCH_QUERIES_CONTRACT,
    version: SEARCH_CONTRACT_VERSION,
    kind: "query",
    risk: "read",
    exposure: { ui: true, http: true, mcp },
    inputSchema: asSchema(inputSchema),
    outputSchema: asSchema(outputSchema),
    description,
  };
}

/**
 * Read-only операции глобального поиска.
 *
 * Обе операции требуют только публичный `PluginSearchService` и не раскрывают
 * содержимое чужого namespace. `kanbaner.search.query` объявлена для MCP,
 * чтобы KAN-069 мог использовать её через `exposure.mcp`; ручной OpenCode
 * allowlist при этом не расширяется.
 */
export const SEARCH_QUERY_LIST: readonly QueryMetadata[] = Object.freeze([
  query(
    SEARCH_QUERY_IDS.query,
    SearchQueryInputSchema,
    SearchQueryOutputSchema,
    "Ищет по активным провайдерам с типами, фильтрами и bounded pagination",
    true,
  ),
  query(
    SEARCH_QUERY_IDS.filters,
    SearchFiltersInputSchema,
    SearchFiltersOutputSchema,
    "Возвращает доступные типы и facet-ы активных провайдеров",
    false,
  ),
]);
