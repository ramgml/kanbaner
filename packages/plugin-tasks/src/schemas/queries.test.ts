import { describe, expect, it } from "vitest";

import { validateWithSchema } from "@kanbaner/plugin-sdk";

import { MAX_LIST_LIMIT, MAX_RAW_TAG_LENGTH } from "../constants.ts";
import {
  ProjectGetInputSchema,
  ProjectGetOutputSchema,
  ProjectListInputSchema,
  ProjectListOutputSchema,
  ProjectSummaryInputSchema,
  ProjectSummaryOutputSchema,
  TaskGetInputSchema,
  TaskGetOutputSchema,
  TaskListInputSchema,
  TaskListOutputSchema,
} from "./queries.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const project = {
  id: "project-1",
  title: "Проект",
  descriptionMarkdown: "",
  version: 1,
  createdAt,
  updatedAt: createdAt,
};

const task = {
  id: "task-1",
  projectId: "project-1",
  parentTaskId: null,
  title: "Задача",
  descriptionMarkdown: "",
  status: "todo",
  priority: "low",
  dueAt: null,
  position: 0,
  tags: [],
  version: 1,
  createdAt,
  updatedAt: createdAt,
  completedAt: null,
};

describe("query schemas", () => {
  it("принимает пустой ввод project.list и task.list", () => {
    expect(validateWithSchema(ProjectListInputSchema, {}).ok).toBe(true);
    expect(validateWithSchema(TaskListInputSchema, {}).ok).toBe(true);
  });

  it("принимает все фильтры, сортировку и пагинацию task.list", () => {
    expect(
      validateWithSchema(TaskListInputSchema, {
        projectId: "project-1",
        status: "in_progress",
        priority: "high",
        tag: "backend",
        parentTaskId: null,
        text: "релиз",
        dueBefore: createdAt,
        dueAfter: createdAt,
        sort: { field: "dueAt", direction: "desc" },
        limit: MAX_LIST_LIMIT,
        offset: 0,
      }).ok,
    ).toBe(true);
  });

  it("проверяет границы limit и offset", () => {
    expect(validateWithSchema(TaskListInputSchema, { limit: 1 }).ok).toBe(true);
    expect(validateWithSchema(TaskListInputSchema, { limit: MAX_LIST_LIMIT }).ok).toBe(true);
    expect(validateWithSchema(TaskListInputSchema, { limit: 0 }).ok).toBe(false);
    expect(validateWithSchema(TaskListInputSchema, { limit: MAX_LIST_LIMIT + 1 }).ok).toBe(false);
    expect(validateWithSchema(TaskListInputSchema, { limit: 1.5 }).ok).toBe(false);
    expect(validateWithSchema(TaskListInputSchema, { offset: -1 }).ok).toBe(false);
    expect(validateWithSchema(TaskListInputSchema, { offset: 100 }).ok).toBe(true);
  });

  it("отклоняет неизвестную сортировку", () => {
    expect(
      validateWithSchema(TaskListInputSchema, {
        sort: { field: "unknown", direction: "asc" },
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(TaskListInputSchema, {
        sort: { field: "title", direction: "sideways" },
      }).ok,
    ).toBe(false);
  });

  it("принимает сырой tag и применяет те же raw-лимиты", () => {
    expect(validateWithSchema(TaskListInputSchema, { tag: " Work " }).ok).toBe(true);
    expect(
      validateWithSchema(TaskListInputSchema, { tag: "a".repeat(MAX_RAW_TAG_LENGTH) }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskListInputSchema, { tag: "a".repeat(MAX_RAW_TAG_LENGTH + 1) }).ok,
    ).toBe(false);
    expect(validateWithSchema(TaskListInputSchema, { tag: "   " }).ok).toBe(false);
  });

  it("отклоняет пустой text и неверный dueBefore", () => {
    expect(validateWithSchema(TaskListInputSchema, { text: "   " }).ok).toBe(false);
    expect(validateWithSchema(TaskListInputSchema, { dueBefore: "2026-01-01T00:00:00" }).ok).toBe(
      false,
    );
  });

  it("проверяет project.get и task.get", () => {
    expect(validateWithSchema(ProjectGetInputSchema, { id: "project-1" }).ok).toBe(true);
    expect(validateWithSchema(ProjectGetInputSchema, { id: "" }).ok).toBe(false);
    expect(validateWithSchema(TaskGetInputSchema, { id: "task-1" }).ok).toBe(true);
    expect(
      validateWithSchema(TaskGetInputSchema, { id: "task-1", projectId: "project-1" }).ok,
    ).toBe(false);
  });

  it("проверяет выходные схемы страниц", () => {
    expect(
      validateWithSchema(ProjectListOutputSchema, {
        items: [project],
        total: 1,
        nextOffset: null,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(TaskListOutputSchema, {
        items: [task],
        total: 1,
        nextOffset: 1,
      }).ok,
    ).toBe(true);
    expect(validateWithSchema(ProjectGetOutputSchema, { project }).ok).toBe(true);
    expect(validateWithSchema(TaskGetOutputSchema, { task }).ok).toBe(true);
  });

  it("принимает ввод project.summary с проектом и пагинацией", () => {
    expect(validateWithSchema(ProjectSummaryInputSchema, {}).ok).toBe(true);
    expect(validateWithSchema(ProjectSummaryInputSchema, { projectId: "project-1" }).ok).toBe(true);
    expect(
      validateWithSchema(ProjectSummaryInputSchema, {
        projectId: "project-1",
        limit: 1,
        offset: 0,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ProjectSummaryInputSchema, {
        limit: MAX_LIST_LIMIT,
        offset: 10,
      }).ok,
    ).toBe(true);
  });

  it("отклоняет невалидный ввод project.summary", () => {
    expect(validateWithSchema(ProjectSummaryInputSchema, { projectId: "" }).ok).toBe(false);
    expect(validateWithSchema(ProjectSummaryInputSchema, { projectId: "project 1" }).ok).toBe(
      false,
    );
    expect(validateWithSchema(ProjectSummaryInputSchema, { limit: 0 }).ok).toBe(false);
    expect(validateWithSchema(ProjectSummaryInputSchema, { limit: MAX_LIST_LIMIT + 1 }).ok).toBe(
      false,
    );
    expect(validateWithSchema(ProjectSummaryInputSchema, { limit: 1.5 }).ok).toBe(false);
    expect(validateWithSchema(ProjectSummaryInputSchema, { offset: -1 }).ok).toBe(false);
    expect(
      validateWithSchema(ProjectSummaryInputSchema, { projectId: "project-1", extra: true }).ok,
    ).toBe(false);
  });

  it("проверяет выход project.summary с totals и счётчиками", () => {
    const summary = {
      project,
      total: 4,
      counts: { backlog: 1, todo: 1, in_progress: 1, done: 1 },
      overdueCount: 1,
    };
    const totals = {
      total: 4,
      counts: { backlog: 1, todo: 1, in_progress: 1, done: 1 },
      overdueCount: 1,
    };

    expect(
      validateWithSchema(ProjectSummaryOutputSchema, {
        items: [summary],
        total: 1,
        nextOffset: null,
        totals,
      }).ok,
    ).toBe(true);
    expect(
      validateWithSchema(ProjectSummaryOutputSchema, {
        items: [],
        total: 0,
        nextOffset: 1,
        totals: {
          total: 0,
          counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
          overdueCount: 0,
        },
      }).ok,
    ).toBe(true);
  });

  it("отклоняет неполный output project.summary", () => {
    const totals = {
      total: 1,
      counts: { backlog: 1, todo: 0, in_progress: 0, done: 0 },
      overdueCount: 0,
    };

    expect(
      validateWithSchema(ProjectSummaryOutputSchema, {
        items: [],
        total: 0,
        nextOffset: null,
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ProjectSummaryOutputSchema, {
        items: [],
        total: 0,
        nextOffset: null,
        totals: { total: 0, counts: { backlog: 0, todo: 0, in_progress: 0 }, overdueCount: 0 },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateWithSchema(ProjectSummaryOutputSchema, {
        items: [
          {
            project,
            total: 0,
            counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
            overdueCount: -1,
          },
        ],
        total: 1,
        nextOffset: null,
        totals,
      }).ok,
    ).toBe(false);
    expect(
      validateWithSchema(ProjectSummaryOutputSchema, {
        items: [],
        total: 0,
        nextOffset: null,
        totals,
        extra: true,
      }).ok,
    ).toBe(false);
  });
});
