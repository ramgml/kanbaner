import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskSearch, TASK_SEARCH_DEBOUNCE_MS } from "./task-search.tsx";
import {
  getKanbanQuerySnapshot,
  resetKanbanFilters,
  resetKanbanQueryForTests,
  serializeKanbanQuery,
  updateKanbanQuery,
  useKanbanQuery,
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

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/view/tasks");
  resetTaskListQueryForTests("");
  resetKanbanQueryForTests("");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ListQueryProbe({ search }: { readonly search: string }) {
  const query = useTaskListQuery(search);

  return <output data-testid="list-query">{`${query.q}|${query.projectId}|${query.tag}`}</output>;
}

function KanbanQueryProbe({ search }: { readonly search: string }) {
  const query = useKanbanQuery(search);

  return (
    <output data-testid="kanban-query">{`${query.q}|${query.tag}|${query.taskId ?? ""}`}</output>
  );
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

  it("немедленно меняет draft и отправляет только последнее значение после debounce", () => {
    const onChange = vi.fn();

    render(<TaskSearch value="" onChange={onChange} debounceMs={TASK_SEARCH_DEBOUNCE_MS} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });

    expect(input).toHaveValue("ab");
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS - 1);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("ab");
  });

  it("не откатывает draft запоздалым router echo, пока поле в фокусе", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });

    view.rerender(<TaskSearch value="a" onChange={onChange} />);
    expect(input).toHaveValue("ab");

    act(() => {
      vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS);
    });
    expect(onChange).toHaveBeenLastCalledWith("ab");

    view.rerender(<TaskSearch value="ab" onChange={onChange} />);
    expect(input).toHaveValue("ab");
  });

  it("синхронизирует внешнее value, когда поле не в фокусе", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="release" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    view.rerender(<TaskSearch value="" onChange={onChange} />);
    expect(input).toHaveValue("");

    view.rerender(<TaskSearch value="backend" onChange={onChange} />);
    expect(input).toHaveValue("backend");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("синхронно фиксирует pending draft на blur до следующего click-действия", () => {
    const onChange = vi.fn();

    render(<TaskSearch value="" onChange={onChange} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: "release" } });

    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("release");

    act(() => {
      vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("очищает поиск кнопкой, отменяет timer и возвращает фокус", () => {
    const onChange = vi.fn();

    render(<TaskSearch value="" onChange={onChange} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: "release" } });
    fireEvent.click(screen.getByRole("button", { name: "Очистить поиск задач" }));

    expect(input).toHaveValue("");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input).toHaveFocus();

    act(() => {
      vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("снимает timer при unmount без отложенного setState", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: "abc" } });

    view.unmount();

    act(() => {
      vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onChange).not.toHaveBeenCalled();
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

  it("применяет production search без '?' и сохраняет остальные фильтры списка", () => {
    const view = render(<ListQueryProbe search="" />);

    view.rerender(<ListQueryProbe search="project=p1&tag=release&q=ab" />);

    expect(screen.getByTestId("list-query")).toHaveTextContent("ab|p1|release");
  });

  it("применяет production search без '?' и сохраняет выбранную задачу канбана", () => {
    const view = render(<KanbanQueryProbe search="" />);

    view.rerender(<KanbanQueryProbe search="project=p1&tag=release&q=ab&task=t1" />);

    expect(screen.getByTestId("kanban-query")).toHaveTextContent("ab|release|t1");
  });
});
