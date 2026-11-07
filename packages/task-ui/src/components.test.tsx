import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, Task } from "@kanbaner/plugin-tasks/contract";

import { TaskCard } from "./components/task-card.tsx";
import { TaskDetails } from "./components/task-details.tsx";
import { TaskFilters, EMPTY_TASK_FILTERS } from "./components/task-filters.tsx";
import { ProjectForm, TaskForm } from "./components/task-form.tsx";
import { TaskTable } from "./components/task-table.tsx";
import { EmptyState, ErrorState, LoadingState } from "./components/states.tsx";

const project: Project = {
  id: "project-1",
  title: "Проект один",
  descriptionMarkdown: "",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const otherProject: Project = {
  ...project,
  id: "project-2",
  title: "Проект два",
};

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  parentTaskId: null,
  title: "Подготовить релиз",
  descriptionMarkdown: "Описание задачи",
  priority: "high",
  dueAt: "2026-02-03T00:00:00.000Z",
  position: 0,
  tags: ["release", "backend"],
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  status: "todo",
  completedAt: null,
};

const secondTask: Task = {
  ...task,
  id: "task-2",
  title: "Другая задача",
  projectId: "project-2",
  dueAt: null,
  tags: [],
  status: "done",
  completedAt: "2026-01-03T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
});

describe("TaskTable и TaskCard", () => {
  it("показывает desktop-таблицу с требуемыми колонками и mobile-карточки", () => {
    render(
      <TaskTable
        tasks={[task, secondTask]}
        projects={[project, otherProject]}
        onSelect={() => undefined}
      />,
    );

    const table = screen.getByTestId("task-table");

    expect(table).toHaveTextContent("Название");
    expect(table).toHaveTextContent("Проект");
    expect(table).toHaveTextContent("Статус");
    expect(table).toHaveTextContent("Приоритет");
    expect(table).toHaveTextContent("Срок");
    expect(table).toHaveTextContent("Теги");
    expect(table).toHaveTextContent("Проект один");
    expect(table).toHaveTextContent("release");

    expect(screen.getByTestId("task-cards")).toBeInTheDocument();
    expect(screen.getByTestId("task-card-task-1")).toHaveTextContent("Подготовить релиз");
    expect(screen.getByTestId("task-card-task-2")).toHaveTextContent("Без срока");
  });

  it("открывает задачу кнопкой названия и помечает выбранную строку", () => {
    const onSelect = vi.fn();

    render(
      <TaskTable
        tasks={[task]}
        projects={[project]}
        selectedTaskId={task.id}
        onSelect={onSelect}
      />,
    );

    const titleButton = screen.getByRole("button", { name: "Открыть задачу Подготовить релиз" });

    expect(titleButton).toHaveClass("focus-visible:ring-2");
    titleButton.focus();
    expect(titleButton).toHaveFocus();
    fireEvent.click(titleButton);
    expect(onSelect).toHaveBeenCalledWith(task);
    expect(screen.getByTestId("task-row-task-1")).toHaveAttribute("aria-selected", "true");
  });

  it("использует семантическую кнопку в карточке и сообщает выбранное состояние", () => {
    const onSelect = vi.fn();

    render(<TaskCard task={task} project={project} selected onSelect={onSelect} />);

    const card = screen.getByTestId("task-card-task-1");
    const button = screen.getByRole("button", {
      name: "Открыть карточку задачи Подготовить релиз",
    });

    expect(card).toHaveAttribute("aria-current", "true");
    expect(button).toHaveAttribute("type", "button");
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith(task);
  });
});

describe("TaskFilters", () => {
  it("передаёт изменения фильтров и сбрасывает их", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();

    render(
      <TaskFilters
        projects={[project, otherProject]}
        values={EMPTY_TASK_FILTERS}
        onChange={onChange}
        onReset={onReset}
      />,
    );

    expect(screen.getByRole("form", { name: "Фильтры задач" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Проект"), { target: { value: "project-1" } });
    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "in_progress" } });
    fireEvent.change(screen.getByLabelText("Приоритет"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Тег"), { target: { value: " Release " } });
    fireEvent.change(screen.getByLabelText("Срок с"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("Срок по"), { target: { value: "2026-02-28" } });

    expect(onChange).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(onChange).toHaveBeenCalledWith({ status: "in_progress" });
    expect(onChange).toHaveBeenCalledWith({ priority: "high" });
    expect(onChange).toHaveBeenCalledWith({ tag: " Release " });
    expect(onChange).toHaveBeenCalledWith({ dueAfter: "2026-02-01" });
    expect(onChange).toHaveBeenCalledWith({ dueBefore: "2026-02-28" });

    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("TaskForm", () => {
  it("создаёт значения формы и предлагает только корневые задачи проекта", () => {
    const onSubmit = vi.fn();

    render(
      <TaskForm
        mode="create"
        projects={[project, otherProject]}
        rootTasks={[task]}
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />,
    );

    const parentSelect = screen.getByLabelText("Родительская задача");

    expect(parentSelect).toHaveTextContent("Подготовить релиз");

    fireEvent.change(screen.getByLabelText("Проект"), { target: { value: "project-1" } });
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "  Новая задача  " } });
    fireEvent.change(screen.getByLabelText("Приоритет"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "in_progress" } });
    fireEvent.change(screen.getByLabelText("Срок"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Теги через запятую"), {
      target: { value: " release, backend " },
    });
    fireEvent.change(parentSelect, { target: { value: "task-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        title: "Новая задача",
        priority: "high",
        status: "in_progress",
        dueAt: "2026-03-01",
        tags: "release, backend",
        parentTaskId: "task-1",
      }),
    );
  });

  it("показывает доступную ошибку при пустом названии", () => {
    const onSubmit = vi.fn();

    render(
      <TaskForm
        mode="create"
        projects={[project]}
        rootTasks={[]}
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />,
    );

    fireEvent.submit(screen.getByTestId("task-form-create"));

    expect(screen.getByRole("alert")).toHaveTextContent("Укажите название задачи");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("в режиме edit показывает родителя только для чтения", () => {
    render(
      <TaskForm
        mode="edit"
        projects={[project]}
        rootTasks={[]}
        initial={{ title: "Задача", parentTaskId: "" }}
        lockParent
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.queryByLabelText("Родительская задача")).not.toBeInTheDocument();
    expect(screen.getByText("Без родителя (корневая)")).toBeInTheDocument();
  });
});

describe("ProjectForm", () => {
  it("валидирует название проекта", () => {
    const onSubmit = vi.fn();

    render(<ProjectForm onSubmit={onSubmit} onCancel={() => undefined} />);

    fireEvent.submit(screen.getByTestId("project-form"));
    expect(screen.getByRole("alert")).toHaveTextContent("Укажите название проекта");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Название проекта"), {
      target: { value: "Проект" },
    });
    fireEvent.submit(screen.getByTestId("project-form"));
    expect(onSubmit).toHaveBeenCalledWith({ title: "Проект", descriptionMarkdown: "" });
  });
});

describe("TaskDetails", () => {
  it("требует явного inline-подтверждения удаления", () => {
    const onDelete = vi.fn();

    render(
      <TaskDetails
        task={task}
        project={project}
        parentTask={null}
        onClose={() => undefined}
        onEdit={() => undefined}
        onComplete={() => undefined}
        onMove={() => undefined}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId("task-delete"));

    expect(screen.getByTestId("task-delete-confirm-panel")).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("task-delete-cancel"));
    expect(screen.queryByTestId("task-delete-confirm-panel")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("task-delete"));
    fireEvent.click(screen.getByTestId("task-delete-confirm"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("доступно закрывает детали и перемещает задачу", () => {
    const onClose = vi.fn();
    const onMove = vi.fn();

    render(
      <TaskDetails
        task={task}
        project={project}
        parentTask={null}
        onClose={onClose}
        onEdit={() => undefined}
        onComplete={() => undefined}
        onMove={onMove}
        onDelete={() => undefined}
      />,
    );

    const close = screen.getByRole("button", { name: "Закрыть детали" });
    close.focus();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Переместить в"), {
      target: { value: "in_progress" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Переместить" }));
    expect(onMove).toHaveBeenCalledWith("in_progress");
  });

  it("показывает ошибку операции role=alert", () => {
    render(
      <TaskDetails
        task={task}
        project={project}
        parentTask={null}
        error="Конфликт версий"
        onClose={() => undefined}
        onEdit={() => undefined}
        onComplete={() => undefined}
        onMove={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(screen.getByTestId("task-details-error")).toHaveTextContent("Конфликт версий");
  });
});

describe("состояния загрузки, пустоты и ошибки", () => {
  it("объявляет загрузку и ошибку для скринридера", () => {
    const onRetry = vi.fn();

    render(
      <div>
        <LoadingState />
        <EmptyState title="Пусто" description="Нет задач" />
        <ErrorState message="Ошибка" onRetry={onRetry} />
      </div>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Загрузка");
    expect(screen.getByText("Пусто")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Ошибка");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
