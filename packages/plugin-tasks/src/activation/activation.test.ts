import { describe, expect, it } from "vitest";

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
import type { Task } from "../model.ts";

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
