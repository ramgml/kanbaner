import { describe, expect, it } from "vitest";

import { changedColumnFields, changedProjectFields, isSameColorOnlyPatch } from "../activation.ts";
import { TasksNotFoundError, TasksVersionConflictError } from "../store/index.ts";
import { TasksValidationError } from "../validation.ts";
import { mapTasksError } from "./errors.ts";
import {
  canonicalJson,
  hashIdempotencyInput,
  idempotencyRecordId,
  sha256Hex,
} from "./idempotency.ts";
import { shiftedNeighbors } from "./snapshots.ts";
import type { Project, Task, TaskColumn } from "../model.ts";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    projectId: "project-1",
    parentTaskId: null,
    title: "Задача",
    descriptionMarkdown: "",
    status: "todo",
    priority: "medium",
    dueAt: null,
    position: 0,
    tags: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  } as Task;
}

describe("activation: чистые помощники", () => {
  it("канонизирует JSON независимо от порядка ключей", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(hashIdempotencyInput({ b: 1, a: 2 })).toBe(hashIdempotencyInput({ a: 2, b: 1 }));
    expect(hashIdempotencyInput({ a: 1 })).not.toBe(hashIdempotencyInput({ a: 2 }));
  });

  it("строит стабильный SHA-256 ID записи из operationId и ключа", () => {
    const id = idempotencyRecordId("kanbaner.tasks.project.create", "ключ");

    expect(id).toBe(idempotencyRecordId("kanbaner.tasks.project.create", "ключ"));
    expect(id).not.toBe(idempotencyRecordId("kanbaner.tasks.project.update", "ключ"));
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("находит только фактически сдвинутых соседей и не дублирует основную задачу", () => {
    const before = new Map<string, Task>([
      ["a", task({ id: "a", position: 0, version: 1 })],
      ["b", task({ id: "b", position: 1, version: 1 })],
      ["c", task({ id: "c", position: 2, version: 1 })],
    ]);
    const after = new Map<string, Task>([
      ["a", task({ id: "a", position: 0, version: 1 })],
      ["b", task({ id: "b", position: 2, version: 2 })],
      ["c", task({ id: "c", position: 3, version: 2 })],
      ["new", task({ id: "new", position: 1, version: 1 })],
    ]);

    expect(shiftedNeighbors(before, after, "new").map((item) => item.id)).toEqual(["b", "c"]);
    expect(shiftedNeighbors(before, after, "b").map((item) => item.id)).toEqual(["c"]);
  });

  it("вычисляет changed-поля цвета стабильно для событий проекта и колонки", () => {
    const project: Project = {
      id: "project-1",
      title: "Проект",
      descriptionMarkdown: "",
      color: "blue",
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const column: TaskColumn = {
      id: "column-1",
      projectId: project.id,
      title: "Review",
      status: "in_progress",
      color: "blue",
      position: 1,
      version: 2,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };

    expect(changedProjectFields(project, { ...project, color: "green" })).toEqual(["color"]);
    expect(changedProjectFields(project, { ...project, title: "Новый" })).toEqual(["title"]);
    expect(changedProjectFields(project, project)).toEqual([]);
    expect(changedColumnFields(column, { ...column, color: "green" })).toEqual(["color"]);
    expect(changedColumnFields(column, { ...column, title: "Code Review" })).toEqual(["title"]);
    expect(
      changedColumnFields(column, { ...column, title: "Code Review", color: "green" }),
    ).toEqual(["title", "color"]);
    expect(changedColumnFields(column, column)).toEqual([]);
  });

  it("распознаёт color-only no-op и сохраняет семантику title-only update", () => {
    const current = { color: "blue" as const };

    expect(isSameColorOnlyPatch({ color: "blue" }, current)).toBe(true);
    expect(isSameColorOnlyPatch({ color: "green" }, current)).toBe(false);
    expect(isSameColorOnlyPatch({ color: "blue", title: "Review" }, current)).toBe(false);
    expect(isSameColorOnlyPatch({ title: "Review" }, current)).toBe(false);
    expect(isSameColorOnlyPatch({ color: "blue", descriptionMarkdown: "Описание" }, current)).toBe(
      false,
    );
    expect(isSameColorOnlyPatch({ color: "blue" }, { color: undefined })).toBe(false);
  });

  it("маппит доменные ошибки в стабильные коды Plugin Contract", () => {
    expect(mapTasksError(new TasksVersionConflictError(3, 4))).toEqual({
      code: "VERSION_CONFLICT",
      message: "Сущность была изменена другой операцией",
      details: { expectedVersion: 3, actualVersion: 4 },
    });
    expect(mapTasksError(new TasksNotFoundError("task", "task-1"))).toEqual({
      code: "NOT_FOUND",
      message: "Задача не найдена",
      details: { entity: "task", id: "task-1" },
    });
    expect(mapTasksError(new TasksValidationError("INVALID_TITLE", "Плохой заголовок"))).toEqual({
      code: "VALIDATION_ERROR",
      message: "Плохой заголовок",
      details: { reason: "INVALID_TITLE" },
    });
    expect(mapTasksError(new Error("boom"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "Внутренняя ошибка операции",
    });
  });
});
