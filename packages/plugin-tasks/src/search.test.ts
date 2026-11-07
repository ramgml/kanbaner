import { describe, expect, it } from "vitest";

import { StorageError } from "@kanbaner/plugin-sdk";

import type { Task } from "./model.ts";
import { toTaskSearchDocument } from "./search.ts";

const createdAt = "2026-01-01T00:00:00.000Z";

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  parentTaskId: "parent-1",
  title: "Подготовить релиз",
  descriptionMarkdown: "Проверить changelog и собрать пакеты",
  status: "in_progress",
  priority: "high",
  dueAt: null,
  position: 0,
  tags: ["Release", "backend"],
  version: 3,
  createdAt,
  updatedAt: createdAt,
  completedAt: null,
};

function errorCode(operation: () => unknown): string {
  try {
    operation();

    return "none";
  } catch (error) {
    return error instanceof StorageError ? error.code : "other";
  }
}

describe("toTaskSearchDocument", () => {
  it("строит документ из заголовка, описания и метаданных", () => {
    const document = toTaskSearchDocument(task);

    expect(document.ref).toBe("kanbaner.tasks:task:task-1");
    expect(document.pluginId).toBe("kanbaner.tasks");
    expect(document.kind).toBe("task");
    expect(document.title).toBe("Подготовить релиз");
    expect(document.text).toContain("Подготовить релиз");
    expect(document.text).toContain("Проверить changelog и собрать пакеты");
    expect(document.updatedAt).toBe(createdAt);
    expect(document.metadata).toMatchObject({
      projectId: "project-1",
      status: "in_progress",
      priority: "high",
      tags: ["Release", "backend"],
      parentTaskId: "parent-1",
    });
  });

  it("не добавляет пустое описание в текст", () => {
    const document = toTaskSearchDocument({
      ...task,
      descriptionMarkdown: "   ",
      parentTaskId: null,
    });

    expect(document.text).toBe(task.title);
    expect(document.metadata).not.toHaveProperty("parentTaskId");
  });

  it("отказывает для ResourceRef чужого плагина", () => {
    expect(errorCode(() => toTaskSearchDocument(task, "kanbaner.notes:task:task-1"))).toBe(
      "INVALID_PLUGIN_ID",
    );
  });

  it("отказывает для чужого типа ресурса и несовпадающего ID", () => {
    expect(errorCode(() => toTaskSearchDocument(task, "kanbaner.tasks:project:task-1"))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(errorCode(() => toTaskSearchDocument(task, "kanbaner.tasks:task:other"))).toBe(
      "INVALID_ARGUMENT",
    );
  });
});
