import assert from "node:assert/strict";

import type { JsonValue, UtcTimestamp } from "@kanbaner/plugin-sdk";

import {
  COLUMN_COLLECTION,
  MAX_POSITION,
  PLUGIN_ID,
  PROJECT_COLLECTION,
  TASK_COLLECTION,
} from "./constants.ts";
import {
  deleteEventVersion,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "./model.ts";
import type { BoardColor } from "./schemas/board-color.ts";
import {
  TasksNestedTransactionError,
  type CreateTaskStoreInput,
  type TasksStore,
} from "./store.ts";
import { TasksValidationError } from "./validation.ts";

/**
 * Контекст одного conformance case.
 *
 * ID и время детерминированы, поэтому suite не зависит от backend и часов.
 */
export interface TasksStoreConformanceContext {
  /** ID проекта или задачи в формате application-generated. */
  nextId(kind: "project" | "task" | "column"): string;
  /** UTC timestamp со смещением в секундах от фиксированной базы. */
  at(offsetSeconds: number): UtcTimestamp;
}

/** Один переиспользуемый случай conformance. */
export interface TasksStoreConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

/** Параметры набора: фабрика Store создаёт независимый экземпляр на case. */
export interface TasksStoreConformanceOptions {
  createStore(): TasksStore | Promise<TasksStore>;
}

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function createContext(): TasksStoreConformanceContext {
  let projectSequence = 0;
  let taskSequence = 0;
  let columnSequence = 0;

  return {
    nextId(kind) {
      if (kind === "project") {
        projectSequence += 1;

        return `project-${String(projectSequence)}`;
      }

      if (kind === "column") {
        columnSequence += 1;

        return `column-${String(columnSequence)}`;
      }

      taskSequence += 1;

      return `task-${String(taskSequence)}`;
    },
    at(offsetSeconds) {
      return new Date(BASE_TIME + offsetSeconds * 1_000).toISOString();
    },
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { readonly code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

async function rejectsCode(
  operation: Promise<unknown>,
  code: string,
  message: string,
): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    assert.equal(errorCode(error), code, `${message}: ожидался код ${code}`);

    return error;
  }

  assert.fail(`${message}: операция не завершилась ошибкой ${code}`);
}

async function rejectsVersionConflict(
  operation: Promise<unknown>,
  expectedVersion: number,
  actualVersion: number,
  message: string,
): Promise<void> {
  const error = await rejectsCode(operation, "VERSION_CONFLICT", message);

  assert.equal(
    (error as { readonly expectedVersion?: unknown }).expectedVersion,
    expectedVersion,
    `${message}: expectedVersion`,
  );
  assert.equal(
    (error as { readonly actualVersion?: unknown }).actualVersion,
    actualVersion,
    `${message}: actualVersion`,
  );
}

async function createProject(
  store: TasksStore,
  context: TasksStoreConformanceContext,
  options: {
    readonly title?: string;
    readonly color?: BoardColor;
    readonly createdAtOffset?: number;
    readonly id?: string;
  } = {},
): Promise<Project> {
  return store.createProject({
    id: options.id ?? context.nextId("project"),
    title: options.title ?? "Project",
    descriptionMarkdown: "",
    ...(options.color === undefined ? {} : { color: options.color }),
    createdAt: context.at(options.createdAtOffset ?? 0),
    expectedVersion: 0,
  });
}

interface TaskSeed {
  readonly projectId: string;
  readonly columnId?: string;
  readonly parentTaskId?: string | null;
  readonly title?: string;
  readonly descriptionMarkdown?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly dueAt?: UtcTimestamp | null;
  readonly position?: number;
  readonly tags?: readonly string[];
  readonly createdAtOffset?: number;
  readonly id?: string;
}

async function createTask(
  store: TasksStore,
  context: TasksStoreConformanceContext,
  seed: TaskSeed,
): Promise<Task> {
  const input: CreateTaskStoreInput = {
    id: seed.id ?? context.nextId("task"),
    projectId: seed.projectId,
    parentTaskId: seed.parentTaskId ?? null,
    title: seed.title ?? "Task",
    descriptionMarkdown: seed.descriptionMarkdown ?? "",
    ...(seed.columnId === undefined ? {} : { columnId: seed.columnId }),
    ...(seed.status === undefined
      ? seed.columnId === undefined
        ? { status: "todo" as const }
        : {}
      : { status: seed.status }),
    priority: seed.priority ?? "medium",
    dueAt: seed.dueAt ?? null,
    ...(seed.position === undefined ? {} : { position: seed.position }),
    tags: seed.tags ?? [],
    createdAt: context.at(seed.createdAtOffset ?? 0),
    expectedVersion: 0,
  };

  return store.createTask(input);
}

async function listScope(
  store: TasksStore,
  projectId: string,
  status: TaskStatus,
): Promise<readonly Task[]> {
  const page = await store.listTasks({ projectId, status, limit: 200, offset: 0 });

  return page.items;
}

async function listColumnScope(
  store: TasksStore,
  projectId: string,
  columnId: string,
): Promise<readonly Task[]> {
  const page = await store.listTasks({ projectId, columnId, limit: 200, offset: 0 });

  return page.items;
}

/**
 * Создаёт проект и задачи в legacy-формате: без документов колонок и без
 * `task.columnId`, как в базе до появления пользовательских колонок.
 */
async function createLegacyProject(
  store: TasksStore,
  context: TasksStoreConformanceContext,
): Promise<Project> {
  const project = await createProject(store, context, { title: "Legacy" });
  const statuses: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "done"];
  const createdAt = context.at(0);

  await store.withTransaction(async (transaction) => {
    const columns = await transaction.listColumns({
      projectId: project.id,
      limit: 200,
      offset: 0,
    });

    for (const column of columns.items) {
      await transaction.documents.delete(PLUGIN_ID, COLUMN_COLLECTION, column.id);
    }

    for (const [index, status] of statuses.entries()) {
      await transaction.documents.put({
        pluginId: PLUGIN_ID,
        collection: TASK_COLLECTION,
        id: `legacy-task-${project.id}-${status}`,
        data: {
          id: `legacy-task-${project.id}-${status}`,
          projectId: project.id,
          parentTaskId: null,
          title: `Legacy ${status}`,
          descriptionMarkdown: "",
          status,
          priority: "medium",
          dueAt: null,
          position: index,
          tags: [],
          version: 1,
          createdAt,
          updatedAt: createdAt,
          completedAt: status === "done" ? createdAt : null,
        },
        indexedFields: { projectId: project.id, status },
        expectedVersion: 0,
      });
    }
  });

  return project;
}

function positionsOf(tasks: readonly Task[]): readonly number[] {
  return tasks.map((task) => task.position);
}

function assertContiguous(positions: readonly number[], message: string): void {
  const sorted = [...positions].sort((left, right) => left - right);

  assert.deepEqual(
    sorted,
    Array.from({ length: positions.length }, (_value, index) => index),
    `${message}: позиции должны быть уникальны и непрерывны`,
  );
}

async function rejectsInvalidTags(operation: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectsCode(operation, "TAG_EMPTY", message);

  assert.equal(error instanceof TasksValidationError, true, `${message}: TasksValidationError`);
}

/**
 * Выполняет complete с повтором после VERSION_CONFLICT.
 *
 * Сдвиг соседей — обычное изменение их версии, поэтому параллельная операция
 * над другой задачей может легально получить конфликт. Повтор читает
 * актуальную версию; потерянных и дублированных задач быть не должно.
 */
async function completeWithRetry(
  store: TasksStore,
  context: TasksStoreConformanceContext,
  taskId: string,
): Promise<Task> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const current = await store.getTask(taskId);

    if (current === null) {
      throw new Error(`Задача ${taskId} исчезла во время complete`);
    }

    if (current.status === "done") {
      return current;
    }

    try {
      return await store.completeTask({
        id: taskId,
        expectedVersion: current.version,
        updatedAt: context.at(1),
      });
    } catch (error) {
      if (errorCode(error) !== "VERSION_CONFLICT") {
        throw error;
      }
    }
  }

  throw new Error(`Не удалось завершить задачу ${taskId} за 1000 попыток`);
}

/** Выполняет move с повтором после VERSION_CONFLICT. */
async function moveWithRetry(
  store: TasksStore,
  context: TasksStoreConformanceContext,
  taskId: string,
  status: TaskStatus,
  position: number,
): Promise<Task> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const current = await store.getTask(taskId);

    if (current === null) {
      throw new Error(`Задача ${taskId} исчезла во время move`);
    }

    if (current.status === status) {
      return current;
    }

    try {
      return await store.moveTask({
        id: taskId,
        expectedVersion: current.version,
        status,
        position,
        updatedAt: context.at(1),
      });
    } catch (error) {
      if (errorCode(error) !== "VERSION_CONFLICT") {
        throw error;
      }
    }
  }

  throw new Error(`Не удалось переместить задачу ${taskId} за 1000 попыток`);
}

/**
 * Создаёт переиспользуемый набор conformance-проверок `TasksStore`.
 *
 * Suite не импортирует kernel, Storage Provider, SQLite или драйвер БД:
 * backend передаётся только через фабрику Store. Драйверы четырёх
 * provider-вариантов находятся в `tests/integration`.
 */
export function createTasksStoreConformanceSuite(
  options: TasksStoreConformanceOptions,
): readonly TasksStoreConformanceCase[] {
  const withStore = async (run: (store: TasksStore) => Promise<void>): Promise<void> => {
    const store = await options.createStore();

    await run(store);
  };

  return [
    {
      name: "project: create, get и список с порядком createdAt/id",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const later = await createProject(store, context, {
            title: "Later",
            color: "blue",
            createdAtOffset: 10,
          });
          const earlier = await createProject(store, context, {
            title: "Earlier",
            createdAtOffset: 5,
          });

          assert.equal(later.version, 1);
          assert.equal(later.color, "blue");
          assert.equal(later.createdAt, context.at(10));
          assert.equal(later.updatedAt, context.at(10));
          assert.equal(earlier.color, undefined);
          assert.deepEqual(await store.getProject(later.id), later);
          assert.deepEqual(await store.getProject(earlier.id), earlier);

          const page = await store.listProjects({ limit: 10, offset: 0 });

          assert.equal(page.total, 2);
          assert.deepEqual(
            page.items.map((project) => project.id),
            [earlier.id, later.id],
          );
          assert.equal(page.nextOffset, null);
        });
      },
    },
    {
      name: "project: update и delete соблюдают expectedVersion",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const updated = await store.updateProject({
            id: project.id,
            expectedVersion: 1,
            title: "Updated",
            updatedAt: context.at(1),
          });

          assert.equal(updated.version, 2);
          assert.equal(updated.title, "Updated");
          assert.equal(updated.color, undefined);

          // Color-only update не меняет заголовок и повышает версию.
          const recolored = await store.updateProject({
            id: project.id,
            expectedVersion: 2,
            color: "green",
            updatedAt: context.at(2),
          });

          assert.equal(recolored.title, "Updated");
          assert.equal(recolored.color, "green");
          assert.equal(recolored.version, 3);

          // Color-only update с тем же цветом — no-op: версия и updatedAt
          // остаются прежними.
          const reasserted = await store.updateProject({
            id: project.id,
            expectedVersion: 3,
            color: "green",
            updatedAt: context.at(3),
          });

          assert.equal(reasserted.version, 3);
          assert.equal(reasserted.updatedAt, recolored.updatedAt);
          assert.equal(reasserted.color, "green");

          await rejectsVersionConflict(
            store.updateProject({
              id: project.id,
              expectedVersion: 1,
              title: "Stale",
              updatedAt: context.at(3),
            }),
            1,
            3,
            "устаревший update проекта",
          );
          await rejectsVersionConflict(
            store.deleteProject({ id: project.id, expectedVersion: 1 }),
            1,
            3,
            "устаревший delete проекта",
          );

          const reread = await store.getProject(project.id);

          assert.equal(reread?.title, "Updated");
          assert.equal(reread?.color, "green");
          assert.equal(reread?.version, 3);
        });
      },
    },
    {
      name: "project: list пагинируется без дублей",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const created: string[] = [];

          for (let index = 0; index < 5; index += 1) {
            const project = await createProject(store, context, { createdAtOffset: index });
            created.push(project.id);
          }

          const seen: string[] = [];
          const offsets: Array<number | null> = [];
          let offset = 0;

          for (;;) {
            const page = await store.listProjects({ limit: 2, offset });

            assert.equal(page.total, 5);
            seen.push(...page.items.map((project) => project.id));
            offsets.push(page.nextOffset);

            if (page.nextOffset === null) {
              break;
            }

            offset = page.nextOffset;
          }

          assert.deepEqual(seen, created);
          assert.deepEqual(offsets, [2, 4, null]);
        });
      },
    },
    {
      name: "project: delete каскадно удаляет задачи и возвращает ссылки",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const otherProject = await createProject(store, context, { title: "Other" });
          const first = await createTask(store, context, { projectId: project.id });
          const second = await createTask(store, context, { projectId: project.id });
          const child = await createTask(store, context, {
            projectId: project.id,
            parentTaskId: first.id,
          });
          const survivor = await createTask(store, context, { projectId: otherProject.id });

          const result = await store.deleteProject({
            id: project.id,
            expectedVersion: 1,
          });

          assert.equal(result.deleted, true);

          if (!result.deleted) {
            return;
          }

          assert.equal(result.version, 1);
          assert.equal(result.eventVersion, deleteEventVersion(1));
          assert.equal(result.deletedTasks.length, 3);
          assert.deepEqual(
            new Set(result.deletedTasks.map((descriptor) => descriptor.id)),
            new Set([first.id, second.id, child.id]),
          );

          for (const descriptor of result.deletedTasks) {
            assert.equal(descriptor.projectId, project.id);
            assert.equal(descriptor.eventVersion, deleteEventVersion(descriptor.version));
          }

          assert.equal(
            result.deletedResourceRefs.includes(`kanbaner.tasks:project:${project.id}`),
            true,
          );
          assert.equal(
            result.deletedResourceRefs.includes(`kanbaner.tasks:task:${child.id}`),
            true,
          );

          assert.equal(await store.getProject(project.id), null);
          assert.equal(await store.getTask(first.id), null);
          assert.equal(await store.getTask(child.id), null);
          assert.notEqual(await store.getTask(survivor.id), null);
          assert.deepEqual(await store.deleteProject({ id: project.id, expectedVersion: 1 }), {
            deleted: false,
          });
        });
      },
    },
    {
      name: "task: append уникален в области projectId/columnId и не зависит от parent",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const first = await createTask(store, context, { projectId: project.id });
          const second = await createTask(store, context, { projectId: project.id });
          const third = await createTask(store, context, { projectId: project.id });
          const child = await createTask(store, context, {
            projectId: project.id,
            parentTaskId: first.id,
          });
          const inProgress = await createTask(store, context, {
            projectId: project.id,
            status: "in_progress",
          });

          const todo = await listScope(store, project.id, "todo");

          assert.deepEqual(
            todo.map((task) => task.id),
            [first.id, second.id, third.id, child.id],
          );
          assert.deepEqual(positionsOf(todo), [0, 1, 2, 3]);
          assert.equal(inProgress.position, 0);
          assert.deepEqual(positionsOf(await listScope(store, project.id, "in_progress")), [0]);
        });
      },
    },
    {
      name: "task: явная позиция вставляет и сдвигает соседей",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const first = await createTask(store, context, { projectId: project.id, title: "A" });
          const second = await createTask(store, context, { projectId: project.id, title: "B" });
          const third = await createTask(store, context, { projectId: project.id, title: "C" });
          const inserted = await createTask(store, context, {
            projectId: project.id,
            title: "X",
            position: 1,
            createdAtOffset: 1,
          });

          const afterInsert = await listScope(store, project.id, "todo");
          const shiftedSecond = afterInsert.find((task) => task.id === second.id);
          const shiftedThird = afterInsert.find((task) => task.id === third.id);

          assert.deepEqual(
            afterInsert.map((task) => task.id),
            [first.id, inserted.id, second.id, third.id],
          );
          assert.deepEqual(positionsOf(afterInsert), [0, 1, 2, 3]);
          assert.equal(shiftedSecond?.version, 2);
          assert.equal(shiftedSecond?.updatedAt, context.at(1));
          assert.equal(shiftedThird?.version, 2);
          assert.equal(shiftedThird?.updatedAt, context.at(1));

          await rejectsVersionConflict(
            store.updateTask({
              id: second.id,
              expectedVersion: 1,
              title: "Stale after shift",
              updatedAt: context.at(2),
            }),
            1,
            2,
            "устаревший update соседа после insert",
          );
          assert.equal((await store.getTask(second.id))?.title, "B");

          const appended = await createTask(store, context, {
            projectId: project.id,
            title: "Y",
            position: 999,
            createdAtOffset: 2,
          });
          const afterAppend = await listScope(store, project.id, "todo");

          assert.equal(afterAppend.at(-1)?.id, appended.id);
          assert.deepEqual(positionsOf(afterAppend), [0, 1, 2, 3, 4]);
        });
      },
    },
    {
      name: "task: move внутри и между статусами сохраняет уникальный порядок",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const first = await createTask(store, context, { projectId: project.id, title: "A" });
          const second = await createTask(store, context, { projectId: project.id, title: "B" });
          const third = await createTask(store, context, { projectId: project.id, title: "C" });

          const movedThird = await store.moveTask({
            id: third.id,
            expectedVersion: 1,
            status: "todo",
            position: 0,
            updatedAt: context.at(1),
          });

          assert.equal(movedThird.version, 2);
          assert.deepEqual(
            (await listScope(store, project.id, "todo")).map((task) => task.id),
            [third.id, first.id, second.id],
          );

          const afterFirstMove = await listScope(store, project.id, "todo");

          assert.equal(afterFirstMove.find((task) => task.id === first.id)?.version, 2);
          assert.equal(afterFirstMove.find((task) => task.id === second.id)?.version, 2);
          assert.equal(
            afterFirstMove.find((task) => task.id === second.id)?.updatedAt,
            context.at(1),
          );

          await rejectsVersionConflict(
            store.updateTask({
              id: second.id,
              expectedVersion: 1,
              title: "Stale after move",
              updatedAt: context.at(2),
            }),
            1,
            2,
            "устаревший update соседа после move",
          );

          await store.moveTask({
            id: first.id,
            expectedVersion: 2,
            status: "in_progress",
            position: 0,
            updatedAt: context.at(2),
          });
          await store.moveTask({
            id: second.id,
            expectedVersion: 3,
            status: "in_progress",
            position: 1,
            updatedAt: context.at(3),
          });

          const todo = await listScope(store, project.id, "todo");
          const inProgress = await listScope(store, project.id, "in_progress");

          assert.deepEqual(
            todo.map((task) => task.id),
            [third.id],
          );
          assert.deepEqual(
            inProgress.map((task) => task.id),
            [first.id, second.id],
          );
          assertContiguous(positionsOf(todo), "todo");
          assertContiguous(positionsOf(inProgress), "in_progress");
        });
      },
    },
    {
      name: "task: delete закрывает разрыв и идемпотентен",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const first = await createTask(store, context, { projectId: project.id, title: "A" });
          const second = await createTask(store, context, { projectId: project.id, title: "B" });
          const third = await createTask(store, context, { projectId: project.id, title: "C" });

          const result = await store.deleteTask({ id: second.id, expectedVersion: 1 });

          assert.equal(result.deleted, true);

          if (!result.deleted) {
            return;
          }

          assert.equal(result.version, 1);
          assert.equal(result.eventVersion, 2);
          assert.deepEqual(
            result.deletedTasks.map((descriptor) => descriptor.id),
            [second.id],
          );
          assert.equal(await store.getTask(second.id), null);
          const remaining = await listScope(store, project.id, "todo");

          assert.deepEqual(
            remaining.map((task) => task.id),
            [first.id, third.id],
          );
          assert.deepEqual(positionsOf(remaining), [0, 1]);
          assert.equal(remaining.find((task) => task.id === first.id)?.version, 1);
          assert.equal(remaining.find((task) => task.id === third.id)?.version, 2);

          await rejectsVersionConflict(
            store.updateTask({
              id: third.id,
              expectedVersion: 1,
              title: "Stale after delete",
              updatedAt: context.at(1),
            }),
            1,
            2,
            "устаревший update соседа после delete",
          );
          assert.equal((await store.getTask(third.id))?.title, "C");

          assert.deepEqual(await store.deleteTask({ id: second.id, expectedVersion: 1 }), {
            deleted: false,
          });
        });
      },
    },
    {
      name: "task: complete, повторный complete и выход из done соблюдают completedAt",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const first = await createTask(store, context, { projectId: project.id, title: "A" });
          const second = await createTask(store, context, { projectId: project.id, title: "B" });

          const completedFirst = await store.completeTask({
            id: first.id,
            expectedVersion: 1,
            updatedAt: context.at(5),
          });

          assert.equal(completedFirst.status, "done");
          assert.equal(completedFirst.version, 2);
          assert.equal(completedFirst.completedAt, context.at(5));
          assert.equal(completedFirst.position, 0);

          const afterCompleteFirst = await listScope(store, project.id, "todo");

          assert.equal(afterCompleteFirst.find((task) => task.id === second.id)?.version, 2);
          assert.equal(
            afterCompleteFirst.find((task) => task.id === second.id)?.updatedAt,
            context.at(5),
          );

          const repeated = await store.completeTask({
            id: first.id,
            expectedVersion: 2,
            position: 10,
            updatedAt: context.at(6),
          });

          assert.equal(repeated.version, 2);
          assert.equal(repeated.completedAt, context.at(5));
          assert.equal(repeated.position, 0);

          const completedSecond = await store.completeTask({
            id: second.id,
            expectedVersion: 2,
            position: 0,
            updatedAt: context.at(7),
          });

          assert.equal(completedSecond.position, 0);
          assert.equal(completedSecond.version, 3);

          const afterCompleteSecond = await listScope(store, project.id, "done");

          assert.deepEqual(
            afterCompleteSecond.map((task) => task.id),
            [second.id, first.id],
          );
          assert.equal(afterCompleteSecond.find((task) => task.id === first.id)?.version, 3);
          assert.equal(
            afterCompleteSecond.find((task) => task.id === first.id)?.updatedAt,
            context.at(7),
          );

          const reopened = await store.moveTask({
            id: first.id,
            expectedVersion: 3,
            status: "todo",
            position: 0,
            updatedAt: context.at(8),
          });

          assert.equal(reopened.completedAt, null);
          assert.equal(reopened.status, "todo");

          const recompleted = await store.moveTask({
            id: first.id,
            expectedVersion: 4,
            status: "done",
            position: 0,
            updatedAt: context.at(9),
          });

          assert.equal(recompleted.completedAt, context.at(9));
          assert.equal(recompleted.version, 5);

          const createdDone = await createTask(store, context, {
            projectId: project.id,
            status: "done",
            createdAtOffset: 10,
          });

          assert.equal(createdDone.completedAt, context.at(10));
        });
      },
    },
    {
      name: "task: подзадачи ограничены одним уровнем и одним проектом",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const otherProject = await createProject(store, context, { title: "Other" });
          const parent = await createTask(store, context, { projectId: project.id });
          const child = await createTask(store, context, {
            projectId: project.id,
            parentTaskId: parent.id,
          });

          assert.equal(child.parentTaskId, parent.id);

          const depthError = await rejectsCode(
            createTask(store, context, {
              projectId: project.id,
              parentTaskId: child.id,
            }),
            "SUBTASK_DEPTH_EXCEEDED",
            "подзадача второго уровня",
          );
          assert.equal(depthError instanceof TasksValidationError, true);

          const projectError = await rejectsCode(
            createTask(store, context, {
              projectId: project.id,
              parentTaskId: (await createTask(store, context, { projectId: otherProject.id })).id,
            }),
            "PARENT_IN_OTHER_PROJECT",
            "родитель из другого проекта",
          );
          assert.equal(projectError instanceof TasksValidationError, true);

          await rejectsCode(
            createTask(store, context, {
              projectId: project.id,
              parentTaskId: "missing-parent",
            }),
            "PARENT_NOT_FOUND",
            "отсутствующий родитель",
          );
        });
      },
    },
    {
      name: "task: delete удаляет подзадачи и возвращает независимые версии",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const root = await createTask(store, context, { projectId: project.id, title: "Root" });
          const firstChild = await createTask(store, context, {
            projectId: project.id,
            parentTaskId: root.id,
            title: "Child A",
          });
          const secondChild = await createTask(store, context, {
            projectId: project.id,
            parentTaskId: root.id,
            title: "Child B",
          });
          const survivor = await createTask(store, context, {
            projectId: project.id,
            title: "Survivor",
          });

          await store.updateTask({
            id: firstChild.id,
            expectedVersion: 1,
            title: "Child A updated",
            updatedAt: context.at(1),
          });

          const result = await store.deleteTask({ id: root.id, expectedVersion: 1 });

          assert.equal(result.deleted, true);

          if (!result.deleted) {
            return;
          }

          assert.equal(result.version, 1);
          assert.equal(result.eventVersion, 2);
          assert.deepEqual(
            new Set(result.deletedTasks.map((descriptor) => descriptor.id)),
            new Set([root.id, firstChild.id, secondChild.id]),
          );
          assert.equal(result.deletedTasks[0]?.id, root.id);
          assert.equal(
            result.deletedTasks.find((descriptor) => descriptor.id === firstChild.id)?.version,
            2,
          );
          assert.equal(await store.getTask(root.id), null);
          assert.equal(await store.getTask(firstChild.id), null);
          assert.equal(await store.getTask(secondChild.id), null);

          const remaining = await listScope(store, project.id, "todo");

          assert.equal(remaining[0]?.id, survivor.id);
          assert.equal(remaining[0]?.version, 2);
          assert.deepEqual(positionsOf(remaining), [0]);

          await rejectsVersionConflict(
            store.updateTask({
              id: survivor.id,
              expectedVersion: 1,
              title: "Stale survivor",
              updatedAt: context.at(2),
            }),
            1,
            2,
            "устаревший update соседа после каскадного delete",
          );
        });
      },
    },
    {
      name: "task: CAS защищает update, move, complete и delete",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const task = await createTask(store, context, { projectId: project.id });
          const updated = await store.updateTask({
            id: task.id,
            expectedVersion: 1,
            title: "Updated",
            updatedAt: context.at(1),
          });

          assert.equal(updated.version, 2);

          await rejectsVersionConflict(
            store.updateTask({
              id: task.id,
              expectedVersion: 1,
              title: "Stale",
              updatedAt: context.at(2),
            }),
            1,
            2,
            "устаревший update задачи",
          );
          await rejectsVersionConflict(
            store.moveTask({
              id: task.id,
              expectedVersion: 1,
              status: "done",
              position: 0,
              updatedAt: context.at(2),
            }),
            1,
            2,
            "устаревший move задачи",
          );
          await rejectsVersionConflict(
            store.completeTask({
              id: task.id,
              expectedVersion: 1,
              updatedAt: context.at(2),
            }),
            1,
            2,
            "устаревший complete задачи",
          );
          await rejectsVersionConflict(
            store.deleteTask({ id: task.id, expectedVersion: 1 }),
            1,
            2,
            "устаревший delete задачи",
          );

          const reread = await store.getTask(task.id);

          assert.equal(reread?.title, "Updated");
          assert.equal(reread?.status, "todo");
          assert.equal(reread?.version, 2);
          assert.equal((await store.deleteTask({ id: task.id, expectedVersion: 2 })).deleted, true);
        });
      },
    },
    {
      name: "task: создание с существующим ID возвращает VERSION_CONFLICT",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const task = await createTask(store, context, {
            projectId: project.id,
            id: "duplicate-task",
            title: "Original",
          });

          await rejectsVersionConflict(
            createTask(store, context, {
              projectId: project.id,
              id: "duplicate-task",
              title: "Duplicate",
            }),
            0,
            1,
            "создание с существующим ID",
          );

          assert.equal((await store.getTask(task.id))?.title, "Original");
        });
      },
    },
    {
      name: "task: теги нормализуются при создании, изменении и фильтрации",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const task = await createTask(store, context, {
            projectId: project.id,
            tags: [" Work ", "WORK", "URGENT"],
          });

          assert.deepEqual(task.tags, ["work", "urgent"]);

          const updated = await store.updateTask({
            id: task.id,
            expectedVersion: 1,
            tags: ["  Дом  ", "дом", "UI"],
            updatedAt: context.at(1),
          });

          assert.deepEqual(updated.tags, ["дом", "ui"]);

          const filtered = await store.listTasks({
            projectId: project.id,
            tag: " WORK ",
            limit: 10,
            offset: 0,
          });

          assert.equal(filtered.total, 0);

          const other = await createTask(store, context, {
            projectId: project.id,
            tags: ["Work"],
          });
          const byTag = await store.listTasks({
            projectId: project.id,
            tag: "  WORK  ",
            limit: 10,
            offset: 0,
          });

          assert.deepEqual(
            byTag.items.map((item) => item.id),
            [other.id],
          );

          await rejectsInvalidTags(
            createTask(store, context, { projectId: project.id, tags: ["   "] }),
            "пустой тег",
          );
        });
      },
    },
    {
      name: "listTasks: комбинирует точные фильтры, текст и диапазон dueAt",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const firstProject = await createProject(store, context);
          const secondProject = await createProject(store, context, { title: "Second" });
          const first = await createTask(store, context, {
            projectId: firstProject.id,
            title: "Alpha",
            descriptionMarkdown: "First task",
            priority: "high",
            tags: ["work"],
            dueAt: context.at(10),
          });
          const second = await createTask(store, context, {
            projectId: firstProject.id,
            title: "Beta",
            status: "in_progress",
            priority: "low",
            tags: ["home"],
          });
          const child = await createTask(store, context, {
            projectId: firstProject.id,
            title: "Child",
            parentTaskId: first.id,
            dueAt: context.at(5),
          });
          const other = await createTask(store, context, {
            projectId: secondProject.id,
            title: "Gamma",
            priority: "high",
            tags: ["work"],
            dueAt: context.at(15),
          });

          assert.deepEqual(
            (
              await store.listTasks({
                projectId: firstProject.id,
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id, second.id, child.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                status: "todo",
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id, other.id, child.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                priority: "high",
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id, other.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                tag: " WORK ",
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id, other.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                projectId: firstProject.id,
                parentTaskId: null,
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id, second.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                parentTaskId: first.id,
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [child.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                text: "ALPHA",
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                text: "first",
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                dueAfter: context.at(5),
                dueBefore: context.at(10),
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id, child.id],
          );

          assert.deepEqual(
            (
              await store.listTasks({
                projectId: firstProject.id,
                status: "todo",
                priority: "high",
                tag: "WORK",
                limit: 20,
                offset: 0,
              })
            ).items.map((task) => task.id),
            [first.id],
          );
        });
      },
    },
    {
      name: "listTasks: сортировка, null dueAt и пагинация без дублей",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const created: Task[] = [];

          for (let index = 0; index < 6; index += 1) {
            created.push(
              await createTask(store, context, {
                projectId: project.id,
                title: `Task ${String(index)}`,
                createdAtOffset: 0,
              }),
            );
          }

          const seen: string[] = [];
          const offsets: Array<number | null> = [];
          let offset = 0;

          for (;;) {
            const page = await store.listTasks({
              projectId: project.id,
              sort: { field: "createdAt", direction: "desc" },
              limit: 2,
              offset,
            });

            assert.equal(page.total, 6);
            seen.push(...page.items.map((task) => task.id));
            offsets.push(page.nextOffset);

            if (page.nextOffset === null) {
              break;
            }

            offset = page.nextOffset;
          }

          assert.deepEqual(
            seen,
            created.map((task) => task.id),
          );
          assert.deepEqual(offsets, [2, 4, null]);

          const byPositionDesc = await store.listTasks({
            projectId: project.id,
            sort: { field: "position", direction: "desc" },
            limit: 20,
            offset: 0,
          });

          assert.deepEqual(
            byPositionDesc.items.map((task) => task.id),
            [...created].reverse().map((task) => task.id),
          );

          const dueProject = await createProject(store, context, { title: "Due" });
          const dueFirst = await createTask(store, context, {
            projectId: dueProject.id,
            dueAt: context.at(10),
            createdAtOffset: 1,
          });
          const dueSecond = await createTask(store, context, {
            projectId: dueProject.id,
            dueAt: context.at(20),
            createdAtOffset: 2,
          });
          const noDue = await createTask(store, context, {
            projectId: dueProject.id,
            createdAtOffset: 3,
          });

          const ascending = await store.listTasks({
            projectId: dueProject.id,
            sort: { field: "dueAt", direction: "asc" },
            limit: 20,
            offset: 0,
          });
          const descending = await store.listTasks({
            projectId: dueProject.id,
            sort: { field: "dueAt", direction: "desc" },
            limit: 20,
            offset: 0,
          });

          assert.deepEqual(
            ascending.items.map((task) => task.id),
            [dueFirst.id, dueSecond.id, noDue.id],
          );
          assert.deepEqual(
            descending.items.map((task) => task.id),
            [dueSecond.id, dueFirst.id, noDue.id],
          );
        });
      },
    },
    {
      name: "listTasks: title сортируется по code points и лимит ограничен 1..200",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const lower = await createTask(store, context, {
            projectId: project.id,
            title: "a",
          });
          const upper = await createTask(store, context, {
            projectId: project.id,
            title: "B",
          });
          const umlaut = await createTask(store, context, {
            projectId: project.id,
            title: "ä",
          });

          const page = await store.listTasks({
            projectId: project.id,
            sort: { field: "title", direction: "asc" },
            limit: 20,
            offset: 0,
          });

          assert.deepEqual(
            page.items.map((task) => task.id),
            [upper.id, lower.id, umlaut.id],
          );

          await rejectsCode(
            store.listTasks({ projectId: project.id, limit: 0, offset: 0 }),
            "INVALID_LIMIT",
            "limit = 0",
          );
          await rejectsCode(
            store.listTasks({ projectId: project.id, limit: 201, offset: 0 }),
            "INVALID_LIMIT",
            "limit = 201",
          );
        });
      },
    },
    {
      name: "store: сохраняет application-generated ID и UTC timestamp без сдвига",
      async run() {
        await withStore(async (store) => {
          const timestamp = "2026-05-05T05:05:05.123456Z";
          const project = await store.createProject({
            id: "custom-project-id",
            title: "Custom",
            descriptionMarkdown: "UTC",
            createdAt: timestamp,
            expectedVersion: 0,
          });
          const task = await store.createTask({
            id: "custom-task-id",
            projectId: project.id,
            parentTaskId: null,
            title: "Custom task",
            descriptionMarkdown: "",
            status: "todo",
            priority: "medium",
            dueAt: null,
            tags: [],
            createdAt: timestamp,
            expectedVersion: 0,
          });

          assert.equal(project.id, "custom-project-id");
          assert.equal(project.createdAt, timestamp);
          assert.equal(project.updatedAt, timestamp);
          assert.equal(task.id, "custom-task-id");
          assert.equal(task.createdAt, timestamp);
          assert.equal(task.updatedAt, timestamp);

          const tasks = await store.listTasks({
            projectId: project.id,
            limit: 10,
            offset: 0,
          });

          assert.equal(tasks.items[0]?.createdAt, timestamp);
        });
      },
    },
    {
      name: "transactions: rejected Promise откатывает scoped-изменения",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const projectId = "rolled-back-project";

          await assert.rejects(
            store.withTransaction(async (transaction) => {
              await transaction.createProject({
                id: projectId,
                title: "Rollback",
                descriptionMarkdown: "",
                createdAt: context.at(0),
                expectedVersion: 0,
              });

              const inside = await transaction.getProject(projectId);

              assert.notEqual(inside, null);
              throw new Error("rollback");
            }),
            /rollback/u,
          );

          assert.equal(await store.getProject(projectId), null);
        });
      },
    },
    {
      name: "transactions: scoped documents принадлежат той же транзакции",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const projectId = "scoped-project";
          const markerId = "scoped-marker";
          const rolledBackMarkerId = "rolled-back-marker";

          await store.withTransaction(async (transaction) => {
            const project = await transaction.createProject({
              id: projectId,
              title: "Scoped",
              descriptionMarkdown: "",
              createdAt: context.at(0),
              expectedVersion: 0,
            });
            const document = await transaction.documents.get(
              PLUGIN_ID,
              PROJECT_COLLECTION,
              project.id,
            );

            assert.notEqual(document, null);
            assert.equal(document?.version, 1);
            assert.deepEqual(document?.data, project);

            const marker = await transaction.documents.put({
              pluginId: PLUGIN_ID,
              collection: "conformance",
              id: markerId,
              data: { kind: "marker" },
              expectedVersion: 0,
            });

            assert.equal(marker.version, 1);

            return project.id;
          });

          assert.notEqual(await store.getProject(projectId), null);

          await store
            .withTransaction(async (transaction) => {
              const marker = await transaction.documents.get(PLUGIN_ID, "conformance", markerId);

              assert.notEqual(marker, null);

              await transaction.documents.put({
                pluginId: PLUGIN_ID,
                collection: "conformance",
                id: rolledBackMarkerId,
                data: { kind: "rollback" },
                expectedVersion: 0,
              });
              throw new Error("rollback marker");
            })
            .catch((error: unknown) => {
              assert.equal(error instanceof Error, true);
            });

          await store.withTransaction(async (transaction) => {
            assert.equal(
              await transaction.documents.get(PLUGIN_ID, "conformance", rolledBackMarkerId),
              null,
            );
          });
        });
      },
    },
    {
      name: "transactions: вложенный withTransaction возвращает NESTED_TRANSACTION",
      async run() {
        await withStore(async (store) => {
          const error = await rejectsCode(
            store.withTransaction(async (transaction) =>
              transaction.withTransaction(async () => 1),
            ),
            "NESTED_TRANSACTION",
            "вложенная транзакция",
          );

          assert.equal(error instanceof TasksNestedTransactionError, true);
        });
      },
    },
    {
      name: "scoped concurrency: Promise.all append даёт уникальные позиции",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);

          const created = await store.withTransaction(async (transaction) => {
            const tasks = await Promise.all(
              Array.from({ length: 10 }, () =>
                createTask(transaction, context, { projectId: project.id }),
              ),
            );
            const page = await transaction.listTasks({
              projectId: project.id,
              status: "todo",
              limit: 200,
              offset: 0,
            });

            assert.equal(page.total, 10);
            assertContiguous(positionsOf(page.items), "scoped append внутри транзакции");

            return tasks;
          });

          const committed = await listScope(store, project.id, "todo");

          assert.equal(committed.length, 10);
          assert.deepEqual(
            new Set(committed.map((task) => task.id)),
            new Set(created.map((task) => task.id)),
          );
          assertContiguous(positionsOf(committed), "scoped append после коммита");
        });
      },
    },
    {
      name: "scoped concurrency: одинаковый ID даёт один успех и VERSION_CONFLICT",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);

          const results = await store.withTransaction(async (transaction) => {
            const duplicateId = "scoped-duplicate-task";

            return Promise.allSettled([
              createTask(transaction, context, {
                projectId: project.id,
                id: duplicateId,
                title: "First",
              }),
              createTask(transaction, context, {
                projectId: project.id,
                id: duplicateId,
                title: "Second",
              }),
            ]);
          });

          const fulfilled = results.filter((result) => result.status === "fulfilled");
          const rejected = results.filter((result) => result.status === "rejected");

          assert.equal(fulfilled.length, 1);
          assert.equal(rejected.length, 1);

          const reason = rejected[0]?.reason;

          assert.equal(errorCode(reason), "VERSION_CONFLICT");
          assert.equal((reason as { readonly actualVersion?: unknown }).actualVersion, 1);
          assert.equal((await listScope(store, project.id, "todo")).length, 1);
        });
      },
    },
    {
      name: "scoped concurrency: чтение не видит промежуточное состояние мутации",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);

          await store.withTransaction(async (transaction) => {
            const taskId = context.nextId("task");
            const createPromise = createTask(transaction, context, {
              projectId: project.id,
              id: taskId,
              title: "Atomic",
              position: 0,
              createdAtOffset: 1,
            });
            const listPromise = transaction.listTasks({
              projectId: project.id,
              status: "todo",
              limit: 200,
              offset: 0,
            });
            const getPromise = transaction.getTask(taskId);
            const [created, page, read] = await Promise.all([
              createPromise,
              listPromise,
              getPromise,
            ]);

            assert.equal(read?.id, created.id);
            assert.equal(page.total, 1);
            assert.deepEqual(
              page.items.map((task) => task.id),
              [created.id],
            );
            assertContiguous(positionsOf(page.items), "scoped read после create");
          });
        });
      },
    },
    {
      name: "store: расхождение data.version и версии документа — доменная ошибка",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);

          await store.withTransaction(async (transaction) => {
            const task = await createTask(transaction, context, { projectId: project.id });

            await transaction.documents.put({
              pluginId: PLUGIN_ID,
              collection: TASK_COLLECTION,
              id: "corrupted-version",
              data: {
                ...task,
                id: "corrupted-version",
                version: 2,
              },
              expectedVersion: 0,
            });

            await rejectsCode(
              transaction.getTask("corrupted-version"),
              "VALIDATION_ERROR",
              "расхождение версий документа и данных",
            );
          });
        });
      },
    },
    {
      name: "concurrency: параллельный append не создаёт дублей позиций",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const created = await Promise.all(
            Array.from({ length: 20 }, () => createTask(store, context, { projectId: project.id })),
          );

          const tasks = await listScope(store, project.id, "todo");

          assert.equal(tasks.length, 20);
          assert.equal(new Set(created.map((task) => task.id)).size, 20);
          assert.deepEqual(
            new Set(tasks.map((task) => task.id)),
            new Set(created.map((task) => task.id)),
          );
          assertContiguous(positionsOf(tasks), "параллельный append");
        });
      },
    },
    {
      name: "concurrency: параллельный complete сохраняет все задачи",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const created: Task[] = [];

          for (let index = 0; index < 20; index += 1) {
            created.push(await createTask(store, context, { projectId: project.id }));
          }

          await Promise.all(created.map((task) => completeWithRetry(store, context, task.id)));

          const done = await listScope(store, project.id, "done");
          const todo = await listScope(store, project.id, "todo");

          assert.equal(done.length, 20);
          assert.equal(todo.length, 0);
          assertContiguous(positionsOf(done), "параллельный complete");

          for (const task of done) {
            assert.equal(task.status, "done");
            assert.equal(task.completedAt, context.at(1));
          }
        });
      },
    },
    {
      name: "concurrency: параллельный move между статусами не теряет задачи",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const created: Task[] = [];

          for (let index = 0; index < 20; index += 1) {
            created.push(await createTask(store, context, { projectId: project.id }));
          }

          await Promise.all(
            created
              .slice(0, 10)
              .map((task) => moveWithRetry(store, context, task.id, "in_progress", 0)),
          );

          const todo = await listScope(store, project.id, "todo");
          const inProgress = await listScope(store, project.id, "in_progress");

          assert.equal(todo.length, 10);
          assert.equal(inProgress.length, 10);
          assertContiguous(positionsOf(todo), "todo после параллельного move");
          assertContiguous(positionsOf(inProgress), "in_progress после параллельного move");
          assert.equal(new Set([...todo, ...inProgress].map((task) => task.id)).size, 20);
        });
      },
    },

    {
      name: "column: новый проект получает три default-колонки ToDo/In Progress/Done",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const page = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.equal(page.total, 3);
          assert.equal(page.nextOffset, null);
          // Документы без color остаются валидными; стандартное оформление
          // вычисляет представление, а не Store.
          assert.equal(
            page.items.every((column) => column.color === undefined),
            true,
          );
          assert.deepEqual(
            page.items.map((column) => ({
              id: column.id,
              title: column.title,
              status: column.status,
              position: column.position,
              version: column.version,
              createdAt: column.createdAt,
              updatedAt: column.updatedAt,
            })),
            [
              {
                id: `column-${project.id}-todo`,
                title: "ToDo",
                status: "todo",
                position: 0,
                version: 1,
                createdAt: context.at(0),
                updatedAt: context.at(0),
              },
              {
                id: `column-${project.id}-in-progress`,
                title: "In Progress",
                status: "in_progress",
                position: 1,
                version: 1,
                createdAt: context.at(0),
                updatedAt: context.at(0),
              },
              {
                id: `column-${project.id}-done`,
                title: "Done",
                status: "done",
                position: 2,
                version: 1,
                createdAt: context.at(0),
                updatedAt: context.at(0),
              },
            ],
          );
        });
      },
    },
    {
      name: "column: legacy backfill создаёт 4 колонки и columnId без роста public version/updatedAt",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createLegacyProject(store, context);
          const statuses: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "done"];
          const before = new Map<string, Task>();

          for (const status of statuses) {
            const task = await store.getTask(`legacy-task-${project.id}-${status}`);

            assert.notEqual(task, null);
            before.set(status, task as Task);
          }

          const result = await store.backfillLegacyColumns();
          const columns = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.equal(result.createdColumns.length, 4);
          assert.equal(result.updatedTasks.length, 4);
          assert.deepEqual(
            columns.items.map((column) => ({
              id: column.id,
              title: column.title,
              status: column.status,
              color: column.color,
              position: column.position,
            })),
            [
              {
                id: `column-${project.id}-legacy-backlog`,
                title: "Backlog",
                status: "backlog",
                color: undefined,
                position: 0,
              },
              {
                id: `column-${project.id}-legacy-todo`,
                title: "To do",
                status: "todo",
                color: undefined,
                position: 1,
              },
              {
                id: `column-${project.id}-legacy-in_progress`,
                title: "In progress",
                status: "in_progress",
                color: undefined,
                position: 2,
              },
              {
                id: `column-${project.id}-legacy-done`,
                title: "Done",
                status: "done",
                color: undefined,
                position: 3,
              },
            ],
          );

          for (const status of statuses) {
            const task = await store.getTask(`legacy-task-${project.id}-${status}`);
            const original = before.get(status) as Task;

            assert.notEqual(task, null);
            assert.equal((task as Task).columnId, `column-${project.id}-legacy-${status}`);
            assert.equal((task as Task).status, status);
            assert.equal((task as Task).version, original.version);
            assert.equal((task as Task).updatedAt, original.updatedAt);
            assert.equal((task as Task).completedAt, original.completedAt);
          }

          // Идемпотентность: повторный проход ничего не создаёт и не пишет.
          const repeat = await store.backfillLegacyColumns();

          assert.deepEqual(repeat.createdColumns, []);
          assert.deepEqual(repeat.updatedTasks, []);

          // Конкурентный backfill другого legacy-проекта: оба вызова
          // сериализуются провайдером, дубликатов колонок и повторного
          // backfill задач нет.
          const secondProject = await createLegacyProject(store, context);
          const [firstPass, secondPass] = await Promise.all([
            store.backfillLegacyColumns(),
            store.backfillLegacyColumns(),
          ]);
          const secondColumns = await store.listColumns({
            projectId: secondProject.id,
            limit: 200,
            offset: 0,
          });

          assert.equal(secondColumns.items.length, 4);
          assert.equal(firstPass.createdColumns.length + secondPass.createdColumns.length, 4);
          assert.equal(firstPass.updatedTasks.length + secondPass.updatedTasks.length, 4);
          assert.deepEqual(new Set(secondColumns.items.map((column) => column.id)).size, 4);
        });
      },
    },
    {
      name: "query: column.list и task.list не выполняют read-repair",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const legacy = await createLegacyProject(store, context);
          const countDocuments = async (collection: string): Promise<number> => {
            const documents = await store.withTransaction(async (transaction) =>
              transaction.documents.list(PLUGIN_ID, collection),
            );

            return documents.length;
          };
          const columnsBefore = await countDocuments(COLUMN_COLLECTION);
          const tasksBefore = await countDocuments(TASK_COLLECTION);

          const columns = await store.listColumns({
            projectId: legacy.id,
            limit: 200,
            offset: 0,
          });

          assert.equal(columns.total, 0);
          assert.deepEqual(columns.items, []);

          await rejectsCode(
            store.listTasks({
              projectId: legacy.id,
              columnId: `column-${legacy.id}-legacy-todo`,
              limit: 200,
              offset: 0,
            }),
            "NOT_FOUND",
            "task.list по отсутствующей колонке",
          );

          const tasks = await store.listTasks({
            projectId: legacy.id,
            limit: 200,
            offset: 0,
          });

          assert.equal(tasks.total, 4);
          assert.equal(
            tasks.items.every((task) => task.columnId === undefined),
            true,
          );

          // Ни один query не создал колонку и не изменил задачу.
          assert.equal(await countDocuments(COLUMN_COLLECTION), columnsBefore);
          assert.equal(await countDocuments(TASK_COLLECTION), tasksBefore);
        });
      },
    },
    {
      name: "column: create/update/move сохраняют порядок и повышают версии сдвинутых соседей",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const review = await store.createColumn({
            id: "column-review",
            projectId: project.id,
            title: "Review",
            type: "open",
            color: "blue",
            position: 1,
            createdAt: context.at(1),
            expectedVersion: 0,
          });

          assert.equal(review.position, 1);
          assert.equal(review.status, "in_progress");
          assert.equal(review.color, "blue");
          assert.equal(review.version, 1);

          let columns = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.deepEqual(
            columns.items.map((column) => [column.id, column.position, column.version]),
            [
              [`column-${project.id}-todo`, 0, 1],
              ["column-review", 1, 1],
              [`column-${project.id}-in-progress`, 2, 2],
              [`column-${project.id}-done`, 3, 2],
            ],
          );

          const updated = await store.updateColumn({
            id: review.id,
            expectedVersion: 1,
            title: "Code Review",
            updatedAt: context.at(2),
          });

          assert.equal(updated.title, "Code Review");
          assert.equal(updated.color, "blue");
          assert.equal(updated.version, 2);
          assert.equal(updated.updatedAt, context.at(2));

          // Color-only update сохраняет title и повышает версию. Пустой patch
          // отклоняется до записи и не меняет сохранённую колонку.
          const recolored = await store.updateColumn({
            id: review.id,
            expectedVersion: 2,
            color: "green",
            updatedAt: context.at(3),
          });

          assert.equal(recolored.title, "Code Review");
          assert.equal(recolored.color, "green");
          assert.equal(recolored.version, 3);

          // Color-only update с тем же цветом не создаёт новую версию.
          const reasserted = await store.updateColumn({
            id: review.id,
            expectedVersion: 3,
            color: "green",
            updatedAt: context.at(4),
          });

          assert.equal(reasserted.version, 3);
          assert.equal(reasserted.updatedAt, recolored.updatedAt);
          assert.equal(reasserted.title, "Code Review");

          await rejectsCode(
            store.updateColumn({
              id: review.id,
              expectedVersion: 3,
              updatedAt: context.at(5),
            }),
            "INVALID_COLUMN_PATCH",
            "column.update без title и color",
          );

          const afterRejectedPatch = await store.getColumn(review.id);

          assert.equal(afterRejectedPatch?.title, "Code Review");
          assert.equal(afterRejectedPatch?.color, "green");
          assert.equal(afterRejectedPatch?.version, 3);

          const moved = await store.moveColumn({
            id: review.id,
            expectedVersion: 3,
            position: 0,
            updatedAt: context.at(6),
          });

          assert.equal(moved.position, 0);
          assert.equal(moved.color, "green");
          assert.equal(moved.version, 4);

          columns = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.deepEqual(
            columns.items.map((column) => [column.id, column.position, column.version]),
            [
              ["column-review", 0, 4],
              [`column-${project.id}-todo`, 1, 2],
              [`column-${project.id}-in-progress`, 2, 2],
              [`column-${project.id}-done`, 3, 2],
            ],
          );

          await rejectsVersionConflict(
            store.moveColumn({
              id: `column-${project.id}-todo`,
              expectedVersion: 1,
              position: 0,
              updatedAt: context.at(7),
            }),
            1,
            2,
            "move со старой версией колонки",
          );
        });
      },
    },
    {
      name: "column: delete переносит задачи атомарно с completedAt/status и сдвигает соседей",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const todoId = `column-${project.id}-todo`;
          const inProgressId = `column-${project.id}-in-progress`;
          const doneId = `column-${project.id}-done`;
          const review = await store.createColumn({
            id: "column-review",
            projectId: project.id,
            title: "Review",
            type: "open",
            position: 1,
            createdAt: context.at(1),
            expectedVersion: 0,
          });
          const first = await createTask(store, context, {
            id: "task-delete-first",
            projectId: project.id,
            title: "First",
          });
          const second = await createTask(store, context, {
            id: "task-delete-second",
            projectId: project.id,
            columnId: review.id,
            title: "Second",
            createdAtOffset: 1,
          });
          const archive = await store.createColumn({
            id: "column-archive",
            projectId: project.id,
            title: "Archive",
            type: "done",
            createdAt: context.at(2),
            expectedVersion: 0,
          });
          const third = await createTask(store, context, {
            id: "task-delete-third",
            projectId: project.id,
            columnId: archive.id,
            title: "Third",
            createdAtOffset: 2,
          });

          const deletion = await store.deleteColumn({
            id: review.id,
            expectedVersion: 1,
            targetColumnId: todoId,
            updatedAt: context.at(3),
          });

          assert.equal(deletion.deleted, true);

          if (!deletion.deleted) {
            assert.fail("deleteColumn должен вернуть deleted=true");
          }

          assert.equal(deletion.movedTasks.length, 1);
          assert.equal(deletion.targetColumnId, todoId);

          const movedSecond = deletion.movedTasks[0] as Task;

          assert.equal(movedSecond.id, second.id);
          assert.equal(movedSecond.columnId, todoId);
          assert.equal(movedSecond.status, "todo");
          assert.equal(movedSecond.position, 1);
          assert.equal(movedSecond.completedAt, null);
          assert.equal(movedSecond.version, second.version + 1);
          assert.equal(movedSecond.updatedAt, context.at(3));
          assert.deepEqual(
            deletion.updatedColumns.map((column) => [column.id, column.position, column.version]),
            [
              [inProgressId, 1, 3],
              [doneId, 2, 3],
              [archive.id, 3, 2],
            ],
          );

          const firstAfter = await store.getTask(first.id);
          const secondAfter = await store.getTask(second.id);

          assert.equal((firstAfter as Task).columnId, todoId);
          assert.equal((firstAfter as Task).version, first.version);
          assert.equal((secondAfter as Task).columnId, todoId);

          const todoTasks = await listColumnScope(store, project.id, todoId);

          assert.deepEqual(
            todoTasks.map((task) => [task.id, task.position, task.version]),
            [
              [first.id, 0, 1],
              [second.id, 1, 2],
            ],
          );

          const columnsAfterReview = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.deepEqual(
            columnsAfterReview.items.map((column) => [column.id, column.position]),
            [
              [todoId, 0],
              [inProgressId, 1],
              [doneId, 2],
              [archive.id, 3],
            ],
          );

          // Удаление Done-колонки: задача сохраняет прежний completedAt.
          const archiveAfterReview = columnsAfterReview.items.find(
            (column) => column.id === archive.id,
          );

          assert.notEqual(archiveAfterReview, undefined);

          const archiveDeletion = await store.deleteColumn({
            id: archive.id,
            expectedVersion: (archiveAfterReview as Task).version,
            targetColumnId: doneId,
            updatedAt: context.at(4),
          });

          assert.equal(archiveDeletion.deleted, true);

          if (!archiveDeletion.deleted) {
            assert.fail("удаление archive должно вернуть deleted=true");
          }

          assert.equal(archiveDeletion.movedTasks.length, 1);

          const movedThird = archiveDeletion.movedTasks[0] as Task;

          assert.equal(movedThird.id, third.id);
          assert.equal(movedThird.columnId, doneId);
          assert.equal(movedThird.status, "done");
          assert.equal(movedThird.completedAt, third.completedAt);
          assert.equal(movedThird.position, 0);
          assert.equal(movedThird.version, third.version + 1);

          const finalColumns = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.deepEqual(
            finalColumns.items.map((column) => [column.id, column.position]),
            [
              [todoId, 0],
              [inProgressId, 1],
              [doneId, 2],
            ],
          );
        });
      },
    },
    {
      name: "column: delete добавляет задачи после max(position), а не count, без дублей",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const todoId = `column-${project.id}-todo`;
          const inProgressId = `column-${project.id}-in-progress`;
          const first = await createTask(store, context, {
            id: "task-sparse-first",
            projectId: project.id,
            columnId: inProgressId,
            title: "First",
          });
          const second = await createTask(store, context, {
            id: "task-sparse-second",
            projectId: project.id,
            columnId: inProgressId,
            title: "Second",
            createdAtOffset: 1,
          });
          const source = await createTask(store, context, {
            id: "task-sparse-source",
            projectId: project.id,
            title: "Source",
            createdAtOffset: 2,
          });

          // Store не требует непрерывности, поэтому разреженные позиции
          // 5 и 10 допустимы. Меняем документы напрямую, как это могло
          // возникнуть после прошлых операций.
          await store.withTransaction(async (transaction) => {
            for (const [task, position] of [
              [first, 5],
              [second, 10],
            ] as const) {
              const document = await transaction.documents.get(PLUGIN_ID, TASK_COLLECTION, task.id);

              assert.notEqual(document, null);

              if (document === null) {
                continue;
              }

              await transaction.documents.put({
                pluginId: PLUGIN_ID,
                collection: TASK_COLLECTION,
                id: task.id,
                data: {
                  ...(document.data as Record<string, JsonValue>),
                  position,
                  version: task.version + 1,
                },
                indexedFields: {
                  projectId: project.id,
                  columnId: task.columnId as JsonValue,
                  status: task.status as JsonValue,
                  priority: task.priority as JsonValue,
                  parentTaskId: task.parentTaskId as JsonValue,
                },
                expectedVersion: document.version,
              });
            }
          });

          const deletion = await store.deleteColumn({
            id: todoId,
            expectedVersion: 1,
            targetColumnId: inProgressId,
            updatedAt: context.at(3),
          });

          assert.equal(deletion.deleted, true);

          if (!deletion.deleted) {
            assert.fail("deleteColumn должен вернуть deleted=true");
          }

          assert.equal(deletion.movedTasks.length, 1);

          const moved = deletion.movedTasks[0] as Task;

          assert.equal(moved.id, source.id);
          assert.equal(moved.columnId, inProgressId);
          assert.equal(moved.position, 11);

          const scope = await listColumnScope(store, project.id, inProgressId);

          assert.deepEqual(
            scope.map((task) => [task.id, task.position]),
            [
              [first.id, 5],
              [second.id, 10],
              [source.id, 11],
            ],
          );
          assert.equal(new Set(scope.map((task) => task.position)).size, scope.length);

          // Переполнение MAX_POSITION отвергается доменной ошибкой до записи.
          const overflowProject = await createProject(store, context, { title: "Overflow" });
          const overflowTodo = `column-${overflowProject.id}-todo`;
          const overflowTarget = `column-${overflowProject.id}-in-progress`;
          const overflowTargetTask = await createTask(store, context, {
            id: "task-overflow-target",
            projectId: overflowProject.id,
            columnId: overflowTarget,
            title: "Max target",
            createdAtOffset: 4,
          });
          const overflowSourceTask = await createTask(store, context, {
            id: "task-overflow-source",
            projectId: overflowProject.id,
            title: "Max source",
            createdAtOffset: 5,
          });

          await store.withTransaction(async (transaction) => {
            const document = await transaction.documents.get(
              PLUGIN_ID,
              TASK_COLLECTION,
              overflowTargetTask.id,
            );

            assert.notEqual(document, null);

            if (document === null) {
              return;
            }

            await transaction.documents.put({
              pluginId: PLUGIN_ID,
              collection: TASK_COLLECTION,
              id: overflowTargetTask.id,
              data: {
                ...(document.data as Record<string, JsonValue>),
                position: MAX_POSITION,
                version: overflowTargetTask.version + 1,
              },
              indexedFields: {
                projectId: overflowProject.id,
                columnId: overflowTarget as JsonValue,
                status: overflowTargetTask.status as JsonValue,
                priority: overflowTargetTask.priority as JsonValue,
                parentTaskId: overflowTargetTask.parentTaskId as JsonValue,
              },
              expectedVersion: document.version,
            });
          });

          await rejectsCode(
            store.deleteColumn({
              id: overflowTodo,
              expectedVersion: 1,
              targetColumnId: overflowTarget,
              updatedAt: context.at(6),
            }),
            "INVALID_POSITION",
            "переполнение MAX_POSITION при переносе задач",
          );

          const overflowSource = await store.getTask(overflowSourceTask.id);

          assert.equal((overflowSource as Task).columnId, overflowTodo);
        });
      },
    },
    {
      name: "column: delete отклоняет last/self/чужой target",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const todoId = `column-${project.id}-todo`;
          const inProgressId = `column-${project.id}-in-progress`;
          const doneId = `column-${project.id}-done`;

          await rejectsCode(
            store.deleteColumn({
              id: todoId,
              expectedVersion: 1,
              targetColumnId: todoId,
              updatedAt: context.at(1),
            }),
            "COLUMN_TARGET_SELF",
            "удаление колонки в саму себя",
          );

          const other = await createProject(store, context, { title: "Other" });

          await rejectsCode(
            store.deleteColumn({
              id: inProgressId,
              expectedVersion: 1,
              targetColumnId: `column-${other.id}-todo`,
              updatedAt: context.at(1),
            }),
            "COLUMN_TARGET_OTHER_PROJECT",
            "target из другого проекта",
          );

          const deletedProgress = await store.deleteColumn({
            id: inProgressId,
            expectedVersion: 1,
            targetColumnId: todoId,
            updatedAt: context.at(1),
          });

          assert.equal(deletedProgress.deleted, true);

          await rejectsCode(
            store.deleteColumn({
              id: todoId,
              expectedVersion: 1,
              targetColumnId: doneId,
              updatedAt: context.at(2),
            }),
            "COLUMN_LAST_OPEN",
            "удаление последней открытой колонки",
          );

          const remaining = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.deepEqual(
            remaining.items.map((column) => column.id),
            [todoId, doneId],
          );

          // Отдельный проект: нельзя удалить и последнюю Done-колонку, даже
          // если открытые колонки ещё остаются.
          const doneProject = await createProject(store, context, { title: "Done only" });
          const doneProjectTodo = `column-${doneProject.id}-todo`;
          const doneProjectDone = `column-${doneProject.id}-done`;

          const extraDone = await store.createColumn({
            id: "column-extra-done-last",
            projectId: doneProject.id,
            title: "Second Done",
            type: "done",
            createdAt: context.at(4),
            expectedVersion: 0,
          });

          await store.deleteColumn({
            id: doneProjectDone,
            expectedVersion: 1,
            targetColumnId: doneProjectTodo,
            updatedAt: context.at(5),
          });

          await rejectsCode(
            store.deleteColumn({
              id: extraDone.id,
              expectedVersion: 2,
              targetColumnId: doneProjectTodo,
              updatedAt: context.at(6),
            }),
            "COLUMN_LAST_DONE",
            "удаление последней Done-колонки",
          );

          const doneProjectColumns = await store.listColumns({
            projectId: doneProject.id,
            limit: 200,
            offset: 0,
          });

          assert.deepEqual(
            doneProjectColumns.items.map((column) => column.id),
            [doneProjectTodo, `column-${doneProject.id}-in-progress`, extraDone.id],
          );
        });
      },
    },
    {
      name: "column: delete с устаревшей версией не переносит задачи (rollback)",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const review = await store.createColumn({
            id: "column-review",
            projectId: project.id,
            title: "Review",
            type: "open",
            position: 1,
            createdAt: context.at(1),
            expectedVersion: 0,
          });
          const task = await createTask(store, context, {
            id: "task-rollback",
            projectId: project.id,
            columnId: review.id,
          });

          await rejectsVersionConflict(
            store.deleteColumn({
              id: review.id,
              expectedVersion: 99,
              targetColumnId: `column-${project.id}-todo`,
              updatedAt: context.at(2),
            }),
            99,
            1,
            "delete со старой версией колонки",
          );

          const storedColumn = await store.getColumn(review.id);
          const storedTask = await store.getTask(task.id);

          assert.notEqual(storedColumn, null);
          assert.equal((storedColumn as Task).version, 1);
          assert.equal((storedTask as Task).columnId, review.id);
          assert.equal((storedTask as Task).version, task.version);
        });
      },
    },
    {
      name: "task: old client без columnId, first Done и выбор колонки по статусу",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const todoId = `column-${project.id}-todo`;
          const inProgressId = `column-${project.id}-in-progress`;
          const doneId = `column-${project.id}-done`;
          const plain = await createTask(store, context, {
            id: "task-old-plain",
            projectId: project.id,
          });

          assert.equal(plain.columnId, todoId);
          assert.equal(plain.status, "todo");

          const legacyMove = await createTask(store, context, {
            id: "task-old-status",
            projectId: project.id,
            status: "in_progress",
          });

          assert.equal(legacyMove.columnId, inProgressId);
          assert.equal(legacyMove.status, "in_progress");

          await store.createColumn({
            id: "column-extra-done",
            projectId: project.id,
            title: "Extra Done",
            type: "done",
            createdAt: context.at(1),
            expectedVersion: 0,
          });

          const completed = await store.completeTask({
            id: plain.id,
            expectedVersion: plain.version,
            updatedAt: context.at(2),
          });

          assert.equal(completed.columnId, doneId);
          assert.equal(completed.status, "done");

          const movedByStatus = await store.moveTask({
            id: legacyMove.id,
            expectedVersion: legacyMove.version,
            status: "todo",
            position: 1,
            updatedAt: context.at(3),
          });

          assert.equal(movedByStatus.columnId, todoId);
          assert.equal(movedByStatus.status, "todo");
          assert.equal(movedByStatus.position, 0);

          const backlog = await store.createTask({
            id: "task-backlog-new-project",
            projectId: project.id,
            parentTaskId: null,
            title: "Backlog",
            descriptionMarkdown: "",
            status: "backlog",
            priority: "medium",
            dueAt: null,
            tags: [],
            createdAt: context.at(4),
            expectedVersion: 0,
          });
          const backlogColumnId = `column-${project.id}-legacy-backlog`;

          assert.equal(backlog.columnId, backlogColumnId);
          assert.equal(backlog.status, "backlog");
          assert.equal(backlog.position, 0);

          // Default-набор не потерян, Backlog встал в начало, остальные
          // legacy-позиции сдвинулись.
          const afterBacklog = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.deepEqual(
            afterBacklog.items.map((column) => [column.id, column.position]),
            [
              [backlogColumnId, 0],
              [todoId, 1],
              [inProgressId, 2],
              [doneId, 3],
              ["column-extra-done", 4],
            ],
          );

          // Повторная legacy-операция использует уже созданную колонку.
          const repeatedBacklog = await store.createTask({
            id: "task-backlog-new-project-repeat",
            projectId: project.id,
            parentTaskId: null,
            title: "Backlog 2",
            descriptionMarkdown: "",
            status: "backlog",
            priority: "medium",
            dueAt: null,
            tags: [],
            createdAt: context.at(5),
            expectedVersion: 0,
          });

          assert.equal(repeatedBacklog.columnId, backlogColumnId);
          assert.equal(repeatedBacklog.position, 1);

          const afterRepeat = await store.listColumns({
            projectId: project.id,
            limit: 200,
            offset: 0,
          });

          assert.equal(afterRepeat.items.length, 5);

          // Legacy move по отсутствующему статусу также материализует колонку.
          const movedToBacklog = await store.moveTask({
            id: plain.id,
            expectedVersion: completed.version,
            status: "backlog",
            position: 2,
            updatedAt: context.at(6),
          });

          assert.equal(movedToBacklog.columnId, backlogColumnId);
          assert.equal(movedToBacklog.status, "backlog");
          assert.equal(movedToBacklog.position, 2);
        });
      },
    },
    {
      name: "task: mismatch status/columnId и неизвестная колонка отклоняются",
      async run() {
        await withStore(async (store) => {
          const context = createContext();
          const project = await createProject(store, context);
          const doneId = `column-${project.id}-done`;

          await rejectsCode(
            store.createTask({
              id: "task-mismatch",
              projectId: project.id,
              parentTaskId: null,
              title: "Mismatch",
              descriptionMarkdown: "",
              columnId: doneId,
              status: "todo",
              priority: "medium",
              dueAt: null,
              tags: [],
              createdAt: context.at(1),
              expectedVersion: 0,
            }),
            "COLUMN_STATUS_MISMATCH",
            "create с несовпадающими status и columnId",
          );

          await rejectsCode(
            store.createTask({
              id: "task-unknown-column",
              projectId: project.id,
              parentTaskId: null,
              title: "Unknown",
              descriptionMarkdown: "",
              columnId: "column-missing",
              priority: "medium",
              dueAt: null,
              tags: [],
              createdAt: context.at(2),
              expectedVersion: 0,
            }),
            "COLUMN_NOT_FOUND",
            "create с неизвестной колонкой",
          );

          const task = await createTask(store, context, {
            id: "task-move-mismatch",
            projectId: project.id,
          });

          await rejectsCode(
            store.moveTask({
              id: task.id,
              expectedVersion: task.version,
              columnId: doneId,
              status: "todo",
              position: 0,
              updatedAt: context.at(3),
            }),
            "COLUMN_STATUS_MISMATCH",
            "move с несовпадающими status и columnId",
          );
        });
      },
    },
  ];
}
