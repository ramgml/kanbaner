export const SEARCH_PLUGIN_ID = "kanbaner.search" as const;
export const SEARCH_CONTRACT_VERSION = 1 as const;
export const SEARCH_QUERIES_CONTRACT = "kanbaner.search.queries.v1" as const;
export const SEARCH_UI_CONTRACT = "kanbaner.search.ui.v1" as const;
export const SEARCH_ROUTE = "/view/search" as const;

export const SEARCH_QUERY_IDS = Object.freeze({
  query: "kanbaner.search.query",
  filters: "kanbaner.search.filters",
} as const);

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_MAX_FILTERS = 10;
export const SEARCH_MAX_TEXT_LENGTH = 500;
