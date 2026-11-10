import { describe, expect, it } from "vitest";

import { validateWithSchema } from "@kanbaner/plugin-sdk";

import { MAX_TITLE_LENGTH } from "../constants.ts";
import {
  ColumnCreateInputSchema,
  ColumnDeleteInputSchema,
  ColumnDeleteOutputSchema,
  ColumnMoveInputSchema,
  ColumnMutationOutputSchema,
  ColumnUpdateInputSchema,
} from "./column.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const column = {
  id: "column-1",
  projectId: "project-1",
  title: "Review",
  status: "in_progress",
  position: 1,
  version: 1,
  createdAt,
  updatedAt: createdAt,
};

const task = {
  id: "task-1",
  projectId: "project-1",
  parentTaskId: null,
  columnId: "column-1",
  title: "Задача",
  descriptionMarkdown: "",
  status: "in_progress",
  priority: "medium",
  dueAt: null,
  position: 0,
  tags: [],
  version: 2,
  createdAt,
  updatedAt: createdAt,
  completedAt: null,
};

describe("column schemas", () => {
  it("принимает минимальный и полный ввод column.create", () => {
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "Review",
        type: "open",
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "Done 2",
        type: "done",
        position: 4,
        expectedVersion: 0,
      }).ok,
    ).toBe(true);
  });

  it("проверяет тип колонки, title, position и expectedVersion", () => {
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "Review",
        type: "review",
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "",
        type: "open",
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "a".repeat(MAX_TITLE_LENGTH + 1),
        type: "open",
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "Review",
        type: "open",
        position: -1,
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "Review",
        type: "open",
        expectedVersion: 1,
      }).ok,
    ).toBe(false);
  });

  it("требует id и expectedVersion для column.update и column.move", () => {
    expect(
      validateWithSchema(ColumnUpdateInputSchema, {
        id: "column-1",
        expectedVersion: 1,
        title: "Новая",
      }).ok,
    ).toBe(true);
    expect(validateWithSchema(ColumnUpdateInputSchema, { id: "column-1", title: "Новая" }).ok).toBe(
      false,
    );
    expect(
      validateWithSchema(ColumnMoveInputSchema, {
        id: "column-1",
        expectedVersion: 1,
        position: 0,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ColumnMoveInputSchema, {
        id: "column-1",
        expectedVersion: 1,
        position: -1,
      }).ok,
    ).toBe(false);
  });

  it("требует confirm и targetColumnId для column.delete", () => {
    expect(
      validateWithSchema(ColumnDeleteInputSchema, {
        id: "column-1",
        expectedVersion: 1,
        confirm: true,
        targetColumnId: "column-2",
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ColumnDeleteInputSchema, {
        id: "column-1",
        expectedVersion: 1,
        confirm: false,
        targetColumnId: "column-2",
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ColumnDeleteInputSchema, {
        id: "column-1",
        expectedVersion: 1,
        confirm: true,
      }).ok,
    ).toBe(false);
  });

  it("запрещает неизвестные поля", () => {
    expect(
      validateWithSchema(ColumnCreateInputSchema, {
        projectId: "project-1",
        title: "Review",
        type: "open",
        status: "todo",
      }).ok,
    ).toBe(false);
  });

  it("проверяет выход column.create/update/move", () => {
    expect(
      validateWithSchema(ColumnMutationOutputSchema, {
        column,
        resource: "kanbaner.tasks:task-column:column-1",
        eventId: "event-1",
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ColumnMutationOutputSchema, {
        column: { ...column, version: 0 },
        resource: "kanbaner.tasks:task-column:column-1",
        eventId: "event-1",
      }).ok,
    ).toBe(false);
  });

  it("различает успешное удаление с переносом и no-op", () => {
    const success = {
      deleted: true,
      resource: "kanbaner.tasks:task-column:column-1",
      version: 3,
      eventVersion: 4,
      targetColumnId: "column-2",
      movedTasks: [task],
      eventId: "event-2",
    };

    expect(validateWithSchema(ColumnDeleteOutputSchema, success).ok).toBe(true);
    expect(validateWithSchema(ColumnDeleteOutputSchema, { deleted: false }).ok).toBe(true);
    expect(
      validateWithSchema(ColumnDeleteOutputSchema, { deleted: false, eventId: "event-3" }).ok,
    ).toBe(false);
    expect(validateWithSchema(ColumnDeleteOutputSchema, { ...success, version: 0 }).ok).toBe(false);
    expect(validateWithSchema(ColumnDeleteOutputSchema, { ...success, eventVersion: 1 }).ok).toBe(
      false,
    );
    // columnId опционален для legacy-задач, но пустой title недопустим.
    const legacyTask: Record<string, unknown> = { ...task };

    delete legacyTask["columnId"];

    expect(
      validateWithSchema(ColumnDeleteOutputSchema, {
        ...success,
        movedTasks: [legacyTask],
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ColumnDeleteOutputSchema, {
        ...success,
        movedTasks: [{ ...task, title: "" }],
      }).ok,
    ).toBe(false);
  });
});
