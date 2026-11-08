// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StorageProvider } from "@kanbaner/plugin-sdk";
import {
  InMemoryStorageProvider,
  StorageMigrationRunner,
  bindPluginStorage,
} from "@kanbaner/kernel";
import {
  createCoreInfrastructureMigrations,
  createSqliteStorageProvider,
} from "@kanbaner/storage-sqlite";

import { PLUGIN_ID } from "../../packages/plugin-tasks/src/constants.ts";
import { createTasksStore } from "../../packages/plugin-tasks/src/store/index.ts";
import type { TasksStore } from "../../packages/plugin-tasks/src/store.ts";

const FIXED_NOW = "2026-01-01T00:00:00.500Z";
const BASE_CREATED_AT = "2025-12-01T00:00:00.000Z";

type ProviderKind = "memory" | "sqlite";

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function createFixtureStore(
  kind: ProviderKind,
  now: string = FIXED_NOW,
): Promise<TasksStore> {
  const provider =
    kind === "memory"
      ? new InMemoryStorageProvider({
          backendId: `memory-project-summary-${globalThis.crypto.randomUUID()}`,
        })
      : createSqliteStorageProvider({
          backendId: `sqlite-project-summary-${globalThis.crypto.randomUUID()}`,
          dataDirectory: (() => {
            const directory = mkdtempSync(path.join(tmpdir(), "kanbaner-project-summary-"));

            directories.push(directory);

            return directory;
          })(),
        });
  const opened = provider as StorageProvider;

  await opened.open();

  if (kind === "sqlite") {
    await new StorageMigrationRunner(opened).run(createCoreInfrastructureMigrations());
  }

  closers.push(() => opened.close());

  const storage = bindPluginStorage(opened, PLUGIN_ID);

  return createTasksStore({ storage, now: () => now });
}

async function seedProject(
  store: TasksStore,
  id: string,
  createdAt: string = BASE_CREATED_AT,
): Promise<void> {
  await store.createProject({
    id,
    title: `Проект ${id}`,
    descriptionMarkdown: "",
    createdAt,
    expectedVersion: 0,
  });
}

interface SeedTask {
  readonly id: string;
  readonly projectId: string;
  readonly status?: "backlog" | "todo" | "in_progress" | "done";
  readonly dueAt?: string | null;
}

async function seedTask(store: TasksStore, seed: SeedTask): Promise<void> {
  await store.createTask({
    id: seed.id,
    projectId: seed.projectId,
    parentTaskId: null,
    title: `Задача ${seed.id}`,
    descriptionMarkdown: "",
    status: seed.status ?? "todo",
    priority: "medium",
    dueAt: seed.dueAt ?? null,
    tags: [],
    createdAt: BASE_CREATED_AT,
    expectedVersion: 0,
  });
}

const KINDS: readonly ProviderKind[] = ["memory", "sqlite"];

for (const kind of KINDS) {
  describe(`project.summary Store (${kind})`, () => {
    it("считает полные данные, даже когда проектов больше страницы", async () => {
      const store = await createFixtureStore(kind);

      await seedProject(store, "project-1");
      await seedProject(store, "project-2");
      await seedProject(store, "project-3");

      for (let index = 0; index < 60; index += 1) {
        await seedTask(store, {
          id: `task-p1-${String(index)}`,
          projectId: "project-1",
          status: "todo",
        });
      }

      await seedTask(store, { id: "task-p2-1", projectId: "project-2", status: "done" });
      await seedTask(store, { id: "task-p2-2", projectId: "project-2", status: "backlog" });

      const first = await store.summarizeProjects({ limit: 2, offset: 0 });

      expect(first.items).toHaveLength(2);
      expect(first.items[0]?.project.id).toBe("project-1");
      expect(first.items[0]?.total).toBe(60);
      expect(first.items[0]?.counts.todo).toBe(60);
      expect(first.total).toBe(3);
      expect(first.nextOffset).toBe(2);
      expect(first.totals).toEqual({
        total: 62,
        counts: { backlog: 1, todo: 60, in_progress: 0, done: 1 },
        overdueCount: 0,
      });

      const last = await store.summarizeProjects({ limit: 2, offset: 2 });

      expect(last.items.map((summary) => summary.project.id)).toEqual(["project-3"]);
      expect(last.nextOffset).toBeNull();
      expect(last.totals.total).toBe(62);
    });

    it("не считает done просроченным, а границу dueAt == now и дробные UTC — точно", async () => {
      const store = await createFixtureStore(kind);
      const now = "2026-01-01T00:00:00.500Z";

      await seedProject(store, "project-1");
      await seedTask(store, {
        id: "overdue-fraction",
        projectId: "project-1",
        dueAt: "2026-01-01T00:00:00.4999Z",
      });
      await seedTask(store, {
        id: "boundary-equal",
        projectId: "project-1",
        dueAt: "2026-01-01T00:00:00.500Z",
      });
      await seedTask(store, {
        id: "boundary-equal-short",
        projectId: "project-1",
        dueAt: "2026-01-01T00:00:00.5Z",
      });
      await seedTask(store, {
        id: "overdue-done",
        projectId: "project-1",
        status: "done",
        dueAt: "2020-01-01T00:00:00.000Z",
      });
      await seedTask(store, {
        id: "overdue-open",
        projectId: "project-1",
        status: "in_progress",
        dueAt: "2025-12-31T23:59:59.999Z",
      });
      await seedTask(store, { id: "no-due", projectId: "project-1", status: "backlog" });

      expect(now).toBe(FIXED_NOW);

      const summary = await store.summarizeProjects({
        projectId: "project-1",
        limit: 1,
        offset: 0,
      });
      const item = summary.items[0];

      expect(item).toBeDefined();
      expect(item?.total).toBe(6);
      expect(item?.counts).toEqual({ backlog: 1, todo: 3, in_progress: 1, done: 1 });
      expect(item?.overdueCount).toBe(2);
      expect(summary.totals.overdueCount).toBe(2);
    });

    it("возвращает NOT_FOUND для явного несуществующего projectId и нулевой агрегат без проектов", async () => {
      const store = await createFixtureStore(kind);

      const empty = await store.summarizeProjects({ limit: 10, offset: 0 });

      expect(empty.items).toEqual([]);
      expect(empty.total).toBe(0);
      expect(empty.nextOffset).toBeNull();
      expect(empty.totals).toEqual({
        total: 0,
        counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
        overdueCount: 0,
      });

      await expect(
        store.summarizeProjects({ projectId: "missing-project", limit: 10, offset: 0 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", entity: "project", id: "missing-project" });
    });

    it("ограничивает items одним проектом, но оставляет полный агрегат", async () => {
      const store = await createFixtureStore(kind);

      await seedProject(store, "project-1");
      await seedProject(store, "project-2", "2025-12-02T00:00:00.000Z");
      await seedTask(store, { id: "task-1", projectId: "project-1", status: "backlog" });
      await seedTask(store, { id: "task-2", projectId: "project-2", status: "done" });
      await seedTask(store, { id: "task-3", projectId: "project-2", status: "todo" });

      const summary = await store.summarizeProjects({
        projectId: "project-2",
        limit: 10,
        offset: 0,
      });

      expect(summary.items.map((item) => item.project.id)).toEqual(["project-2"]);
      expect(summary.total).toBe(1);
      expect(summary.items[0]?.counts).toEqual({
        backlog: 0,
        todo: 1,
        in_progress: 0,
        done: 1,
      });
      expect(summary.totals).toEqual({
        total: 2,
        counts: { backlog: 0, todo: 1, in_progress: 0, done: 1 },
        overdueCount: 0,
      });
    });
  });
}
