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
    expect(
      validateWithSchema(ProjectDeleteOutputSchema, {
        deleted: true,
        deletedTaskIds: ["task-1", "task-2"],
        resource: "kanbaner.tasks:project:project-1",
        eventId: "event-2",
      }).ok,
    ).toBe(true);
  });
});
