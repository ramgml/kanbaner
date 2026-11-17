import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskSearch } from "./task-search.tsx";
import {
  getKanbanQuerySnapshot,
  resetKanbanFilters,
  resetKanbanQueryForTests,
  serializeKanbanQuery,
  updateKanbanQuery,
} from "./query-state.ts";
import {
  getTaskListQuerySnapshot,
  parseTaskListQuery,
  resetTaskListFilters,
  resetTaskListQueryForTests,
  serializeTaskListQuery,
  updateTaskListQuery,
  useTaskListQuery,
} from "../task-list/query-state.ts";
import { useKanbanQuery } from "./query-state.ts";

beforeEach(() => {
  window.history.replaceState(null, "", "/view/tasks");
  resetTaskListQueryForTests("");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
});

function ListQueryProbe({ search }: { readonly search: string }) {
  const query = useTaskListQuery(search);

  return <output data-testid="list-query">{`${query.q}|${query.projectId}`}</output>;
}

function KanbanQueryProbe({ search }: { readonly search: string }) {
  const query = useKanbanQuery(search);

  return <output data-testid="kanban-query">{`${query.q}|${query.tag}`}</output>;
}

describe("TaskSearch", () => {
  it("рисует searchbox с label, placeholder и доступной очисткой", () => {
    const { container } = render(<TaskSearch value="релиз" onChange={() => undefined} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    expect(input).toHaveAttribute("placeholder", "Название или описание");
    expect(input).toHaveValue("релиз");
    expect(screen.getByRole("button", { name: "Очистить поиск задач" })).toBeVisible();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("немедленно вызывает onChange на каждый ввод без локального черновика", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });

    expect(onChange).toHaveBeenNthCalledWith(1, "a");
    expect(onChange).toHaveBeenNthCalledWith(2, "ab");
    expect(onChange).toHaveBeenNthCalledWith(3, "abc");
    expect(onChange).toHaveBeenCalledTimes(3);

    // Controlled: до обновления value поле показывает прежнее значение.
    expect(input).toHaveValue("");

    view.rerender(<TaskSearch value="abc" onChange={onChange} />);
    expect(input).toHaveValue("abc");
  });

  it("следует за внешним reset и навигацией без отката ввода", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="release" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    view.rerender(<TaskSearch value="" onChange={onChange} />);
    expect(input).toHaveValue("");

    view.rerender(<TaskSearch value="release notes" onChange={onChange} />);
    expect(input).toHaveValue("release notes");

    view.rerender(<TaskSearch value="backend" onChange={onChange} />);
    expect(input).toHaveValue("backend");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("очищает поиск кнопкой и возвращает фокус в поле", () => {
    const onChange = vi.fn();

    render(<TaskSearch value="release" onChange={onChange} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    fireEvent.click(screen.getByRole("button", { name: "Очистить поиск задач" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input).toHaveFocus();
  });
});

describe("query-state поиска", () => {
  it("читает и сериализует q списка, сохраняя пробелы внутри строки", () => {
    const parsed = parseTaskListQuery("?project=p1&q=Release%20notes&page=3");

    expect(parsed.q).toBe("Release notes");
    expect(serializeTaskListQuery(parsed)).toContain("q=Release+notes");
    expect(serializeTaskListQuery(parsed)).toContain("page=3");
  });

  it("сбрасывает page при изменении q и очищает поиск вместе с фильтрами", () => {
    resetTaskListQueryForTests("?project=p1&page=3&q=old");

    updateTaskListQuery({ q: "new" });

    expect(getTaskListQuerySnapshot()).toMatchObject({ q: "new", page: 1 });

    resetTaskListFilters();

    expect(getTaskListQuerySnapshot()).toMatchObject({ q: "", page: 1 });
    expect(serializeTaskListQuery(getTaskListQuerySnapshot())).not.toContain("q=");
  });

  it("читает, сериализует и сбрасывает q канбана", () => {
    resetKanbanQueryForTests("?project=p1&tag=release&q=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7");

    expect(getKanbanQuerySnapshot()).toMatchObject({ tag: "release", q: "релиз" });
    expect(serializeKanbanQuery(getKanbanQuerySnapshot())).toContain(
      "q=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7",
    );

    updateKanbanQuery({ q: "backend" });
    expect(serializeKanbanQuery(getKanbanQuerySnapshot())).toContain("q=backend");

    resetKanbanFilters();
    expect(getKanbanQuerySnapshot()).toMatchObject({ tag: "", q: "" });
    expect(serializeKanbanQuery(getKanbanQuerySnapshot())).not.toContain("q=");
  });

  it("не откатывает список запоздалым router echo, но принимает актуальный search и внешнюю ссылку", () => {
    const view = render(<ListQueryProbe search="" />);

    expect(screen.getByTestId("list-query")).toHaveTextContent("|");

    act(() => {
      updateTaskListQuery({ q: "a" });
    });
    act(() => {
      updateTaskListQuery({ q: "ab" });
    });

    // Запоздалое эхо первой записи приходит после второй.
    view.rerender(<ListQueryProbe search="?q=a" />);
    expect(screen.getByTestId("list-query")).toHaveTextContent("ab|");

    view.rerender(<ListQueryProbe search="?q=ab" />);
    expect(screen.getByTestId("list-query")).toHaveTextContent("ab|");

    // Внешняя навигация не входит в локальную историю и применяется целиком.
    view.rerender(<ListQueryProbe search="?project=p2&q=external" />);
    expect(screen.getByTestId("list-query")).toHaveTextContent("external|p2");
  });

  it("не откатывает канбан запоздалым router echo, но принимает актуальный search и внешнюю ссылку", () => {
    const view = render(<KanbanQueryProbe search="" />);

    expect(screen.getByTestId("kanban-query")).toHaveTextContent("|");

    act(() => {
      updateKanbanQuery({ q: "a" });
    });
    act(() => {
      updateKanbanQuery({ q: "ab" });
    });

    view.rerender(<KanbanQueryProbe search="?q=a" />);
    expect(screen.getByTestId("kanban-query")).toHaveTextContent("ab|");

    view.rerender(<KanbanQueryProbe search="?q=ab" />);
    expect(screen.getByTestId("kanban-query")).toHaveTextContent("ab|");

    view.rerender(<KanbanQueryProbe search="?tag=release&q=external" />);
    expect(screen.getByTestId("kanban-query")).toHaveTextContent("external|release");
  });
});
