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

describe("TaskSearch", () => {
  it("рисует searchbox с label, placeholder и доступной очисткой", () => {
    const { container } = render(<TaskSearch value="релиз" onChange={() => undefined} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    expect(input).toHaveAttribute("placeholder", "Название или описание");
    expect(input).toHaveValue("релиз");
    expect(screen.getByRole("button", { name: "Очистить поиск задач" })).toBeVisible();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("дебаунсит быстрый ввод и отправляет последнее значение", () => {
    const onChange = vi.fn();

    render(<TaskSearch value="" onChange={onChange} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });

    expect(input).toHaveValue("abc");
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(274);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("abc");
  });

  it("не откатывает ввод устаревшей query string", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    act(() => {
      input.focus();
    });
    fireEvent.change(input, { target: { value: "abc" } });

    // Router ещё не догнал ввод: старое значение не должно заменить черновик.
    view.rerender(<TaskSearch value="ab" onChange={onChange} />);
    expect(input).toHaveValue("abc");

    act(() => {
      vi.advanceTimersByTime(275);
    });
    expect(onChange).toHaveBeenLastCalledWith("abc");

    view.rerender(<TaskSearch value="abc" onChange={onChange} />);
    expect(input).toHaveValue("abc");

    // Запоздалое эхо-значение — префикс свежего ввода — тоже игнорируется.
    view.rerender(<TaskSearch value="a" onChange={onChange} />);
    expect(input).toHaveValue("abc");
  });

  it("принимает внешний сброс и отменяет незавершённый debounce", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="release" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "release notes" } });

    view.rerender(<TaskSearch value="" onChange={onChange} />);

    expect(input).toHaveValue("");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("очищает поиск кнопкой и отменяет ожидающий таймер", () => {
    const onChange = vi.fn();

    render(<TaskSearch value="release" onChange={onChange} />);

    const input = screen.getByRole("searchbox", { name: "Поиск задач" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "release notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Очистить поиск задач" }));

    expect(input).toHaveValue("");
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input).toHaveFocus();
  });

  it("снимает таймер при unmount", () => {
    const onChange = vi.fn();
    const view = render(<TaskSearch value="" onChange={onChange} />);

    fireEvent.focus(screen.getByRole("searchbox", { name: "Поиск задач" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск задач" }), {
      target: { value: "abc" },
    });

    view.unmount();

    act(() => {
      vi.advanceTimersByTime(500);
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
});
