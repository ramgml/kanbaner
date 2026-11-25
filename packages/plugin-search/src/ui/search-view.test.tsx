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
