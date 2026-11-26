// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type {
  ActivationQueryRegistration,
  PluginSearchService,
  SearchAggregateResult,
  SearchFacetSet,
  UiContribution,
} from "@kanbaner/plugin-sdk";

import { activate, type SearchActivationContext } from "./activation.ts";
import { SEARCH_PLUGIN_ID, SEARCH_QUERY_IDS } from "./constants.ts";
import { SEARCH_QUERY_LIST } from "./operations.ts";

const AGGREGATE: SearchAggregateResult = {
  hits: [],
  hasMore: false,
  warnings: [],
};

const FACETS: SearchFacetSet = {
  kinds: [],
  facets: [],
  warnings: [],
};

interface Harness {
  readonly context: SearchActivationContext;
  readonly registrations: Map<string, ActivationQueryRegistration>;
  readonly contributions: UiContribution[];
  readonly aggregate: ReturnType<typeof vi.fn>;
  readonly listFacets: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const registrations = new Map<string, ActivationQueryRegistration>();
  const contributions: UiContribution[] = [];
  const aggregate = vi.fn(async () => AGGREGATE);
  const listFacets = vi.fn(async () => FACETS);

  const context = {
    pluginId: SEARCH_PLUGIN_ID,
    queries: {
      register(registration: ActivationQueryRegistration) {
        registrations.set(registration.metadata.id, registration);
      },
      unregister() {
        return true;
      },
    },
    ui: {
      register(next: readonly UiContribution[]) {
        contributions.push(...next);
      },
      unregister() {
        // Намеренно пусто.
      },
    },
    search: {
      aggregate,
      listFacets,
    } as unknown as PluginSearchService,
  } as unknown as SearchActivationContext;

  return { context, registrations, contributions, aggregate, listFacets };
}

describe("активация kanbaner.search", () => {
  it("регистрирует две read-only query и UI-вклады", async () => {
    const harness = createHarness();

    await activate(harness.context);

    expect([...harness.registrations.keys()].sort()).toEqual([
      SEARCH_QUERY_IDS.filters,
      SEARCH_QUERY_IDS.query,
    ]);

    const query = harness.registrations.get(SEARCH_QUERY_IDS.query);
    const filters = harness.registrations.get(SEARCH_QUERY_IDS.filters);

    expect(query?.metadata).toMatchObject({
      kind: "query",
      risk: "read",
      exposure: { ui: true, http: true, mcp: true },
    });
    expect(filters?.metadata).toMatchObject({
      kind: "query",
      risk: "read",
      exposure: { ui: true, http: true, mcp: false },
    });
    expect(SEARCH_QUERY_LIST).toHaveLength(2);
    expect(harness.contributions.map((contribution) => contribution.id).sort()).toEqual([
      "kanbaner.search.navigation",
      "kanbaner.search.view",
    ]);
  });

  it("передаёт в агрегатор только заданные поля запроса", async () => {
    const harness = createHarness();

    await activate(harness.context);
    await harness.registrations.get(SEARCH_QUERY_IDS.query)?.handler(
      {
        text: "маркер",
        filters: [{ field: "projectId", operator: "eq", value: "project-1" }],
        limit: 10,
      },
      {} as never,
    );

    expect(harness.aggregate).toHaveBeenCalledWith({
      text: "маркер",
      filters: [{ field: "projectId", operator: "eq", value: "project-1" }],
      limit: 10,
    });
  });

  it("возвращает facet-ы для пустого входа", async () => {
    const harness = createHarness();

    await activate(harness.context);

    const result = await harness.registrations
      .get(SEARCH_QUERY_IDS.filters)
      ?.handler({}, {} as never);

    expect(harness.listFacets).toHaveBeenCalledTimes(1);
    expect(result).toEqual(FACETS);
  });

  it("отклоняет активацию под чужим Plugin ID", async () => {
    const harness = createHarness();
    const foreign = {
      ...harness.context,
      pluginId: "kanbaner.foreign",
    } as SearchActivationContext;

    await expect(activate(foreign)).rejects.toThrow("другой Plugin ID");
  });
});
