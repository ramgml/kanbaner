import { describe, expect, it } from "vitest";

import { createOperationBus } from "./bus.ts";
import {
  commandMetadata,
  identifierOutputSchema,
  looseObjectSchema,
  queryMetadata,
} from "./test-fixtures.ts";

interface Task {
  readonly id: string;
  readonly title: string;
}

const commandInputSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const queryInputSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

describe("интеграция шины с тестовым плагином", () => {
  it("регистрирует команду и запрос и выполняет сценарий создания и чтения", async () => {
    const bus = createOperationBus({ validateOutput: true });
    const tasks = new Map<string, Task>();
    let sequence = 0;

    bus.registerCommand({
      metadata: commandMetadata({
        id: "test.tasks.create",
        inputSchema: commandInputSchema,
        outputSchema: identifierOutputSchema,
      }),
      handler: (input) => {
        const { title } = input as { title: string };

        sequence += 1;

        const task: Task = { id: `task-${sequence}`, title };

        tasks.set(task.id, task);

        return { id: task.id };
      },
    });

    bus.registerQuery({
      metadata: queryMetadata({
        id: "test.tasks.get",
        inputSchema: queryInputSchema,
        outputSchema: looseObjectSchema,
      }),
      handler: (input) => {
        const { id } = input as { id: string };
        const task = tasks.get(id);

        if (task === undefined) {
          throw new Error("Внутренняя деталь не должна попасть в результат");
        }

        return task;
      },
    });

    const created = await bus.executeCommand(
      "test.tasks.create",
      { title: "Подготовить релиз" },
      { source: { type: "http", id: "api" } },
    );

    expect(created).toEqual({ ok: true, data: { id: "task-1" } });

    if (!created.ok) {
      return;
    }

    const read = await bus.executeQuery(
      "test.tasks.get",
      { id: (created.data as { id: string }).id },
      { source: { type: "http", id: "api" } },
    );

    expect(read).toEqual({
      ok: true,
      data: { id: "task-1", title: "Подготовить релиз" },
    });
  });

  it("изолирует обработку ошибок тестового плагина", async () => {
    const bus = createOperationBus();
    const tasks = new Map<string, Task>();

    bus.registerQuery({
      metadata: queryMetadata({
        id: "test.tasks.get",
        inputSchema: queryInputSchema,
        outputSchema: looseObjectSchema,
      }),
      handler: (input) => {
        const { id } = input as { id: string };
        const task = tasks.get(id);

        if (task === undefined) {
          throw new Error("Карта пуста: /internal/path");
        }

        return task;
      },
    });

    const result = await bus.executeQuery("test.tasks.get", { id: "missing" });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.message).toBe("Внутренняя ошибка операции");
    }

    expect(JSON.stringify(result)).not.toContain("/internal/path");
  });
});
