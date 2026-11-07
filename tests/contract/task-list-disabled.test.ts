// @vitest-environment node

import {
  TASKS_COMMAND_IDS,
  TASKS_QUERY_IDS,
  type ProjectMutationOutput,
  type TaskListOutput,
  type TaskMutationOutput,
} from "../../packages/plugin-tasks/src/contract.ts";
import { afterEach, describe, expect, it } from "vitest";

import { startFixtureHarness, type FixtureHarness } from "./fixture-harness.ts";

/**
 * В MVP ещё нет HTTP-транспорта, поэтому «публичные operations/API» здесь —
 * это те же команды и запросы, которые выполняет UI через composition root.
 * Отключение `kanbaner.task-list` не должно затрагивать домен `kanbaner.tasks`.
 */
const TASK_LIST_PLUGIN_ID = "kanbaner.task-list";
const TASKS_PLUGIN_ID = "kanbaner.tasks";

const harnesses: FixtureHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

function unwrap<T>(
  result: { readonly ok: true; readonly data: unknown } | { readonly ok: false },
): T {
  if (!result.ok) {
    throw new Error("Операция завершилась ошибкой");
  }

  return result.data as T;
}

async function execute<T>(
  harness: FixtureHarness,
  operationId: string,
  input: unknown,
): Promise<T> {
  return unwrap<T>(await harness.composition.executeUiOperation(operationId, input as never));
}

describe("kanbaner.task-list отключён", () => {
  it("не активируется и не публикует UI-вклады", async () => {
    const harness = await startFixtureHarness({ disabledPlugins: [TASK_LIST_PLUGIN_ID] });

    harnesses.push(harness);

    const taskList = harness.snapshot.plugins.find(
      (plugin) => plugin.pluginId === TASK_LIST_PLUGIN_ID,
    );
    const tasks = harness.snapshot.plugins.find((plugin) => plugin.pluginId === TASKS_PLUGIN_ID);

    expect(taskList?.status).toBe("disabled");
    expect(taskList?.activated).toBe(false);
    expect(tasks?.status).toBe("active");
    expect(tasks?.activated).toBe(true);

    expect(
      harness.composition
        .listUiContributions()
        .filter((record) => record.pluginId === TASK_LIST_PLUGIN_ID),
    ).toEqual([]);
  });

  it("сохраняет доступ к задачам через публичные operations и completedAt", async () => {
    const harness = await startFixtureHarness({ disabledPlugins: [TASK_LIST_PLUGIN_ID] });

    harnesses.push(harness);

    const project = await execute<ProjectMutationOutput>(harness, TASKS_COMMAND_IDS.projectCreate, {
      title: "Проект без списка",
    });
    const created = await execute<TaskMutationOutput>(harness, TASKS_COMMAND_IDS.taskCreate, {
      projectId: project.project.id,
      title: "Задача без списка",
      status: "todo",
      priority: "high",
      dueAt: "2030-01-10T00:00:00.000Z",
      tags: ["release", "backend"],
    });

    expect(created.task.completedAt).toBeNull();

    const filtered = await execute<TaskListOutput>(harness, TASKS_QUERY_IDS.taskList, {
      status: "todo",
      tag: "release",
      dueAfter: "2030-01-01T00:00:00.000Z",
      dueBefore: "2030-02-01T00:00:00.000Z",
    });

    expect(filtered.items.map((task) => task.id)).toEqual([created.task.id]);

    const completed = await execute<TaskMutationOutput>(harness, TASKS_COMMAND_IDS.taskComplete, {
      id: created.task.id,
      expectedVersion: created.task.version,
    });

    expect(completed.task.status).toBe("done");
    expect(completed.task.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

    const done = await execute<TaskListOutput>(harness, TASKS_QUERY_IDS.taskList, {
      status: "done",
      tag: "release",
    });

    expect(done.items.map((task) => task.id)).toEqual([created.task.id]);
    expect(done.items[0]?.completedAt).toBe(completed.task.completedAt);
  });
});
