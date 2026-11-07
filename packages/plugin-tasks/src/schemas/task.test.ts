import { describe, expect, it } from "vitest";

import { validateWithSchema } from "@kanbaner/plugin-sdk";

import { MAX_TAGS } from "../constants.ts";
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

  it("ограничивает количество и длину тегов", () => {
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: uniqueTags(MAX_TAGS + 1),
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskCreateInputSchema, {
        projectId: "project-1",
        title: "Задача",
        tags: ["a".repeat(33)],
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
      validateWithSchema(TaskDeleteOutputSchema, {
        deleted: true,
        deletedTaskIds: ["task-1", "task-2"],
        resource: "kanbaner.tasks:task:task-1",
        eventId: "event-2",
      }).ok,
    ).toBe(true);
  });

  it("принимает done с заполненным completedAt", () => {
    const doneTask = {
      ...task,
      status: "done",
      completedAt: createdAt,
    };

    expect(
      validateWithSchema(TaskMutationOutputSchema, {
        task: doneTask,
        resource: "kanbaner.tasks:task:task-1",
        eventId: "event-1",
      }).ok,
    ).toBe(true);
  });
});
