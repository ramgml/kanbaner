// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PluginStorage, StorageProvider } from "@kanbaner/plugin-sdk";
import {
  InMemoryStorageProvider,
  StorageMigrationRunner,
  bindPluginStorage,
} from "@kanbaner/kernel";
import { createTasksStore } from "../../packages/plugin-tasks/src/store/index.ts";
import { PLUGIN_ID } from "../../packages/plugin-tasks/src/constants.ts";
import { createTasksStoreConformanceSuite } from "../../packages/plugin-tasks/src/testing.ts";
import {
  createCoreInfrastructureMigrations,
  createSqliteStorageProvider,
} from "@kanbaner/storage-sqlite";

const RESOURCE_DELAYS = {
  openMs: 1,
  healthCheckMs: 1,
  operationMs: 1,
  transactionMs: 1,
} as const;

const CLOSE_TIMEOUT_MS = 10_000;

interface TestResources {
  readonly storage: PluginStorage;
  close(): Promise<void>;
}

interface ProviderVariant {
  readonly name: string;
  create(): Promise<TestResources>;
}

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

function temporaryDirectory(backendId: string): string {
  const directory = mkdtempSync(join(tmpdir(), `kanbaner-tasks-${backendId}-`));
  directories.push(directory);

  return directory;
}

function inMemoryVariant(backendId: string, delayed: boolean): ProviderVariant {
  return {
    name: backendId,
    async create() {
      const provider = new InMemoryStorageProvider({
        backendId,
        ...(delayed ? { delays: RESOURCE_DELAYS } : {}),
      });

      await provider.open();
      closers.push(() => provider.close());

      return { storage: bindPluginStorage(provider, PLUGIN_ID), close: () => provider.close() };
    },
  };
}

function sqliteVariant(backendId: string, delayed: boolean): ProviderVariant {
  return {
    name: backendId,
    async create() {
      const dataDirectory = temporaryDirectory(backendId);
      let provider: StorageProvider | null = null;

      try {
        provider = createSqliteStorageProvider({
          backendId,
          dataDirectory,
          ...(delayed ? { delays: RESOURCE_DELAYS } : {}),
        });
        await provider.open();
        await new StorageMigrationRunner(provider).run(createCoreInfrastructureMigrations());
      } catch (error) {
        await provider?.close();
        throw error;
      }

      const opened = provider;
      closers.push(() => opened.close());

      return { storage: bindPluginStorage(opened, PLUGIN_ID), close: () => opened.close() };
    },
  };
}

const variants: readonly ProviderVariant[] = [
  inMemoryVariant("memory-tasks", false),
  inMemoryVariant("memory-tasks-delayed", true),
  sqliteVariant("sqlite-tasks", false),
  sqliteVariant("sqlite-tasks-delayed", true),
];

let fallbackSequence = 0;

function fallbackIdFactory() {
  return {
    nextProjectId(): string {
      fallbackSequence += 1;

      return `fallback-project-${String(fallbackSequence)}`;
    },
    nextTaskId(): string {
      fallbackSequence += 1;

      return `fallback-task-${String(fallbackSequence)}`;
    },
    nextColumnId(): string {
      fallbackSequence += 1;

      return `fallback-column-${String(fallbackSequence)}`;
    },
  };
}

function fixedNow(): string {
  return "2026-01-01T00:00:00.000Z";
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await Promise.race([
      close(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const SUITE_SIZE = 37;

for (const variant of variants) {
  describe(`TasksStore Conformance: ${variant.name}`, () => {
    const suite = createTasksStoreConformanceSuite({
      async createStore() {
        const resources = await variant.create();

        return createTasksStore({
          storage: resources.storage,
          idFactory: fallbackIdFactory(),
          now: fixedNow,
        });
      },
    });

    it(`содержит ${String(SUITE_SIZE)} case`, () => {
      expect(suite).toHaveLength(SUITE_SIZE);
      expect(suite.every((conformanceCase) => conformanceCase.name.length > 0)).toBe(true);
    });

    for (const conformanceCase of suite) {
      it(conformanceCase.name, async () => {
        await conformanceCase.run();
      });
    }
  });
}
