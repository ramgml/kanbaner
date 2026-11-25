// @vitest-environment node

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStorageProvider, createPluginRuntime, type PluginRuntime } from "@kanbaner/kernel";
import type { JsonValue, OperationResult, PluginLogger, ResourceRef } from "@kanbaner/plugin-sdk";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "./application-composition.ts";

const PACKAGES_DIRECTORY = path.resolve(import.meta.dirname, "../../../../packages");

/**
 * Публичные ID, которые использует тест.
 *
 * Тест не импортирует внутренности плагинов: runtime находит их по манифесту,
 * а вызовы идут через общий UI transport и публичные команды/запросы.
 */
const SEARCH_QUERY = "kanbaner.search.query";
const SEARCH_FILTERS = "kanbaner.search.filters";
const PROJECT_CREATE = "kanbaner.tasks.project.create";
const TASK_CREATE = "kanbaner.tasks.task.create";
const TASK_DELETE = "kanbaner.tasks.task.delete";
const NOTE_CREATE = "kanbaner.notes.note.create";
const FIXTURE_CREATE = "kanbaner.fixture.item.create";
const FIXTURE_REINDEX = "kanbaner.fixture.item.reindex";

const SEARCH_PLUGIN_ID = "kanbaner.search";
const NOTES_PLUGIN_ID = "kanbaner.notes";
const TASKS_PLUGIN_ID = "kanbaner.tasks";
const FIXTURE_PLUGIN_ID = "kanbaner.fixture";

const OPENCODE_PLUGIN_ID = "kanbaner.opencode";

const NOOP_LOGGER: PluginLogger = Object.freeze({
  debug(): void {
    // Намеренно пусто.
  },
  info(): void {
    // Намеренно пусто.
  },
  warn(): void {
    // Намеренно пусто.
  },
  error(): void {
    // Намеренно пусто.
  },
});

interface SearchHit {
  readonly ref: ResourceRef;
  readonly title: string;
  readonly kind?: string;
  readonly excerpt: string;
  readonly score: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly hasMore: boolean;
  readonly warnings: readonly { readonly providerId: string; readonly code: string }[];
}

interface FiltersResult {
  readonly kinds: readonly { readonly id: string; readonly title: string }[];
  readonly facets: readonly {
    readonly id: string;
    readonly title: string;
    readonly operators: readonly string[];
    readonly values: readonly { readonly value: string; readonly label: string }[];
  }[];
  readonly warnings: readonly { readonly providerId: string; readonly code: string }[];
}

interface Harness {
  readonly provider: InMemoryStorageProvider;
  readonly composition: ApplicationPluginComposition;
  readonly runtime: PluginRuntime;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

async function startHarness(disabledPlugins: readonly string[]): Promise<Harness> {
  const provider = new InMemoryStorageProvider({
    backendId: `search-integration-${globalThis.crypto.randomUUID()}`,
  });

  await provider.open();

  const composition = createApplicationPluginComposition({
    storage: provider,
    logger: NOOP_LOGGER,
  });
  const runtime = createPluginRuntime({
    pluginDirectories: [PACKAGES_DIRECTORY],
    disabledPlugins,
    services: composition.services,
  });

  const snapshot = await runtime.start();
  const search = snapshot.plugins.find((plugin) => plugin.pluginId === SEARCH_PLUGIN_ID);

  if (search === undefined || !search.activated) {
    throw new Error(
      `Плагин ${SEARCH_PLUGIN_ID} не активировался: ${JSON.stringify(snapshot.problems)}`,
    );
  }

  composition.bindPlugins(
    snapshot.plugins
      .filter((plugin) => plugin.activated && plugin.pluginId !== null)
      .map((plugin) => plugin.pluginId as string),
  );

  let closed = false;

  const harness: Harness = {
    provider,
    composition,
    runtime,
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await runtime.stop();
      composition.dispose();
      await provider.close();
    },
  };

  harnesses.push(harness);

  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close();
  }
});

function expectData<Data>(result: OperationResult<unknown>): Data {
  if (!result.ok) {
    throw new Error(`Операция упала: ${result.error.code} (${result.error.message})`);
  }

  return result.data as Data;
}

function expectFailure(result: OperationResult<unknown>, code: string): void {
  expect(result.ok).toBe(false);

  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
}

interface CreatedProject {
  readonly project: { readonly id: string };
}

interface CreatedTask {
  readonly task: { readonly id: string; readonly version: number };
  readonly resource: ResourceRef;
}

async function createProject(harness: Harness, title: string): Promise<string> {
  const created = expectData<CreatedProject>(
    await harness.composition.executeUiOperation(PROJECT_CREATE, { title }),
  );

  return created.project.id;
}

async function createTask(
  harness: Harness,
  input: {
    readonly projectId: string;
    readonly title: string;
    readonly descriptionMarkdown?: string;
    readonly tags?: readonly string[];
    readonly status?: "backlog" | "todo" | "in_progress" | "done";
  },
): Promise<CreatedTask> {
  return expectData<CreatedTask>(
    await harness.composition.executeUiOperation(TASK_CREATE, { ...input } as unknown as JsonValue),
  );
}

async function search(
  harness: Harness,
  input: Readonly<Record<string, unknown>>,
): Promise<SearchResult> {
  return expectData<SearchResult>(
    await harness.composition.executeUiOperation(SEARCH_QUERY, {
      ...input,
    } as unknown as JsonValue),
  );
}

async function filters(harness: Harness): Promise<FiltersResult> {
  return expectData<FiltersResult>(
    await harness.composition.executeUiOperation(SEARCH_FILTERS, {}),
  );
}

function refsOf(result: SearchResult): readonly string[] {
  return result.hits.map((hit) => hit.ref);
}

describe("глобальный поиск в composition приложения", () => {
  it(
    "агрегирует задачи, заметки и fixture, применяя filters по объявленным полям",
    { timeout: 30_000 },
    async () => {
      const harness = await startHarness([OPENCODE_PLUGIN_ID]);
      const firstProject = await createProject(harness, "Первый проект");
      const secondProject = await createProject(harness, "Второй проект");
      const marker = `маркер-${globalThis.crypto.randomUUID()}`;

      const firstTask = await createTask(harness, {
        projectId: firstProject,
        title: `${marker} альфа`,
        descriptionMarkdown: "Описание первой задачи",
        tags: ["alpha"],
        status: "todo",
      });
      const secondTask = await createTask(harness, {
        projectId: secondProject,
        title: `${marker} бета`,
        tags: ["beta"],
        status: "in_progress",
      });

      expectData(
        await harness.composition.executeUiOperation(NOTE_CREATE, {
          title: `${marker} заметка`,
          contentMarkdown: "Текст заметки",
        }),
      );
      expectData(
        await harness.composition.executeUiOperation(FIXTURE_CREATE, {
          title: `${marker} fixture`,
        }),
      );

      const facets = await filters(harness);

      expect(facets.kinds.map((kind) => kind.id).sort()).toEqual(["item", "note", "task"]);
      expect(facets.facets.map((facet) => facet.id)).toEqual(["projectId", "status", "tags"]);
      expect(facets.warnings).toEqual([]);

      const all = await search(harness, { text: marker });

      expect(refsOf(all)).toEqual(
        expect.arrayContaining([firstTask.resource, secondTask.resource]),
      );
      expect(all.hits.some((hit) => hit.ref.startsWith(`${NOTES_PLUGIN_ID}:`))).toBe(true);
      expect(all.hits.some((hit) => hit.ref.startsWith(`${FIXTURE_PLUGIN_ID}:`))).toBe(true);
      expect(all.warnings).toEqual([]);

      const tasksOnly = await search(harness, { text: marker, kinds: ["task"] });

      expect(tasksOnly.hits.every((hit) => hit.kind === "task")).toBe(true);
      expect(refsOf(tasksOnly)).toEqual(
        expect.arrayContaining([firstTask.resource, secondTask.resource]),
      );

      const byProject = await search(harness, {
        text: marker,
        filters: [{ field: "projectId", operator: "eq", value: firstProject }],
      });

      expect(refsOf(byProject)).toEqual([firstTask.resource]);
      expect(byProject.hits.every((hit) => hit.ref.startsWith(`${TASKS_PLUGIN_ID}:`))).toBe(true);

      const byTag = await search(harness, {
        text: marker,
        filters: [{ field: "tags", operator: "contains", value: "alpha" }],
      });

      expect(refsOf(byTag)).toEqual([firstTask.resource]);

      const byStatus = await search(harness, {
        text: marker,
        filters: [{ field: "status", operator: "eq", value: "in_progress" }],
      });

      expect(refsOf(byStatus)).toEqual([secondTask.resource]);

      expectData(
        await harness.composition.executeUiOperation(TASK_DELETE, {
          id: firstTask.task.id,
          expectedVersion: firstTask.task.version,
          confirm: true,
        }),
      );

      const afterDelete = await search(harness, { text: marker });

      expect(refsOf(afterDelete)).not.toContain(firstTask.resource);
      expect(refsOf(afterDelete)).toContain(secondTask.resource);
    },
  );

  it(
    "переиндексирует fixture через публичную команду и не теряет задачи",
    { timeout: 30_000 },
    async () => {
      const harness = await startHarness([OPENCODE_PLUGIN_ID]);
      const projectId = await createProject(harness, "Проект reindex");
      const marker = `reindex-${globalThis.crypto.randomUUID()}`;
      const task = await createTask(harness, { projectId, title: `${marker} задача` });

      expectData(
        await harness.composition.executeUiOperation(FIXTURE_CREATE, {
          title: `${marker} fixture`,
        }),
      );

      // Команда reindex не экспортирована в UI/HTTP: это внутренняя операция
      // восстановления индекса fixture. Integration-тест вызывает её через ту
      // же шину, что и плагин, чтобы проверить публичный результат reindex.
      const reindexed = expectData<{ readonly count: number }>(
        await harness.composition.operations.commands.execute(FIXTURE_REINDEX, {}),
      );

      expect(reindexed.count).toBeGreaterThanOrEqual(1);

      const result = await search(harness, { text: marker });

      expect(refsOf(result)).toEqual(
        expect.arrayContaining([
          task.resource,
          expect.stringMatching(new RegExp(`^${FIXTURE_PLUGIN_ID}:item:`, "u")),
        ]),
      );
    },
  );

  it("не вызывает провайдера отключённого плагина", { timeout: 30_000 }, async () => {
    const harness = await startHarness([OPENCODE_PLUGIN_ID, FIXTURE_PLUGIN_ID]);
    const projectId = await createProject(harness, "Проект без fixture");
    const marker = `disabled-${globalThis.crypto.randomUUID()}`;

    await createTask(harness, { projectId, title: `${marker} задача` });
    expectData(
      await harness.composition.executeUiOperation(NOTE_CREATE, {
        title: `${marker} заметка`,
        contentMarkdown: "Текст",
      }),
    );

    const facets = await filters(harness);

    expect(facets.kinds.map((kind) => kind.id).sort()).toEqual(["note", "task"]);
    expect(facets.kinds.some((kind) => kind.id === "item")).toBe(false);

    const result = await search(harness, { text: marker });

    expect(result.hits.some((hit) => hit.ref.startsWith(`${FIXTURE_PLUGIN_ID}:`))).toBe(false);
    expect(result.hits.some((hit) => hit.ref.startsWith(`${TASKS_PLUGIN_ID}:`))).toBe(true);
    expect(result.hits.some((hit) => hit.ref.startsWith(`${NOTES_PLUGIN_ID}:`))).toBe(true);
  });

  it(
    "отклоняет неизвестный тип и неизвестный фильтр без частичной выдачи",
    { timeout: 30_000 },
    async () => {
      const harness = await startHarness([OPENCODE_PLUGIN_ID]);

      expectFailure(
        await harness.composition.executeUiOperation(SEARCH_QUERY, {
          text: "маркер",
          kinds: ["unknown-kind"],
        }),
        "VALIDATION_ERROR",
      );
      expectFailure(
        await harness.composition.executeUiOperation(SEARCH_QUERY, {
          text: "маркер",
          filters: [{ field: "unknownField", operator: "eq", value: "x" }],
        }),
        "VALIDATION_ERROR",
      );
      expectFailure(
        await harness.composition.executeUiOperation(SEARCH_QUERY, { text: "   " }),
        "VALIDATION_ERROR",
      );
    },
  );
});
