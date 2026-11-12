import { describe, expect, it } from "vitest";

import {
  isEventType,
  resolveExposure,
  validateCommandMetadata,
  validateQueryMetadata,
} from "@kanbaner/plugin-sdk";

import {
  COLUMN_EVENT_TYPES,
  TASK_EVENT_TYPES,
  TASKS_COMMAND_IDS,
  TASKS_COMMANDS_CONTRACT,
  TASKS_EVENT_TYPES,
  TASKS_QUERIES_CONTRACT,
  TASKS_QUERY_IDS,
  TASKS_STORE_CONTRACT,
  PROJECT_EVENT_TYPES,
} from "./constants.ts";
import { isTasksEventType } from "./events.ts";
import { TASKS_COMMAND_LIST, TASKS_QUERY_LIST } from "./operations.ts";
import { TASKS_STORE_CONTRACT_DEFINITION } from "./store.ts";

describe("operation metadata", () => {
  it("регистрирует все команды с валидными метаданными", () => {
    expect(TASKS_COMMAND_LIST).toHaveLength(Object.keys(TASKS_COMMAND_IDS).length);

    for (const metadata of TASKS_COMMAND_LIST) {
      expect(validateCommandMetadata(metadata).ok).toBe(true);
      expect(metadata.contract).toBe(TASKS_COMMANDS_CONTRACT);
      expect(metadata.version).toBe(1);
      expect(metadata.kind).toBe("mutation");
      expect(resolveExposure(metadata.exposure)).toEqual({
        ui: false,
        http: false,
        mcp: false,
      });
    }
  });

  it("регистрирует все запросы с валидными метаданными", () => {
    expect(TASKS_QUERY_LIST).toHaveLength(Object.keys(TASKS_QUERY_IDS).length);

    for (const metadata of TASKS_QUERY_LIST) {
      expect(validateQueryMetadata(metadata).ok).toBe(true);
      expect(metadata.contract).toBe(TASKS_QUERIES_CONTRACT);
      expect(metadata.risk).toBe("read");
      expect(resolveExposure(metadata.exposure)).toEqual({
        ui: false,
        http: false,
        mcp: false,
      });
    }
  });

  it("помечает удаление проекта и задачи как destructive", () => {
    const destructive = TASKS_COMMAND_LIST.filter(
      (metadata) => metadata.risk === "destructive",
    ).map((metadata) => metadata.id);

    expect(destructive).toEqual([
      TASKS_COMMAND_IDS.projectDelete,
      TASKS_COMMAND_IDS.columnDelete,
      TASKS_COMMAND_IDS.taskDelete,
      TASKS_COMMAND_IDS.taskDeleteMany,
    ]);
  });

  it("не переиспользует ID операций", () => {
    const ids = [...Object.values(TASKS_COMMAND_IDS), ...Object.values(TASKS_QUERY_IDS)];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("фиксирует версию Store-контракта", () => {
    expect(TASKS_STORE_CONTRACT_DEFINITION).toEqual({ id: TASKS_STORE_CONTRACT, version: 1 });
  });
});

describe("event types", () => {
  it("все типы событий валидны по контракту SDK", () => {
    for (const eventType of TASKS_EVENT_TYPES) {
      expect(isEventType(eventType)).toBe(true);
      expect(isTasksEventType(eventType)).toBe(true);
    }
    expect(Object.values(PROJECT_EVENT_TYPES)).toHaveLength(3);
    expect(Object.values(COLUMN_EVENT_TYPES)).toHaveLength(4);
    expect(Object.values(TASK_EVENT_TYPES)).toHaveLength(5);
  });

  it("не принимает чужие события", () => {
    expect(isTasksEventType("kanbaner.notes.note.updated")).toBe(false);
    expect(isTasksEventType("kanbaner.tasks.task.unknown")).toBe(false);
  });
});
