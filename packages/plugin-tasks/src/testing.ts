import assert from "node:assert/strict";

import type { UtcTimestamp } from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, PROJECT_COLLECTION } from "./constants.ts";
import {
  deleteEventVersion,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "./model.ts";
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
  nextId(kind: "project" | "task"): string;
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

  return {
    nextId(kind) {
      if (kind === "project") {
        projectSequence += 1;

        return `project-${String(projectSequence)}`;
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
    readonly createdAtOffset?: number;
    readonly id?: string;
  } = {},
): Promise<Project> {
  return store.createProject({
    id: options.id ?? context.nextId("project"),
    title: options.title ?? "Project",
    descriptionMarkdown: "",
    createdAt: context.at(options.createdAtOffset ?? 0),
    expectedVersion: 0,
  });
}

interface TaskSeed {
  readonly projectId: string;
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
    status: seed.status ?? "todo",
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
            createdAtOffset: 10,
          });
          const earlier = await createProject(store, context, {
            title: "Earlier",
            createdAtOffset: 5,
          });

          assert.equal(later.version, 1);
          assert.equal(later.createdAt, context.at(10));
          assert.equal(later.updatedAt, context.at(10));
          assert.deepEqual(await store.getProject(later.id), later);

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

          await rejectsVersionConflict(
            store.updateProject({
              id: project.id,
              expectedVersion: 1,
              title: "Stale",
              updatedAt: context.at(2),
            }),
            1,
            2,
            "устаревший update проекта",
          );
          await rejectsVersionConflict(
            store.deleteProject({ id: project.id, expectedVersion: 1 }),
            1,
            2,
            "устаревший delete проекта",
          );

          const reread = await store.getProject(project.id);

          assert.equal(reread?.title, "Updated");
          assert.equal(reread?.version, 2);
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
      name: "task: append уникален в области projectId/status и не зависит от parent",
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
          const backlog = await createTask(store, context, {
            projectId: project.id,
            status: "backlog",
          });

          const todo = await listScope(store, project.id, "todo");

          assert.deepEqual(
            todo.map((task) => task.id),
            [first.id, second.id, third.id, child.id],
          );
          assert.deepEqual(positionsOf(todo), [0, 1, 2, 3]);
          assert.equal(backlog.position, 0);
          assert.deepEqual(positionsOf(await listScope(store, project.id, "backlog")), [0]);
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
          });

          const afterInsert = await listScope(store, project.id, "todo");

          assert.deepEqual(
            afterInsert.map((task) => task.id),
            [first.id, inserted.id, second.id, third.id],
          );
          assert.deepEqual(positionsOf(afterInsert), [0, 1, 2, 3]);

          const appended = await createTask(store, context, {
            projectId: project.id,
            title: "Y",
            position: 999,
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

          await store.moveTask({
            id: first.id,
            expectedVersion: 1,
            status: "in_progress",
            position: 0,
            updatedAt: context.at(2),
          });
          await store.moveTask({
            id: second.id,
            expectedVersion: 1,
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
          assert.deepEqual(
            (await listScope(store, project.id, "todo")).map((task) => task.id),
            [first.id, third.id],
          );
          assert.deepEqual(positionsOf(await listScope(store, project.id, "todo")), [0, 1]);
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
            expectedVersion: 1,
            position: 0,
            updatedAt: context.at(7),
          });

          assert.equal(completedSecond.position, 0);
          assert.deepEqual(
            (await listScope(store, project.id, "done")).map((task) => task.id),
            [second.id, first.id],
          );

          const reopened = await store.moveTask({
            id: first.id,
            expectedVersion: 2,
            status: "todo",
            position: 0,
            updatedAt: context.at(8),
          });

          assert.equal(reopened.completedAt, null);
          assert.equal(reopened.status, "todo");

          const recompleted = await store.moveTask({
            id: first.id,
            expectedVersion: 3,
            status: "done",
            position: 0,
            updatedAt: context.at(9),
          });

          assert.equal(recompleted.completedAt, context.at(9));

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
          assert.equal((await store.getTask(survivor.id))?.id, survivor.id);
          assert.deepEqual(positionsOf(await listScope(store, project.id, "todo")), [0]);
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

          await Promise.all(
            created.map((task) =>
              store.completeTask({
                id: task.id,
                expectedVersion: task.version,
                updatedAt: context.at(1),
              }),
            ),
          );

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
            created.slice(0, 10).map((task) =>
              store.moveTask({
                id: task.id,
                expectedVersion: task.version,
                status: "in_progress",
                position: 0,
                updatedAt: context.at(1),
              }),
            ),
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
  ];
}
