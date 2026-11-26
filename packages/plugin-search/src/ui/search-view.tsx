"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { JsonValue } from "@kanbaner/plugin-sdk";

import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_OFFSET, SEARCH_QUERY_IDS } from "../constants.ts";
import type {
  SearchFacet,
  SearchFilterInput,
  SearchFiltersOutput,
  SearchHitResult,
  SearchKind,
  SearchQueryOutput,
} from "../schemas.ts";
import { invokeSearch, type SearchUiRendererProps } from "./runtime.ts";

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const selectClass =
  "w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const hitClass =
  "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const EMPTY_FACETS: readonly SearchFacet[] = [];
const EMPTY_KINDS: readonly SearchKind[] = [];
const EMPTY_HITS: readonly SearchHitResult[] = [];

interface ActiveQuery {
  readonly input: Readonly<Record<string, JsonValue>>;
}

function mergeHits(
  existing: readonly SearchHitResult[],
  incoming: readonly SearchHitResult[],
): SearchHitResult[] {
  const seen = new Set(existing.map((hit) => hit.ref));
  const merged = [...existing];

  for (const hit of incoming) {
    if (seen.has(hit.ref)) {
      continue;
    }

    seen.add(hit.ref);
    merged.push(hit);
  }

  return merged;
}

function facetValueLabel(facet: SearchFacet, value: string): string {
  return facet.values.find((candidate) => candidate.value === value)?.label ?? value;
}

/**
 * Размер страницы для текущей позиции. На последней допустимой странице
 * окно урезается, чтобы offset + limit не выходил за SEARCH_MAX_OFFSET.
 */
function pageLimitAt(offset: number): number {
  return Math.min(SEARCH_DEFAULT_LIMIT, SEARCH_MAX_OFFSET - offset);
}

function warningText(code: string, providerId: string): string {
  if (code === "provider_failed") {
    return `Провайдер ${providerId} временно недоступен`;
  }

  return `Провайдер ${providerId} вернул ссылку вне своего namespace`;
}

export function SearchView(props: SearchUiRendererProps) {
  const { invoke, openResource } = props;
  const [text, setText] = useState("");
  const [kind, setKind] = useState("");
  const [selectedFacets, setSelectedFacets] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<SearchFiltersOutput | null>(null);
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [filtersError, setFiltersError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchQueryOutput | null>(null);
  const [activeQuery, setActiveQuery] = useState<ActiveQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    invokeSearch<SearchFiltersOutput>(invoke, SEARCH_QUERY_IDS.filters, {})
      .then((data) => {
        if (!cancelled) {
          setFilters(data);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setFiltersError(cause instanceof Error ? cause.message : "Не удалось получить фильтры");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFiltersLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [invoke]);

  const facetList = filters?.facets ?? EMPTY_FACETS;
  const kindList = filters?.kinds ?? EMPTY_KINDS;

  const buildFilters = useCallback((): readonly SearchFilterInput[] => {
    const built: SearchFilterInput[] = [];

    for (const facet of facetList) {
      const value = selectedFacets[facet.id];

      if (value === undefined || value.length === 0) {
        continue;
      }

      built.push({
        field: facet.id,
        operator: facet.operators.includes("eq") ? "eq" : "contains",
        value,
      });
    }

    return built;
  }, [facetList, selectedFacets]);

  const submit = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();

      const trimmed = text.trim();

      if (trimmed.length === 0) {
        return;
      }

      const generation = requestRef.current + 1;
      const filtersToSend = buildFilters();
      requestRef.current = generation;
      setLoading(true);
      setError(null);
      setOpenError(null);
      // Новый запрос всегда начинает первую страницу: курсор прошлой выдачи
      // сбрасывается до получения ответа.
      setPageCursor(0);

      const input: { [key: string]: JsonValue } = {
        text: trimmed,
        limit: SEARCH_DEFAULT_LIMIT,
        offset: 0,
      };

      if (kind.length > 0) {
        input.kinds = [kind];
      }

      if (filtersToSend.length > 0) {
        input.filters = filtersToSend.map((filter) => ({ ...filter }));
      }

      // Новый запрос всегда начинает первую страницу: накопленная выдача и
      // offset прошлого запроса не переиспользуются.
      setActiveQuery({ input });

      try {
        const data = await invokeSearch<SearchQueryOutput>(invoke, SEARCH_QUERY_IDS.query, input);

        if (generation === requestRef.current) {
          // Курсор считается по сырым hits ответа, а не по дедуплицированному
          // React-списку: иначе полностью повторная страница не сдвинет offset.
          setPageCursor(data.hits.length);
          setResult(data);
        }
      } catch (cause) {
        if (generation === requestRef.current) {
          setResult(null);
          setError(cause instanceof Error ? cause.message : "Поиск не удался");
        }
      } finally {
        if (generation === requestRef.current) {
          setLoading(false);
        }
      }
    },
    [buildFilters, invoke, kind, text],
  );

  const loadMore = useCallback(async () => {
    if (activeQuery === null || result === null || !result.hasMore || loading) {
      return;
    }

    const offset = pageCursor;
    const limit = pageLimitAt(offset);

    if (limit < 1 || offset + limit > SEARCH_MAX_OFFSET) {
      return;
    }

    const generation = requestRef.current + 1;
    requestRef.current = generation;
    setLoading(true);
    setError(null);

    const input: { [key: string]: JsonValue } = {
      ...activeQuery.input,
      offset,
      limit,
    };

    try {
      const data = await invokeSearch<SearchQueryOutput>(invoke, SEARCH_QUERY_IDS.query, input);

      if (generation === requestRef.current) {
        setPageCursor(offset + data.hits.length);
        setResult((current) =>
          current === null ? data : { ...data, hits: mergeHits(current.hits, data.hits) },
        );
      }
    } catch (cause) {
      if (generation === requestRef.current) {
        setError(cause instanceof Error ? cause.message : "Поиск не удался");
      }
    } finally {
      if (generation === requestRef.current) {
        setLoading(false);
      }
    }
  }, [activeQuery, invoke, loading, pageCursor, result]);

  const openHit = useCallback(
    (hit: SearchHitResult) => {
      if (openResource === undefined) {
        return;
      }

      const outcome = openResource(hit.ref as Parameters<NonNullable<typeof openResource>>[0]);

      if (!outcome.ok) {
        setOpenError(outcome.message);
        return;
      }

      setOpenError(null);
    },
    [openResource],
  );

  const hits = result?.hits ?? EMPTY_HITS;
  const canLoadMore =
    result?.hasMore === true && pageCursor < SEARCH_MAX_OFFSET && pageLimitAt(pageCursor) > 0;
  const warnings = useMemo(() => {
    const all = [...(filters?.warnings ?? []), ...(result?.warnings ?? [])];
    const seen = new Set<string>();

    return all.filter((warning) => {
      const key = `${warning.providerId}:${warning.code}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }, [filters, result]);

  return (
    <section
      className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 px-3 py-4 sm:px-6"
      data-testid="search-view"
      aria-labelledby="search-heading"
    >
      <header className="min-w-0">
        <h1 id="search-heading" className="text-xl font-semibold tracking-tight">
          Поиск
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ищет по активным плагинам. Фильтры применяются только к доменам, которые их объявляют.
        </p>
      </header>

      <form className="flex min-w-0 flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="search-text">
            Поисковый запрос
          </label>
          <input
            id="search-text"
            data-testid="search-input"
            className={inputClass}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Текст, фраза или prefix"
            autoComplete="off"
            maxLength={500}
          />
          <button
            type="submit"
            className={buttonClass}
            disabled={loading || text.trim().length === 0}
          >
            <Search aria-hidden="true" className="size-4" />
            {loading ? "Ищу…" : "Найти"}
          </button>
        </div>

        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            Тип
            <select
              data-testid="search-kind"
              className={selectClass}
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">Все типы</option>
              {kindList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>

          {facetList.map((facet) => (
            <label
              key={facet.id}
              className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground"
            >
              {facet.title}
              <select
                data-testid={`search-facet-${facet.id}`}
                className={selectClass}
                value={selectedFacets[facet.id] ?? ""}
                onChange={(event) =>
                  setSelectedFacets((current) => ({
                    ...current,
                    [facet.id]: event.target.value,
                  }))
                }
              >
                <option value="">Все</option>
                {facet.values.map((value) => (
                  <option key={value.value} value={value.value}>
                    {facetValueLabel(facet, value.value)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        {filtersLoading ? (
          <p className="text-xs text-muted-foreground" data-testid="search-filters-loading">
            Загружаю фильтры…
          </p>
        ) : null}
        {filtersError === null ? null : (
          <p className="text-sm text-destructive" data-testid="search-filters-error" role="alert">
            {filtersError}
          </p>
        )}
      </form>

      {warnings.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground" data-testid="search-warnings">
          {warnings.map((warning) => (
            <li key={`${warning.providerId}:${warning.code}`}>
              {warningText(warning.code, warning.providerId)}
            </li>
          ))}
        </ul>
      ) : null}

      {error === null ? null : (
        <p className="text-sm text-destructive" data-testid="search-error" role="alert">
          {error}
        </p>
      )}

      {openError === null ? null : (
        <p className="text-sm text-destructive" data-testid="search-open-error" role="alert">
          {openError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="search-loading" role="status">
          Ищу…
        </p>
      ) : null}

      {!loading && result !== null && hits.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="search-empty">
          Ничего не найдено.
        </p>
      ) : null}

      {hits.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground" data-testid="search-count">
            Найдено: {hits.length}
            {result?.hasMore === true ? " (показаны не все)" : ""}
          </p>
          <ul className="flex min-w-0 flex-col gap-2" data-testid="search-results">
            {hits.map((hit) => (
              <li key={hit.ref} className="min-w-0">
                <button
                  type="button"
                  className={hitClass}
                  data-search-hit={hit.ref}
                  onClick={() => openHit(hit)}
                >
                  <span className="block truncate text-sm font-medium">{hit.title}</span>
                  {hit.excerpt.length > 0 ? (
                    <span className="mt-1 block whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {hit.excerpt}
                    </span>
                  ) : null}
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                    {hit.kind ?? "ресурс"} · {hit.ref}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {canLoadMore ? (
            <button
              type="button"
              className={`${buttonClass} self-start`}
              data-testid="search-load-more"
              onClick={() => void loadMore()}
              disabled={loading}
            >
              {loading ? "Загружаю…" : "Показать ещё"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
