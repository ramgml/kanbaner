import { describe, expect, it } from "vitest";

import { validateWithSchema } from "@kanbaner/plugin-sdk";

import { MAX_RAW_TAG_LENGTH, MAX_RAW_TAGS, MAX_TAGS } from "../constants.ts";
import {
  TaskCompleteInputSchema,
  TaskCreateInputSchema,
  TaskDeleteInputSchema,
  TaskDeleteOutputSchema,
  TaskMoveInputSchema,
  TaskMutationOutputSchema,
  TaskUpdateInputSchema,
} from "./task.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const task = {
  id: "task-1",
  projectId: "project-1",
  parentTaskId: null,
  title: "Задача",
  descriptionMarkdown: "Описание",
  status: "todo",
  priority: "medium",
  dueAt: null,
  position: 0,
  tags: ["backend"],
  version: 1,
  createdAt,
  updatedAt: createdAt,
  completedAt: null,
};

function uniqueTags(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `tag-${String(index)}`);
}

describe("task schemas", () => {
  it("принимает минимальный и полный ввод task.create", () => {
    expect(
      validateWithSchema(TaskCreateInputSchema, { projectId: "project-1", title: "Задача" }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        parentTaskId: null,
        title: "Задача",
        descriptionMarkdown: "Описание",
        status: "done",
        priority: "high",
        dueAt: createdAt,
        position: 3,
        tags: ["Backend", "backend"],
        expectedVersion: 0,
      }).ok,
    ).toBe(true);
  });

  it("отклоняет неверные статус и приоритет", () => {
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        status: "blocked",
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        priority: "urgent",
      }).ok,
    ).toBe(false);
  });

  it("отклоняет пустой заголовок и отрицательную позицию", () => {
    expect(
      validateWithSchema(TaskCreateInputSchema, { projectId: "project-1", title: "   " }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        position: -1,
      }).ok,
    ).toBe(false);
  });

  it("принимает сырые теги и применяет лимиты после нормализации", () => {
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: uniqueTags(MAX_TAGS + 1),
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: Array.from({ length: MAX_RAW_TAGS }, () => " Work "),
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: ["a".repeat(MAX_RAW_TAG_LENGTH)],
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: uniqueTags(MAX_RAW_TAGS + 1),
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: ["a".repeat(MAX_RAW_TAG_LENGTH + 1)],
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: ["   "],
      }).ok,
    ).toBe(false);
  });

  it("применяет те же сырые лимиты к task.update", () => {
    expect(
      validateWithSchema(TaskUpdateInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        tags: Array.from({ length: MAX_RAW_TAGS }, () => " Work "),
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskUpdateInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        tags: uniqueTags(MAX_RAW_TAGS + 1),
      }).ok,
    ).toBe(false);
  });

  it("требует корректный UTC dueAt", () => {
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        dueAt: "2026-01-01T00:00:00+03:00",
      }).ok,
    ).toBe(false);
  });

  it("проверяет task.update", () => {
    expect(
      validateWithSchema(TaskUpdateInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        title: "Новая",
        tags: ["ui"],
      }).ok,
    ).toBe(true);
    expect(validateWithSchema(TaskUpdateInputSchema, { id: "task-1", title: "Новая" }).ok).toBe(
      false,
    );
  });

  it("проверяет task.move", () => {
    expect(
      validateWithSchema(TaskMoveInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        status: "in_progress",
        position: 0,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskMoveInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        status: "blocked",
        position: 0,
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskMoveInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        status: "todo",
        position: -2,
      }).ok,
    ).toBe(false);
  });

  it("проверяет task.complete", () => {
    expect(
      validateWithSchema(TaskCompleteInputSchema, { id: "task-1", expectedVersion: 1 }).ok,
    ).toBe(true);
    expect(validateWithSchema(TaskCompleteInputSchema, { id: "task-1" }).ok).toBe(false);
  });

  it("требует confirm для task.delete", () => {
    expect(
      validateWithSchema(TaskDeleteInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        confirm: true,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskDeleteInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        confirm: false,
      }).ok,
    ).toBe(false);
  });

  it("проверяет выходные схемы", () => {
    expect(
      validateWithSchema(TaskMutationOutputSchema, {
        task,
        resource: "kanbaner.tasks:task:task-1",
        eventId: "event-1",
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskMutationOutputSchema, {
        task: { ...task, tags: uniqueTags(MAX_TAGS + 1) },
        resource: "kanbaner.tasks:task:task-1",
        eventId: "event-1",
      }).ok,
    ).toBe(false);
  });

  it("отклоняет дубликаты и внешние пробелы в нормализованных тегах", () => {
    const output = (tags: string[]) =>
      validateWithSchema(TaskMutationOutputSchema, {
        task: { ...task, tags },
        resource: "kanbaner.tasks:task:task-1",
        eventId: "event-1",
      });

    expect(output(["work"]).ok).toBe(true);
    expect(output(["work", "work"]).ok).toBe(false);
    expect(output([" work"]).ok).toBe(false);
    expect(output(["work "]).ok).toBe(false);
  });

  it("требует done ⇔ completedAt !== null", () => {
    const output = (candidate: unknown) => ({
      task: candidate,
      resource: "kanbaner.tasks:task:task-1",
      eventId: "event-1",
    });

    expect(
      validateWithSchema(
        TaskMutationOutputSchema,
        output({ ...task, status: "done", completedAt: createdAt }),
      ).ok,
    ).toBe(true);
    expect(
      validateWithSchema(
        TaskMutationOutputSchema,
        output({ ...task, status: "done", completedAt: null }),
      ).ok,
    ).toBe(false);
    expect(
      validateWithSchema(
        TaskMutationOutputSchema,
        output({ ...task, status: "todo", completedAt: createdAt }),
      ).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskMutationOutputSchema, output({ ...task, status: "backlog" })).ok,
    ).toBe(true);
    expect(
      validateWithSchema(
        TaskMutationOutputSchema,
        output({ ...task, status: "in_progress", completedAt: null }),
      ).ok,
    ).toBe(true);
  });

  it("различает успешное удаление и идемпотентный no-op", () => {
    const deletedTask = {
      id: "task-1",
      projectId: "project-1",
      resourceRef: "kanbaner.tasks:task:task-1",
      version: 4,
      eventVersion: 5,
    };
    const success = {
      deleted: true,
      resource: "kanbaner.tasks:task:task-1",
      version: 4,
      eventVersion: 5,
      deletedResourceRefs: ["kanbaner.tasks:task:task-1", "kanbaner.tasks:task:task-2"],
      deletedTasks: [
        deletedTask,
        {
          ...deletedTask,
          id: "task-2",
          resourceRef: "kanbaner.tasks:task:task-2",
          version: 7,
          eventVersion: 8,
        },
      ],
      eventId: "event-2",
    };

    expect(validateWithSchema(TaskDeleteOutputSchema, success).ok).toBe(true);
    expect(validateWithSchema(TaskDeleteOutputSchema, { deleted: false }).ok).toBe(true);
    expect(validateWithSchema(TaskDeleteOutputSchema, { ...success, eventId: undefined }).ok).toBe(
      false,
    );
    expect(
      validateWithSchema(TaskDeleteOutputSchema, { deleted: false, eventId: "event-3" }).ok,
    ).toBe(false);
    expect(validateWithSchema(TaskDeleteOutputSchema, { ...success, version: 0 }).ok).toBe(false);
    expect(validateWithSchema(TaskDeleteOutputSchema, { ...success, eventVersion: 1 }).ok).toBe(
      false,
    );
    expect(
      validateWithSchema(TaskDeleteOutputSchema, {
        ...success,
        deletedTasks: [{ ...deletedTask, eventVersion: 1 }],
      }).ok,
    ).toBe(false);
  });

  it("принимает optional columnId в task.create и task.move", () => {
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        columnId: "column-1",
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskMoveInputSchema, {
        id: "task-1",
        expectedVersion: 1,
        columnId: "column-1",
        position: 0,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        columnId: 42,
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskMutationOutputSchema, {
        task: { ...task, columnId: "column-1" },
        resource: "kanbaner.tasks:task:task-1",
        eventId: "event-1",
      }).ok,
    ).toBe(true);
  });
});
