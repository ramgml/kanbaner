import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanColumn } from "./ui/kanban-column.tsx";

afterEach(() => {
  cleanup();
});

const noop = vi.fn();

describe("KanbanColumn composer", () => {
  it("ставит composer сразу после header, до ошибки и прокручиваемого списка", () => {
    render(
      <KanbanColumn
        status="todo"
        total={3}
        loading={false}
        error="Не удалось загрузить"
        hasMore
        dragOver={false}
        dropActive={false}
        onLoadMore={noop}
        onRetry={noop}
        quickComposer={<button data-testid="composer-trigger">+ Добавить карточку</button>}
      >
        <li data-testid="card-1">Карточка 1</li>
        <li data-testid="card-2">Карточка 2</li>
      </KanbanColumn>,
    );

    const column = screen.getByTestId("kanban-column-todo");
    const header = column.querySelector("header");
    const composer = screen.getByTestId("kanban-quick-composer-todo");
    const error = screen.getByTestId("kanban-column-error-todo");
    const scroll = screen.getByTestId("kanban-column-scroll-todo");

    expect(column.firstElementChild).toBe(header);
    expect(header?.nextElementSibling).toBe(composer);
    expect(composer).toContainElement(screen.getByTestId("composer-trigger"));
    expect(composer).toHaveClass("shrink-0");
    expect(scroll).not.toContainElement(composer);
    expect(composer.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      composer.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Нижней копии composer-а больше нет: на колонку ровно один триггер.
    expect(screen.getAllByTestId("composer-trigger")).toHaveLength(1);
  });

  it("оставляет composer выше loading и длинного списка карточек", () => {
    render(
      <KanbanColumn
        status="backlog"
        total={0}
        loading
        error={null}
        hasMore={false}
        dragOver={false}
        dropActive={false}
        onLoadMore={noop}
        onRetry={noop}
        quickComposer={<div data-testid="composer-trigger" />}
      >
        {Array.from({ length: 40 }, (_, index) => (
          <li key={index} data-testid={`card-${String(index)}`}>
            Карточка {String(index)}
          </li>
        ))}
      </KanbanColumn>,
    );

    const column = screen.getByTestId("kanban-column-backlog");
    const header = column.querySelector("header");
    const composer = screen.getByTestId("kanban-quick-composer-backlog");
    const loading = screen.getByTestId("task-ui-loading");
    const scroll = screen.getByTestId("kanban-column-scroll-backlog");

    expect(header?.nextElementSibling).toBe(composer);
    expect(screen.getAllByTestId("composer-trigger")).toHaveLength(1);
    expect(
      composer.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(scroll).toContainElement(screen.getByTestId("card-39"));
    expect(scroll).not.toContainElement(composer);
  });
});
