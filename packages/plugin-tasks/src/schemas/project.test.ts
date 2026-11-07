import { describe, expect, it } from "vitest";

import { validateWithSchema } from "@kanbaner/plugin-sdk";

import { MAX_TITLE_LENGTH } from "../constants.ts";
import {
  ProjectCreateInputSchema,
  ProjectDeleteInputSchema,
  ProjectDeleteOutputSchema,
  ProjectMutationOutputSchema,
  ProjectUpdateInputSchema,
} from "./project.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const project = {
  id: "project-1",
  title: "Проект",
  descriptionMarkdown: "Описание",
  version: 1,
  createdAt,
  updatedAt: createdAt,
};

describe("project schemas", () => {
  it("принимает минимальный и полный ввод project.create", () => {
    expect(validateWithSchema(ProjectCreateInputSchema, { title: "Проект" }).ok).toBe(true);
    expect(
      validateWithSchema(ProjectCreateInputSchema, {
        title: "Проект",
        descriptionMarkdown: "Описание",
        expectedVersion: 0,
      }).ok,
    ).toBe(true);
  });

  it("отклоняет пустой заголовок, пробелы и слишком длинный заголовок", () => {
    expect(validateWithSchema(ProjectCreateInputSchema, { title: "" }).ok).toBe(false);
    expect(validateWithSchema(ProjectCreateInputSchema, { title: "   " }).ok).toBe(false);
    expect(
      validateWithSchema(ProjectCreateInputSchema, {
        title: "a".repeat(MAX_TITLE_LENGTH + 1),
      }).ok,
    ).toBe(false);
  });

  it("не принимает expectedVersion, отличный от 0, при создании", () => {
    expect(
      validateWithSchema(ProjectCreateInputSchema, { title: "Проект", expectedVersion: 1 }).ok,
    ).toBe(false);
  });

  it("требует id и expectedVersion для project.update", () => {
    expect(
      validateWithSchema(ProjectUpdateInputSchema, {
        id: "project-1",
        expectedVersion: 1,
        title: "Новый",
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ProjectUpdateInputSchema, { id: "project-1", title: "Новый" }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ProjectUpdateInputSchema, {
        id: "project-1",
        expectedVersion: 0,
        title: "Новый",
      }).ok,
    ).toBe(false);
  });

  it("требует явное confirm для project.delete", () => {
    expect(
      validateWithSchema(ProjectDeleteInputSchema, {
        id: "project-1",
        expectedVersion: 1,
        confirm: true,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ProjectDeleteInputSchema, {
        id: "project-1",
        expectedVersion: 1,
        confirm: false,
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ProjectDeleteInputSchema, { id: "project-1", expectedVersion: 1 }).ok,
    ).toBe(false);
  });

  it("запрещает неизвестные поля", () => {
    expect(
      validateWithSchema(ProjectCreateInputSchema, { title: "Проект", status: "todo" }).ok,
    ).toBe(false);
  });

  it("проверяет выходные схемы", () => {
    expect(
      validateWithSchema(ProjectMutationOutputSchema, {
        project,
        resource: "kanbaner.tasks:project:project-1",
        eventId: "event-1",
      }).ok,
    ).toBe(true);
  });

  it("различает успешное удаление и идемпотентный no-op", () => {
    const deletedTask = {
      id: "task-1",
      projectId: "project-1",
      resourceRef: "kanbaner.tasks:task:task-1",
      version: 3,
    };
    const success = {
      deleted: true,
      resource: "kanbaner.tasks:project:project-1",
      version: 2,
      deletedResourceRefs: ["kanbaner.tasks:project:project-1", "kanbaner.tasks:task:task-1"],
      deletedTasks: [deletedTask],
      eventId: "event-2",
    };

    expect(validateWithSchema(ProjectDeleteOutputSchema, success).ok).toBe(true);
    expect(validateWithSchema(ProjectDeleteOutputSchema, { deleted: false }).ok).toBe(true);
    expect(
      validateWithSchema(ProjectDeleteOutputSchema, { ...success, eventId: undefined }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ProjectDeleteOutputSchema, { deleted: false, eventId: "event-3" }).ok,
    ).toBe(false);
    expect(validateWithSchema(ProjectDeleteOutputSchema, { ...success, version: 0 }).ok).toBe(
      false,
    );
    expect(
      validateWithSchema(ProjectDeleteOutputSchema, {
        ...success,
        deletedTasks: [{ ...deletedTask, version: 0 }],
      }).ok,
    ).toBe(false);
  });
});
