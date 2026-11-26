// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SEARCH_QUERY_IDS } from "../constants.ts";
import type { SearchFiltersOutput, SearchQueryOutput } from "../schemas.ts";
import { SearchView } from "./search-view.tsx";
import type { SearchUiOperationInvoker, SearchUiOperationResult } from "./runtime.ts";

const FILTERS: SearchFiltersOutput = {
  kinds: [{ id: "task", title: "Задачи" }],
  facets: [
    {
      id: "projectId",
      title: "Проект",
      operators: ["eq"],
      values: [{ value: "project-1", label: "Проект 1" }],
    },
    {
      id: "tags",
      title: "Тег",
      operators: ["contains"],
      values: [{ value: "search", label: "search" }],
    },
  ],
  warnings: [],
};

const RESULT: SearchQueryOutput = {
  hits: [
    {
      ref: "kanbaner.tasks:task:task-1",
      title: "Маркерная задача",
      excerpt: "Кириллический маркер",
      score: 1,
      strategy: "full-text",
      kind: "task",
      metadata: { projectId: "project-1", tags: ["search"] },
    },
  ],
  hasMore: false,
  warnings: [],
};

type Invoker = SearchUiOperationInvoker & ReturnType<typeof vi.fn>;

function createInvoker(
  queryResult: SearchUiOperationResult = { ok: true, data: RESULT },
  filtersResult: SearchUiOperationResult = { ok: true, data: FILTERS },
): Invoker {
  const invoke = vi.fn(async (operationId: string) => {
    if (operationId === SEARCH_QUERY_IDS.filters) {
      return filtersResult;
    }

    if (operationId === SEARCH_QUERY_IDS.query) {
      return queryResult;
    }

    throw new Error(`Неизвестная операция ${operationId}`);
  }) as unknown as Invoker;

  return invoke;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
});

describe("SearchView", () => {
  it("загружает фильтры и отправляет выбранные facet-ы", async () => {
    const invoke = createInvoker();
    const openResource = vi.fn(() => ({ ok: true as const }));

    render(<SearchView invoke={invoke} openResource={openResource} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "маркер" },
    });
    fireEvent.change(screen.getByTestId("search-kind"), {
      target: { value: "task" },
    });
    fireEvent.change(screen.getByTestId("search-facet-projectId"), {
      target: { value: "project-1" },
    });
    fireEvent.change(screen.getByTestId("search-facet-tags"), {
      target: { value: "search" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getByTestId("search-results")).toBeInTheDocument();
    });

    expect(invoke).toHaveBeenCalledWith(SEARCH_QUERY_IDS.query, {
      text: "маркер",
      kinds: ["task"],
      filters: [
        { field: "projectId", operator: "eq", value: "project-1" },
        { field: "tags", operator: "contains", value: "search" },
      ],
      limit: 20,
      offset: 0,
    });

    const hit = screen.getByRole("button", { name: /Маркерная задача/u });

    expect(hit).toHaveAttribute("data-search-hit", "kanbaner.tasks:task:task-1");
    fireEvent.click(hit);
    expect(openResource).toHaveBeenCalledWith("kanbaner.tasks:task:task-1");
  });

  it("показывает предупреждения и безопасную ошибку открытия", async () => {
    const invoke = createInvoker({
      ok: true,
      data: {
        ...RESULT,
        warnings: [{ providerId: "kanbaner.notes", code: "provider_failed" }],
      },
    });
    const openResource = vi.fn(() => ({
      ok: false as const,
      code: "RESOURCE_UNAVAILABLE",
      message: "Ресурс недоступен",
    }));

    render(<SearchView invoke={invoke} openResource={openResource} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "маркер" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getByTestId("search-warnings")).toHaveTextContent(
        "Провайдер kanbaner.notes временно недоступен",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /Маркерная задача/u }));

    expect(screen.getByTestId("search-open-error")).toHaveTextContent("Ресурс недоступен");
  });

  it("догружает следующую страницу с offset и дедуплицирует hits", async () => {
    const firstPage: SearchQueryOutput = {
      hits: [
        {
          ref: "kanbaner.tasks:task:task-1",
          title: "Первая",
          excerpt: "",
          score: 2,
          strategy: "full-text",
          kind: "task",
        },
        {
          ref: "kanbaner.tasks:task:task-2",
          title: "Вторая",
          excerpt: "",
          score: 1,
          strategy: "full-text",
          kind: "task",
        },
      ],
      hasMore: true,
      warnings: [],
    };
    const secondPage: SearchQueryOutput = {
      hits: [
        {
          ref: "kanbaner.tasks:task:task-2",
          title: "Вторая",
          excerpt: "",
          score: 1,
          strategy: "full-text",
          kind: "task",
        },
        {
          ref: "kanbaner.tasks:task:task-3",
          title: "Третья",
          excerpt: "",
          score: 0.5,
          strategy: "full-text",
          kind: "task",
        },
      ],
      hasMore: false,
      warnings: [],
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: firstPage })
      .mockResolvedValueOnce({ ok: true, data: secondPage });
    const invoke = vi.fn(async (operationId: string, input: unknown) =>
      operationId === SEARCH_QUERY_IDS.filters ? { ok: true, data: FILTERS } : query(input),
    ) as unknown as Invoker;

    render(<SearchView invoke={invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "маркер" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Первая|Вторая/u })).toHaveLength(2);
    });
    expect(screen.getByTestId("search-count")).toHaveTextContent("(показаны не все)");

    fireEvent.click(screen.getByTestId("search-load-more"));

    await waitFor(() => {
      expect(screen.getByText("Третья")).toBeInTheDocument();
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith({
      text: "маркер",
      offset: 2,
      limit: 20,
    });
    expect(screen.getByTestId("search-count")).toHaveTextContent("Найдено: 3");
    expect(screen.queryByTestId("search-load-more")).not.toBeInTheDocument();
  });

  it("сдвигает offset по сырым hits, даже если страница полностью дублирует предыдущую", async () => {
    const hit = (id: string, title: string): SearchQueryOutput["hits"][number] => ({
      ref: `kanbaner.tasks:task:${id}`,
      title,
      excerpt: "",
      score: 1,
      strategy: "full-text",
      kind: "task",
    });
    const pageOne: SearchQueryOutput = {
      hits: [hit("a", "A"), hit("b", "B")],
      hasMore: true,
      warnings: [],
    };
    // Вторая страница целиком повторяет первую: дедуплицированный список не
    // растёт, но курсор обязан сдвинуться на сырые hits ответа.
    const pageTwo: SearchQueryOutput = {
      hits: [hit("a", "A"), hit("b", "B")],
      hasMore: true,
      warnings: [],
    };
    const pageThree: SearchQueryOutput = {
      hits: [hit("c", "C"), hit("d", "D")],
      hasMore: false,
      warnings: [],
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: pageOne })
      .mockResolvedValueOnce({ ok: true, data: pageTwo })
      .mockResolvedValueOnce({ ok: true, data: pageThree });
    const invoke = vi.fn(async (operationId: string, input: unknown) =>
      operationId === SEARCH_QUERY_IDS.filters ? { ok: true, data: FILTERS } : query(input),
    ) as unknown as Invoker;

    render(<SearchView invoke={invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "маркер" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getAllByText(/^[AB]$/u)).toHaveLength(2);
    });

    fireEvent.click(screen.getByTestId("search-load-more"));

    await waitFor(() => {
      expect(query).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("search-load-more")).toBeEnabled();
    });

    // После дублирующей страницы список остаётся A, B, но кнопка доступна.
    expect(screen.getAllByText(/^[AB]$/u)).toHaveLength(2);
    expect(screen.getByTestId("search-load-more")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("search-load-more"));

    await waitFor(() => {
      expect(screen.getByText("C")).toBeInTheDocument();
    });

    const offsets = query.mock.calls.map((call) => {
      const input = call[0] as { offset?: number };

      return input.offset;
    });

    expect(offsets).toEqual([0, 2, 4]);
    expect(offsets.filter((offset) => offset === 2)).toHaveLength(1);
    expect(screen.getAllByText(/^[ABCD]$/u)).toHaveLength(4);
    expect(screen.getByTestId("search-count")).toHaveTextContent("Найдено: 4");
    expect(screen.queryByTestId("search-load-more")).not.toBeInTheDocument();
  });

  it("сбрасывает страницу при новом запросе", async () => {
    const firstPage: SearchQueryOutput = {
      hits: [
        {
          ref: "kanbaner.tasks:task:task-1",
          title: "Старая",
          excerpt: "",
          score: 1,
          strategy: "full-text",
          kind: "task",
        },
      ],
      hasMore: true,
      warnings: [],
    };
    const nextPage: SearchQueryOutput = {
      hits: [
        {
          ref: "kanbaner.tasks:task:task-9",
          title: "Новая",
          excerpt: "",
          score: 1,
          strategy: "full-text",
          kind: "task",
        },
      ],
      hasMore: false,
      warnings: [],
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: firstPage })
      .mockResolvedValueOnce({ ok: true, data: nextPage });
    const invoke = vi.fn(async (operationId: string, input: unknown) =>
      operationId === SEARCH_QUERY_IDS.filters ? { ok: true, data: FILTERS } : query(input),
    ) as unknown as Invoker;

    render(<SearchView invoke={invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "первый" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getByText("Старая")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "второй" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getByText("Новая")).toBeInTheDocument();
    });

    expect(screen.queryByText("Старая")).not.toBeInTheDocument();
    expect(query).toHaveBeenLastCalledWith({ text: "второй", limit: 20, offset: 0 });
  });

  it("игнорирует устаревший ответ, показывая последнюю выдачу", async () => {
    const slow = deferred<SearchUiOperationResult>();
    const fast = deferred<SearchUiOperationResult>();
    const hit = (ref: string, title: string): SearchQueryOutput["hits"][number] => ({
      ref,
      title,
      excerpt: "",
      score: 1,
      strategy: "full-text",
      kind: "task",
    });
    const invoke = vi.fn(async (operationId: string, input: unknown) => {
      if (operationId === SEARCH_QUERY_IDS.filters) {
        return { ok: true, data: FILTERS };
      }

      const text = (input as { readonly text?: string }).text;

      return text === "медленный" ? slow.promise : fast.promise;
    }) as unknown as Invoker;

    render(<SearchView invoke={invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    const form = screen.getByTestId("search-view").querySelector("form");
    expect(form).not.toBeNull();

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "медленный" },
    });
    fireEvent.submit(form as HTMLFormElement);

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "быстрый" },
    });
    fireEvent.submit(form as HTMLFormElement);

    fast.resolve({
      ok: true,
      data: { hits: [hit("kanbaner.tasks:task:fast", "Быстрая")], hasMore: false, warnings: [] },
    });

    await waitFor(() => {
      expect(screen.getByText("Быстрая")).toBeInTheDocument();
    });

    slow.resolve({
      ok: true,
      data: { hits: [hit("kanbaner.tasks:task:slow", "Медленная")], hasMore: false, warnings: [] },
    });

    await waitFor(() => {
      expect(screen.queryByText("Медленная")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Быстрая")).toBeInTheDocument();
  });

  it("показывает состояние загрузки и ошибку запроса", async () => {
    const pending = deferred<SearchUiOperationResult>();
    const invoke = vi.fn(async (operationId: string) =>
      operationId === SEARCH_QUERY_IDS.filters ? { ok: true, data: FILTERS } : pending.promise,
    ) as unknown as Invoker;

    render(<SearchView invoke={invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "маркер" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    expect(screen.getByTestId("search-loading")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ищу…" })).toBeDisabled();

    pending.reject(new Error("Поиск недоступен"));

    await waitFor(() => {
      expect(screen.getByTestId("search-error")).toHaveTextContent("Поиск недоступен");
    });
    expect(screen.queryByTestId("search-loading")).not.toBeInTheDocument();
  });

  it("показывает ошибку фильтров и не блокирует поиск", async () => {
    const invoke = vi.fn(async (operationId: string) => {
      if (operationId === SEARCH_QUERY_IDS.filters) {
        return {
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Фильтры недоступны", retryable: true },
        };
      }

      return { ok: true, data: RESULT };
    }) as unknown as Invoker;

    render(<SearchView invoke={invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-filters-error")).toHaveTextContent("Фильтры недоступны");
    });
    expect(screen.queryByTestId("search-filters-loading")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "маркер" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getByTestId("search-results")).toBeInTheDocument();
    });
  });

  it("показывает пустую выдачу без ошибки", async () => {
    const invoke = createInvoker({
      ok: true,
      data: { hits: [], hasMore: false, warnings: [] },
    });

    render(<SearchView invoke={invoke} />);

    await waitFor(() => {
      expect(screen.getByTestId("search-kind")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "нет совпадений" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => {
      expect(screen.getByTestId("search-empty")).toHaveTextContent("Ничего не найдено");
    });
  });
});
